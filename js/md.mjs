// js/md.mjs — Markdown rendering pipeline.
//
// marked@15 (UMD, window.marked) + marked-footnote@1.4 (window.markedFootnote)
// + DOMPurify@3 (window.DOMPurify), all vendored, all loaded as classic scripts
// in index.html BEFORE this module. Total 70 KB raw / 25 KB gz.
//
// Pipeline: markdown -> marked -> HTML -> relative-image rewrite -> DOMPurify -> DOM.
// Sanitize AFTER rendering, exactly once.

const { marked, markedFootnote, DOMPurify } = globalThis;

// ------------------------------------------------------------------ sanitizer
// Explicit allowlist. DOMPurify's default profile does allow <details>,
// <summary>, <picture> and <source>, and it does strip onerror/javascript:/
// <script> — but it ALSO lets a bare style="" attribute through, which is a
// credential-phishing overlay one `style="position:fixed;inset:0"` away, and it
// permits <form>. So: allowlist, and no 'style'.
//
// marked emits table alignment as an `align` ATTRIBUTE (<th align="right">),
// not inline style, so banning style costs nothing here. `align`, `disabled`
// and `checked` must all be present or tables/checkboxes break silently.
const ALLOWED_TAGS = [
  'h1','h2','h3','h4','h5','h6','p','br','hr','blockquote','pre','code',
  'ul','ol','li','dl','dt','dd','em','strong','del','s','sub','sup',
  'a','img','picture','source','figure','figcaption',
  'table','thead','tbody','tfoot','tr','th','td','caption','colgroup','col',
  'details','summary','kbd','mark','abbr','span','div','section',
  'input','bdi','bdo'
];

const ALLOWED_ATTR = [
  'href','src','srcset','sizes','alt','title','type','media','open','align',
  'colspan','rowspan','dir','id','class','start','reversed','loading',
  'width','height','disabled','checked',
  // aria-* for footnote accessibility (marked-footnote emits aria-describedby /
  // aria-label). ALLOW_ARIA_ATTR defaults to true; listed here for clarity.
  'role'
];

const SANITIZE_OPTS = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  FORBID_TAGS: ['style','form','svg','math','iframe','script','object','embed',
                'link','meta','base','frame','frameset','applet'],
  FORBID_ATTR: ['style','srcdoc','formaction','onerror','onload','ontoggle'],
  // data-* attributes cannot execute anything, and marked-footnote uses
  // data-footnote-ref / data-footnote-backref as stable hooks. Keep them.
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
  ADD_ATTR: [],
  WHOLE_DOCUMENT: false,
  RETURN_DOM: false
};

// ------------------------------------------------------------------- marked
marked.use({
  gfm: true,        // tables, strikethrough, task lists, bare-URL autolinks
  breaks: false,    // single newline is NOT <br> (CommonMark). Flip if you prefer.
  pedantic: false,
});

marked.use(markedFootnote({
  // Namespaced so a document cannot collide with the app's own element IDs.
  prefixId: 'fn-',
  description: 'پانویس‌ها',          // screen-reader heading, Persian
  backRefLabel: 'بازگشت به ارجاع {0}',
  footnoteDivider: true,
  refMarkers: true,                  // render the marker as [1] like github.com
}));

// Relative image sources -> raw.githubusercontent.com, so a note that says
// ![](images/diagram.png) actually renders. Relative *links* are left alone.
// `ctx` is set by setRenderContext() before each render.
let ctx = { owner: null, repo: null, ref: null, dir: '' };
export function setRenderContext(next) { ctx = { ...ctx, ...next }; }

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;
const DATA_IMG = /^data:image\//i;

function resolveImageSrc(src) {
  if (!src || ABSOLUTE.test(src) || DATA_IMG.test(src)) return src;
  const { owner, repo, ref, dir } = ctx;
  if (!owner || !repo || !ref) return src;             // no repo context: leave it
  const clean = src.replace(/^\.\//, '');
  const base = dir ? dir.replace(/\/+$/, '') + '/' : '';
  // normalise ../ segments crudely — good enough for image paths
  const joined = (base + clean).split('/').reduce((acc, seg) => {
    if (seg === '.' || seg === '') return acc;
    if (seg === '..') { acc.pop(); return acc; }
    acc.push(seg);
    return acc;
  }, []);
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${
    joined.map(encodeURIComponent).join('/')
  }`;
}

marked.use({
  renderer: {
    image(token) {
      const src = resolveImageSrc(token.href || '');
      const alt = token.text ? escapeHtml(token.text) : '';
      const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
      return `<img src="${escapeAttr(src)}" alt="${alt}"${title} loading="lazy">`;
    },
  },
});

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const escapeAttr = escapeHtml;

// ------------------------------------------------------------ YAML front matter
// marked has no front-matter support: a `---`-fenced YAML block renders as a
// stray <hr> plus a paragraph of `key: value` text. Split it off and render it
// as a collapsed table instead.
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontMatter(src) {
  const m = FRONT_MATTER.exec(String(src ?? ''));
  if (!m) return { yaml: null, body: String(src ?? '') };
  return { yaml: m[1], body: String(src ?? '').slice(m[0].length) };
}

function renderFrontMatter(yaml) {
  const rows = [];
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!key) continue;
    rows.push(`<tr><th>${escapeHtml(key)}</th><td dir="auto">${escapeHtml(val)}</td></tr>`);
  }
  if (!rows.length) return '';
  return `<details class="front-matter"><summary>اطلاعات سند</summary>`
       + `<table class="front-matter-table">${rows.join('')}</table></details>`;
}

// -------------------------------------------------------------------- render
/**
 * @param {string} src raw markdown from the editor
 * @returns {string} HTML safe for innerHTML
 */
export function renderMarkdown(src) {
  const { yaml, body } = splitFrontMatter(src);
  let html;
  try {
    html = marked.parse(body);
  } catch (err) {
    // Never let a parse error blank the preview.
    html = `<pre class="render-error">${escapeHtml(String(err && err.message || err))}</pre>`;
  }
  const fm = yaml == null ? '' : renderFrontMatter(yaml);
  return DOMPurify.sanitize(fm + html, SANITIZE_OPTS);
}

export { DOMPurify, SANITIZE_OPTS, resolveImageSrc };


