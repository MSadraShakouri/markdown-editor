/**
 * md.js — Markdown -> safe DOM.
 *
 * Pipeline:  front matter strip -> marked (+footnotes) -> DOMPurify (explicit
 * allowlist) -> DOM post-processing (bidi, image URLs, link targets).
 *
 * Nothing here ever assigns to innerHTML with un-sanitised input: the string
 * is sanitised first, then parsed, then inserted as nodes.
 */

import { marked } from '../vendor/marked.esm.js';
import footnote from '../vendor/marked-footnote.js';

/* footerless GFM + GitHub-style footnotes (footnotes are NOT part of GFM,
   which is exactly why marked needs the extension) */
marked.use(footnote(), { gfm: true, breaks: false, pedantic: false, async: false });

/* --------------------------------------------------------- sanitize rules */

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'span', 'div', 'section', 'article', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'small', 'mark', 'abbr',
  'a', 'img', 'picture', 'source', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'details', 'summary', 'input',
];

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'id', 'class', 'lang', 'dir',
  'align', 'colspan', 'rowspan', 'start', 'type', 'value',
  'checked', 'disabled', 'open', 'loading', 'width', 'height',
  'target', 'rel', 'srcset', 'sizes', 'media',
];

const SANITIZE = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  // Explicit deny list as a second line of defence. `style` must stay out:
  // a fixed-position style attribute is a phishing kit. `form` likewise.
  FORBID_TAGS: ['style', 'form', 'iframe', 'svg', 'math', 'script', 'object',
    'embed', 'link', 'meta', 'base', 'noscript', 'template', 'textarea', 'button'],
  FORBID_ATTR: ['style', 'formaction', 'xlink:href'],
  FORBID_CONTENTS: ['script', 'style', 'iframe', 'svg', 'math', 'template',
    'noscript', 'object', 'embed'],
  ALLOW_DATA_ATTR: true,   // marked-footnote emits data-footnote-* hooks
  ALLOW_ARIA_ATTR: true,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  // KEEP_CONTENT must stay TRUE: with an explicit ALLOWED_TAGS allowlist,
  // setting it false makes DOMPurify 3.x drop every text node in the document.
  // FORBID_CONTENTS below is what deletes the text of <script>/<style>/etc.
  KEEP_CONTENT: true,
  SANITIZE_DOM: true,      // defend against DOM clobbering
  SAFE_FOR_TEMPLATES: false,
};

/* ------------------------------------------------------------ front matter */

const FRONT_MATTER = /^[\s\uFEFF]*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontMatter(src) {
  const m = FRONT_MATTER.exec(src);
  if (!m) return { body: src, front: null };
  return { body: src.slice(m[0].length), front: m[1] };
}

/* ------------------------------------------------------------- bidi / urls */

/* Blocks that should resolve their own direction per paragraph. */
const AUTO_DIR = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'BLOCKQUOTE', 'TD', 'TH', 'DT', 'DD',
  'FIGCAPTION', 'SUMMARY', 'CAPTION', 'DIV', 'SECTION',
]);

/* Code is always LTR and isolated, so it cannot reorder the Persian around it. */
const LTR = new Set(['PRE', 'CODE', 'KBD', 'SAMP']);

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i;

function rawBase(ctx) {
  if (!ctx || !ctx.owner) return null;
  const seg = (s) => String(s).split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${seg(ctx.owner)}/${seg(ctx.repo)}/${seg(ctx.branch)}/${seg(ctx.dir || '')}/`;
}

function resolveUrl(url, base) {
  if (!url || !base || ABSOLUTE.test(url)) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function decorate(root, ctx) {
  const base = rawBase(ctx);
  const walk = (node) => {
    for (const el of Array.from(node.children)) {
      if (LTR.has(el.tagName)) {
        if (!el.hasAttribute('dir')) el.setAttribute('dir', 'ltr');
      } else if (AUTO_DIR.has(el.tagName) && !el.hasAttribute('dir')) {
        el.setAttribute('dir', 'auto');
      }

      if (el.tagName === 'IMG' && el.getAttribute('src')) {
        el.setAttribute('src', resolveUrl(el.getAttribute('src'), base));
        el.setAttribute('loading', 'lazy');
      }
      if (el.tagName === 'SOURCE' && el.getAttribute('srcset')) {
        el.setAttribute('srcset', resolveUrl(el.getAttribute('srcset'), base));
      }
      if (el.tagName === 'A' && /^https?:/i.test(el.getAttribute('href') || '')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      walk(el);
    }
  };
  walk(root);
}

/* ----------------------------------------------------------------- render */

/**
 * @param {string} src  raw markdown (as typed in the editor)
 * @param {object} ctx  { owner, repo, branch, dir } — used for relative images
 * @returns {{ nodes: Node[], front: string|null }}
 */
export function render(src, ctx = {}) {
  const { body, front } = splitFrontMatter(src || '');
  const dirty = marked.parse(body);
  const clean = window.DOMPurify.sanitize(dirty, SANITIZE);

  const doc = new DOMParser().parseFromString(`<div id="md-root">${clean}</div>`, 'text/html');
  const root = doc.getElementById('md-root');
  decorate(root, ctx);
  return { nodes: Array.from(root.childNodes), front };
}

/** Insert nodes into a container, adopting them into the app document. */
export function mount(container, nodes) {
  container.replaceChildren(...nodes.map((n) => document.importNode(n, true)));
}
