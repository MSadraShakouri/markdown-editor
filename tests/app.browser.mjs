// tests/app.browser.mjs — the whole app in a real browser: login, tree, open a
// file, edit, preview, find & replace, and commit against a stubbed api.github.com.
//
//   npm install puppeteer && npm run serve && npm run test:browser
//
// Ported from the old textarea-based e2e. The editor is now CodeMirror
// (js/editor.mjs), so the document is driven through the test handle
// window.__editor — see the note in js/app.mjs. Everything else still goes
// through real clicks, real key presses and real API interception.
//
// Kept in a browser on purpose: the gutter, wrapping, per-line bidi and the
// highlight decorations are geometry, which jsdom cannot answer.

import { BASE, wait, launchBrowser, requireServer, collector } from './browser-harness.mjs';

await requireServer();
const { check: ok, report } = collector();

const FAKE_SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const FILE_PATH = 'notes/یادداشت.md';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ---- editor helpers ---------------------------------------------------------
// app.mjs exposes the editor as window.__editor when __MDEDITOR_TEST__ is set
// (see the note there). These helpers are the only place that touches it:
//  * doc()      — what the editor currently holds
//  * setDoc()   — replace the text the way a paste would (fires change events)
//  * loadDoc()  — replace it the way opening a file does (no change event)
//  * select()   — set the selection range
const doc = () => page.evaluate(() => window.__editor.getValue());
const setDoc = (text) => page.evaluate((t) => {
  const ed = window.__editor;
  ed.view.dispatch({ changes: { from: 0, to: ed.view.state.doc.length, insert: t } });
}, text);
const loadDoc = (text) => page.evaluate((t) => window.__editor.setValue(t), text);
const select = (from, to = from) => page.evaluate(([f, t]) => {
  window.__editor.focus();
  window.__editor.view.dispatch({ selection: { anchor: f, head: t } });
}, [from, to]);
const moveCaretToEnd = () => page.evaluate(() => {
  const ed = window.__editor;
  ed.focus();
  ed.view.dispatch({ selection: { anchor: ed.view.state.doc.length } });
});
let sampleMd = '';
let putBodies = [];
let remoteSha = FAKE_SHA;
const NEW_SHA = 'NEW_SHA_AFTER_COMMIT';

function fakeGitHub(url, method) {
  const u = new URL(url);
  const p = u.pathname;
  if (p === '/user') return { login: 'octocat', avatar_url: '' };
  if (p === '/user/repos') {
    return [
      { owner: { login: 'octocat' }, name: 'notes', full_name: 'octocat/notes',
        default_branch: 'main', private: true, pushed_at: '2026-09-01T00:00:00Z',
        archived: false, fork: false },
      { owner: { login: 'acme' }, name: 'docs', full_name: 'acme/docs',
        default_branch: 'main', private: false, pushed_at: '2026-08-01T00:00:00Z',
        archived: false, fork: false },
    ];
  }
  if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) {
    return { owner: { login: 'octocat' }, name: 'notes', default_branch: 'main' };
  }
  if (/\/branches$/.test(p)) return [{ name: 'main' }, { name: 'gh-pages' }];
  if (/\/git\/trees\//.test(p)) {
    return {
      sha: 'tree', truncated: false,
      tree: [
        { path: FILE_PATH, type: 'blob', mode: '100644', sha: FAKE_SHA, size: 100 },
        { path: 'notes/دیگری.md', type: 'blob', mode: '100644', sha: 'b', size: 10 },
        { path: 'notes/img/a.png', type: 'blob', mode: '100644', sha: 'c', size: 10 },
        { path: 'README.md', type: 'blob', mode: '100644', sha: 'd', size: 10 },
        { path: 'notes/plain.txt', type: 'blob', mode: '100644', sha: 'i', size: 10 },
        { path: 'sub', type: 'tree', mode: '040000', sha: 'e' },
        { path: 'sub/deep.md', type: 'blob', mode: '100644', sha: 'f', size: 10 },
        { path: 'vendor/lib', type: 'commit', mode: '160000', sha: 'g' },   // submodule
        { path: 'link.md', type: 'blob', mode: '120000', sha: 'h' },        // symlink
      ],
    };
  }
  if (/\/contents\//.test(p)) {
    if (method === 'PUT') { remoteSha = NEW_SHA;   // the real API advances the blob sha
      return { content: { sha: NEW_SHA }, commit: { html_url: 'https://github.com/x/commit/1' } }; }
    return { type: 'file', encoding: 'base64', sha: remoteSha, size: sampleMd.length,
             content: b64(sampleMd) };
  }
  return {};
}

// ------------------------------------------------------------------- launch
const browser = await launchBrowser();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
// App-level suites need the editor handle (see js/app.mjs), set before any of
// the app's scripts run.
await page.evaluateOnNewDocument(() => { globalThis.__MDEDITOR_TEST__ = true; });

const consoleErrors = [], pageErrors = [], dialogs = [];
page.on('dialog', async d => { dialogs.push(d.type() + ': ' + d.message().slice(0, 60)); await d.accept(); });
const mark = (s) => console.log('--- ' + s);
page.on('console', m => {
  const t = m.text();
  // sample.md deliberately contains attack payloads; a blocked <base> or a 404 on
  // a nonexistent sample image is the CORRECT outcome, not a defect.
  if (m.type() !== 'error') return;
  if (/violates the following Content Security Policy/.test(t)) return;
  if (/Failed to load resource: the server responded with a status of 404/.test(t)) return;
  consoleErrors.push(t);
});
page.on('pageerror', e => pageErrors.push(String(e)));

await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  // The Authorization header makes every API call a CORS preflight, so the stub
  // must answer OPTIONS with the matching Access-Control-Allow-* headers.
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Authorization, Accept, X-GitHub-Api-Version, Content-Type',
    'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'access-control-expose-headers': 'x-ratelimit-remaining, x-ratelimit-limit, x-ratelimit-reset, Link',
  };
  if (u.startsWith('https://api.github.com/')) {
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: CORS, body: '' });
    return req.respond({
      status: 200, contentType: 'application/json',
      headers: { ...CORS, 'x-ratelimit-remaining': '4987', 'x-ratelimit-limit': '5000',
                 'x-ratelimit-reset': '4102444800' },
      body: JSON.stringify(fakeGitHub(u, req.method())),
    });
  }
  if (u.startsWith('https://raw.githubusercontent.com/')) {
    return req.respond({ status: 200, contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  }
  if (u.startsWith('https://avatars.githubusercontent.com/')) {
    return req.respond({ status: 404, body: '' });
  }
  req.continue();
});
// capture PUT bodies
page.on('request', (req) => {
  if (req.method() === 'PUT' && req.url().startsWith('https://api.github.com/')) {
    try { putBodies.push({ url: req.url(), body: JSON.parse(req.postData() || '{}') }); } catch {}
  }
});

sampleMd = await (await fetch(BASE + 'sample.md')).text();

mark('boot');
await page.goto(BASE, { waitUntil: 'networkidle0' });

// ------------------------------------------------------------- 1. boot
ok('login view shown when no token is stored', await page.$eval('#login-view', n => !n.hidden));
ok('app view hidden before login', await page.$eval('#app-view', n => n.hidden));
ok('window.marked loaded', await page.evaluate(() => typeof window.marked?.parse === 'function'));
ok('window.markedFootnote loaded', await page.evaluate(() => typeof window.markedFootnote === 'function'));
ok('window.DOMPurify loaded', await page.evaluate(() => typeof window.DOMPurify?.sanitize === 'function'));
ok('Vazirmatn font usable', await page.evaluate(() => document.fonts.check('16px Vazirmatn')));
ok('no console errors on boot', consoleErrors.length === 0, consoleErrors.join(' | '));
ok('no page errors on boot', pageErrors.length === 0, pageErrors.join(' | '));

// ------------------------------------------------------------- 2. login
mark('login');
await page.type('#token-input', 'github_pat_FAKE');
await page.click('#login-btn');
await page.waitForFunction(() => !document.getElementById('app-view').hidden, { timeout: 5000 });
ok('login reveals the app', true);
ok('authenticated login name is shown',
  (await page.$eval('#user-login', n => n.textContent)) === 'octocat',
  await page.$eval('#user-login', n => n.textContent));
await page.waitForFunction(() => document.querySelectorAll('.repo-item').length >= 2, { timeout: 5000 });
ok('repo list rendered', (await page.$$eval('.repo-item', n => n.length)) === 2);
ok('rate-limit meter populated',
  /۴/.test(await page.$eval('#ratelimit', n => n.textContent))
  || /4987/.test(await page.$eval('#ratelimit', n => n.textContent)),
  await page.$eval('#ratelimit', n => n.textContent));

// ------------------------------------------------------- 3. repo + tree
mark('repo+tree');
await page.click('.repo-item');
await page.waitForFunction(() => document.querySelectorAll('.tree-file-btn').length > 0, { timeout: 8000 });

// Root-level files show immediately; folders start collapsed, so expand `notes/`
// before looking for the file inside it.
ok('root-level file is listed without expanding anything',
  (await page.$$eval('.tree-file-btn', ns => ns.map(n => n.textContent))).includes('README.md'));
ok('folders render collapsed with a twisty', (await page.$$eval('.tree-toggle', n => n.length)) >= 1);
await page.evaluate(() => {
  const t = [...document.querySelectorAll('.tree-toggle')]
    .find(b => b.textContent.includes('notes'));
  t.click();
});
await page.waitForFunction((p) =>
  [...document.querySelectorAll('.tree-file-btn')].some(n => n.textContent === p),
  { timeout: 5000 }, FILE_PATH);

const treePaths = await page.$$eval('.tree-file-btn', ns => ns.map(n => n.textContent));
ok('markdown file is listed after expanding its folder', treePaths.includes(FILE_PATH), treePaths.join(' , '));
ok('nested folder (notes/img) is present as a folder',
  (await page.$$eval('.dir-name', ns => ns.map(n => n.textContent))).includes('img'));
// submodules and symlinks are filtered out of the tree entirely (they 404 on open)
const treeHtml = await page.$eval('#file-tree', n => n.textContent);
ok('submodule (mode 160000) is NOT listed', !treeHtml.includes('lib'), treeHtml.slice(0, 200));
ok('symlink (mode 120000) is NOT listed', !treePaths.includes('link.md'), treePaths.join(' , '));
ok('non-markdown files are de-emphasised',
  await page.$$eval('.tree-file.non-md', ns => ns.length >= 1));
ok('branch select filled from the API',
  (await page.$$eval('#branch-select option', ns => ns.map(n => n.value))).join(',') === 'main,gh-pages');

// ---------------------------------------------------------- 4. open file
mark('open file');
await page.evaluate((p) => {
  [...document.querySelectorAll('.tree-file-btn')].find(n => n.textContent === p).click();
}, FILE_PATH);
await page.waitForFunction((p) => document.getElementById('path-label').textContent.includes('یادداشت'),
  { timeout: 5000 }, FILE_PATH);
await wait(400);
ok('file content loaded into the editor',
  (await doc()).startsWith('---'),
  (await doc()).slice(0, 30));
ok('path label shows the Persian path',
  (await page.$eval('#path-label', n => n.textContent)).includes('یادداشت.md'));
ok('render context set (dir) so relative images resolve', true);

// -------------------------------------------------- 5. preview + features
mark('preview');
await page.click('#mode-split');
await page.waitForFunction(() => document.getElementById('preview').innerHTML.length > 500, { timeout: 5000 });
const html = await page.$eval('#preview', n => n.innerHTML);
const text = await page.$eval('#preview', n => n.textContent);
const n = async (sel) => page.$$eval('#preview ' + sel, ns => ns.length);   // awaited at each use

ok('front matter became a collapsed <details> table', (await n('details.front-matter')) === 1);
ok('front matter values rendered inside it', text.includes('سند'));
ok('no raw --- fence leaked into the preview', !html.slice(0, 500).includes('<hr'));
ok('sr-only footnote heading is visually hidden',
  await page.$$eval('#preview .sr-only', ns => ns.length > 0 && ns.every(x => getComputedStyle(x).position === 'absolute')));
ok('h1 rendered', (await n('h1')) === 1, await n('h1'));
ok('tables rendered', (await n('table')) >= 2, await n('table'));
ok('task checkboxes rendered', (await n('input[type=checkbox]')) >= 1, await n('input[type=checkbox]'));
ok('every task checkbox is disabled',
  await page.$$eval('#preview input[type=checkbox]', ns => ns.length > 0 && ns.every(x => x.disabled)));
ok('checked state survived the sanitizer',
  await page.$$eval('#preview input[type=checkbox]', ns => ns.some(x => x.checked)));
ok('footnote ids namespaced with fn-', (await n('[id^="fn-"]')) >= 2, await n('[id^="fn-"]'));
ok('footnote back-links present (prefixId also prefixes the data attr)',
  (await n('[data-fn-backref]')) >= 2, await n('[data-fn-backref]'));
ok('raw <details>/<summary> kept', (await n('details > summary')) >= 1);
ok('relative image rewritten to raw.githubusercontent.com with the Persian dir encoded',
  html.includes('raw.githubusercontent.com/octocat/notes/main/notes/images/diagram.png'),
  (html.match(/<img[^>]*>/) || ['(none)'])[0]);
ok('the rewritten image actually loaded (200 from the stub)',
  await page.$$eval('#preview img', ns => ns.some(i => i.naturalWidth > 0)));

// The bug: a document with footnotes made the PAGE scroll. marked-footnote's
// screen-reader heading is position:absolute, and with no positioned ancestor in
// the preview pane its containing block was the initial containing block, so the
// pane's overflow could not clip it and its static position (the very bottom of
// the rendered document) stretched the page. Preview mode now scrolls the pane
// and nothing else.
const scrollState = await page.evaluate(() => {
  const de = document.documentElement;
  const pane = document.getElementById('preview-pane');
  return {
    footnotes: document.querySelectorAll('#preview .footnotes').length,
    srOnly: document.querySelectorAll('#preview .sr-only').length,
    docOverflow: de.scrollHeight - de.clientHeight,
    pageOverflowX: de.scrollWidth - de.clientWidth,
    paneScrollable: pane.scrollHeight > pane.clientHeight,
  };
});
ok('the fixture really has footnotes', scrollState.footnotes > 0 && scrollState.srOnly > 0,
  JSON.stringify(scrollState));
ok('footnotes do not make the page scroll (the pane scrolls instead)',
  scrollState.docOverflow === 0 && scrollState.pageOverflowX === 0 && scrollState.paneScrollable,
  JSON.stringify(scrollState));

// ------------------------------------------------------------- 6. security
mark('security');
// Scan the built DOM instead of the HTML string: sample.md *talks* about these
// constructs inside code fences (escaped text is expected and harmless), while a
// regex over the string could not tell the two apart. Only live elements and
// attributes matter. The sanitizer's own unit tests live in tests/md.test.mjs;
// this is the end-to-end backstop.
const unsafe = await page.evaluate(() => {
  const BAD_TAGS = ['script', 'style', 'iframe', 'form', 'base', 'svg', 'object', 'embed', 'link', 'meta'];
  const found = [];
  for (const el of document.querySelectorAll('#preview *')) {
    const tag = el.tagName.toLowerCase();
    if (BAD_TAGS.includes(tag)) found.push('<' + tag + '>');
    for (const attr of el.getAttributeNames()) {
      const value = el.getAttribute(attr) || '';
      if (/^on/i.test(attr)) found.push(`${tag}[${attr}]`);            // onerror, ontoggle, …
      else if (attr === 'style') found.push(`${tag}[style]`);
      else if (/(javascript:|data:text\/html)/i.test(value)) found.push(`${tag}[${attr}=${value.slice(0, 30)}]`);
    }
  }
  return [...new Set(found)];
});
ok('the sanitizer left no dangerous element or attribute in the preview',
  unsafe.length === 0, unsafe.join(', '));
ok('a tag written as inline code stayed text, it did not become an element',
  await page.$$eval('#preview code', (ns) => ns.some((n) => n.textContent.includes('<script>'))));
ok('no uncaught page error during render', pageErrors.length === 0, pageErrors.join(' | '));

// --------------------------------------------------------- 7. bidi / RTL
mark('bidi');
const bidi = await page.evaluate(() => {
  const ps = [...document.querySelectorAll('#preview p')];
  const codeP = ps.find(p => p.querySelector('code'));
  const pre = document.querySelector('#preview pre');
  const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
  const main = document.querySelector('.main').getBoundingClientRect();
  return {
    preDir: pre ? getComputedStyle(pre).direction : null,
    preBidi: pre ? getComputedStyle(pre).unicodeBidi : null,
    codeBidi: codeP ? getComputedStyle(codeP.querySelector('code')).unicodeBidi : null,
    bodyFont: getComputedStyle(document.body).fontFamily,
    // per-line direction: each rendered line carries dir="auto" and resolves to
    // its own base direction, which is what <textarea dir="auto"> used to do for
    // the whole control.
    editorLines: [...document.querySelectorAll('.cm-content .cm-line')]
      .map((l) => ({ dir: getComputedStyle(l).direction, text: l.textContent })),
    gutterNumbers: [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
      .filter((e) => /[۰-۹]/.test(e.textContent) && getComputedStyle(e).visibility !== 'hidden')
      .length,
    sidebarRight: sidebar.right > main.right,
  };
});

// Per-line direction is the interesting part now: CodeMirror renders one DOM
// line per logical line and each carries dir="auto", so a Persian line is RTL
// and an English one is LTR *in the same document* — which the old single
// <textarea dir="auto"> could only do for the whole control.
ok('<pre> is direction:ltr', bidi.preDir === 'ltr', bidi.preDir);
ok('<pre> is unicode-bidi:isolate', bidi.preBidi === 'isolate', bidi.preBidi);
ok('inline <code> is unicode-bidi:isolate', bidi.codeBidi === 'isolate', bidi.codeBidi);
ok('body font is Vazirmatn', /Vazirmatn/.test(bidi.bodyFont), bidi.bodyFont);
// «React یک کتابخانه…» is LTR on purpose (Unicode rule P2: the first strong
// character is Latin). Pick a line that genuinely starts with Persian text.
const faLine = bidi.editorLines.find((l) => /^یک خط فارسی/.test(l.text.trim()));
const enLine = bidi.editorLines.find((l) => /^This paragraph is pure English/.test(l.text.trim()));
ok('editor: a Persian line resolves RTL', faLine && faLine.dir === 'rtl', JSON.stringify(faLine));
ok('editor: an English line resolves LTR', enLine && enLine.dir === 'ltr', JSON.stringify(enLine));
ok('editor: every logical line has a gutter number',
  bidi.gutterNumbers === bidi.editorLines.length,
  `${bidi.gutterNumbers} numbers / ${bidi.editorLines.length} lines`);
ok('sidebar sits on the RIGHT in RTL', bidi.sidebarRight);

const align = await page.$$eval('#preview th[align]',
  ns => ns.map(x => x.getAttribute('align') + ':' + getComputedStyle(x).textAlign));
// The preview's own bidi handling (unicode-bidi: plaintext on leaf blocks) is
// covered by tests/md.test.mjs; the browser suite stays on layout and geometry.
ok('align=right -> text-align:right', align.includes('right:right'), align.join(' '));
ok('align=center -> text-align:center', align.includes('center:center'), align.join(' '));

// ----------------------------------------------------- 8. find / replace
mark('find');
await page.click('#find-open');
ok('find bar opens', await page.$eval('#find-bar', n => !n.hidden));
await page.type('#find-input', 'پانویس');
await wait(400);
const findStatus = await page.$eval('#find-status', n => n.textContent);
const anyDigit = /[\d\u06F0-\u06F9\u0660-\u0669]/;
ok('find reports a match count', anyDigit.test(findStatus), findStatus);
ok('find found more than one match', findStatus.includes('از'), findStatus);

await setDoc('alpha beta alpha');
await page.evaluate(() => {
  const f = document.getElementById('find-input');
  f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.type('#find-input', 'alpha');
await wait(350);
await page.type('#replace-input', 'ALPHA');
await page.click('#replace-all');
await wait(300);
ok('replace-all replaced every occurrence', (await doc()) === 'ALPHA beta ALPHA', await doc());
await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
await wait(300);
ok('Ctrl+Z undoes replace-all (the undo history is a real editor history now)',
  (await doc()) === 'alpha beta alpha', await doc());
// The reported bug: a document-wide pointerdown handler closed the bar on any
// click outside it — selecting text in the editor included. Only ✕, Escape and
// the search button may close it.
await page.click('.cm-content');            // a real pointerdown inside the editor
await wait(250);
const afterEditorClick = await page.evaluate(() => ({
  open: !document.getElementById('find-bar').hidden,
  query: document.getElementById('find-input').value,
  marks: document.querySelectorAll('.cm-hl-match').length,
}));
ok('clicking in the editor does not close the find bar', afterEditorClick.open);
ok('the query and its highlights survive that click',
  afterEditorClick.query === 'alpha' && afterEditorClick.marks > 0, JSON.stringify(afterEditorClick));

await page.click('#find-close');
ok('the ✕ button closes the find bar', await page.$eval('#find-bar', n => n.hidden));
ok('closing the find bar clears every match decoration',
  (await page.evaluate(() => document.querySelectorAll('.cm-hl-match').length)) === 0,
  String(await page.evaluate(() => document.querySelectorAll('.cm-hl-match').length)));
ok('closing does not forget the query', 
  (await page.evaluate(() => localStorage.getItem('find_query'))) === 'alpha',
  String(await page.evaluate(() => localStorage.getItem('find_query'))));

// The search button is a toggle now, and the bar comes back with the last query.
await page.click('#find-open');
await wait(300);
const reopened = await page.evaluate(() => ({
  open: !document.getElementById('find-bar').hidden,
  query: document.getElementById('find-input').value,
  status: document.getElementById('find-status').textContent,
  aria: document.getElementById('find-open').getAttribute('aria-expanded'),
}));
ok('reopening the find bar restores the last query and re-runs it',
  reopened.open && reopened.query === 'alpha' && /[\d\u06F0-\u06F9]/.test(reopened.status),
  JSON.stringify(reopened));
ok('the search button says whether the bar is open', reopened.aria === 'true', reopened.aria);

await page.click('#find-open');             // the same button closes it
await wait(300);
ok('pressing search again closes the find bar',
  await page.$eval('#find-bar', n => n.hidden));
ok('the stored query outlives the bar being closed',
  (await page.evaluate(() => localStorage.getItem('find_query'))) === 'alpha');

// Escape stays: it is a deliberate keystroke (the ✕ tooltip names it), not an
// accidental click, so it keeps working.
await page.click('#find-open'); await wait(250);
await page.keyboard.press('Escape'); await wait(250);
ok('Escape still closes the find bar', await page.$eval('#find-bar', n => n.hidden));

// ------------------------------------------------- 9. searching the PREVIEW
// The preview shows different text from the source ("**bold**" is not on screen,
// "bold" is), so it has an engine of its own — and it is the only search there is
// when the editor is hidden.
mark('preview search');
// Its own document: the find section above left the editor holding test text,
// and the preview renders from source — so give it something long enough that
// the pane really scrolls, with the matches spread top to bottom.
await setDoc([
  '# فایل‌های نمونه',
  '',
  'این فایل یک نمونهٔ کوتاه است. فایل دوم کمی پایین‌تر است.',
  '',
  // Each filler line is its own paragraph: consecutive lines without a blank
  // line between them are ONE CommonMark paragraph (soft breaks), which renders
  // as a single block and would give the pane nothing to scroll.
  ...Array.from({ length: 40 }, (_, i) => `خط پرکنندهٔ شمارهٔ ${i + 1} برای بلند شدن سند.\n`),
  '',
  'و این هم آخرین فایل، در پایین سند.',
  '',
].join('\n'));
await wait(700);
await page.click('#mode-preview');
await wait(600);
await page.click('#find-open');        // opened from the header, not Ctrl+F
await wait(300);
const pvOpen = await page.evaluate(() => ({
  open: !document.getElementById('find-bar').hidden,
  replaceHidden: document.getElementById('find-replace-group').hidden,
}));
ok('the find bar opens in preview mode with the replace row hidden',
  pvOpen.open && pvOpen.replaceHidden, JSON.stringify(pvOpen));

await page.type('#find-input', 'فایل');
await wait(600);
const pvHits = await page.evaluate(() => {
  const de = document.documentElement;
  return {
    marks: document.querySelectorAll('#preview mark.pv-hl-match').length,
    current: document.querySelectorAll('#preview mark.pv-hl-current').length,
    status: document.getElementById('find-status').textContent,
    docOverflow: de.scrollHeight - de.clientHeight,
  };
});
ok('matches are wrapped in the rendered preview, one of them current',
  pvHits.marks > 1 && pvHits.current === 1 && /از/.test(pvHits.status), JSON.stringify(pvHits));
ok('searching the preview does not make the page scroll', pvHits.docOverflow === 0,
  String(pvHits.docOverflow));

const statusBefore = await page.evaluate(() => document.getElementById('find-status').textContent);
await page.click('#find-next');
await wait(350);
ok('next advances to the following match',
  (await page.evaluate(() => document.getElementById('find-status').textContent)) !== statusBefore,
  `${statusBefore} → ${await page.evaluate(() => document.getElementById('find-status').textContent)}`);

const paneBefore = await page.evaluate(() => document.getElementById('preview-pane').scrollTop);
// step until the current match is far enough down that the pane has to scroll
for (let i = 0; i < 8; i++) {
  if ((await page.evaluate(() => document.getElementById('preview-pane').scrollTop)) > 0) break;
  await page.click('#find-next');
  await wait(350);
}
const pvStepped = await page.evaluate(() => {
  const pane = document.getElementById('preview-pane');
  const cur = document.querySelector('#preview mark.pv-hl-current');
  const box = cur.getBoundingClientRect();
  return {
    status: document.getElementById('find-status').textContent,
    paneScrolled: pane.scrollTop > 0,
    pageScrolled: document.documentElement.scrollTop + window.scrollY,
    inView: box.top >= 0 && box.bottom <= window.innerHeight,
  };
});
ok('next steps to the following match and scrolls the pane, not the page',
  pvStepped.paneScrolled && pvStepped.inView && pvStepped.pageScrolled === 0 &&
  (await page.evaluate(() => document.getElementById('preview-pane').scrollTop)) !== paneBefore,
  JSON.stringify(pvStepped));

await page.click('#find-close');
await wait(400);
const pvClosed = await page.evaluate(() => ({
  marks: document.querySelectorAll('#preview mark').length,
  stored: localStorage.getItem('find_query'),
  html: document.getElementById('preview').innerHTML.includes('<mark'),
}));
ok('closing the preview search removes every mark it added',
  pvClosed.marks === 0 && !pvClosed.html && pvClosed.stored === 'فایل', JSON.stringify(pvClosed));

// A mode change with the bar open re-aims the search instead of closing the bar:
// the query is the user's, the pane it runs against is ours.
await page.click('#find-open'); await wait(300);
await page.click('#mode-edit'); await wait(600);
const retargeted = await page.evaluate(() => ({
  open: !document.getElementById('find-bar').hidden,
  query: document.getElementById('find-input').value,
  replaceShown: !document.getElementById('find-replace-group').hidden,
  previewMarks: document.querySelectorAll('#preview mark').length,
  editorMarks: document.querySelectorAll('#editor-host .cm-hl-match').length,
}));
ok('switching to edit keeps the bar open and re-aims it at the source',
  retargeted.open && retargeted.query === 'فایل' && retargeted.replaceShown &&
  retargeted.previewMarks === 0 && retargeted.editorMarks > 0, JSON.stringify(retargeted));
await page.keyboard.press('Escape'); await wait(250);

// ---------------------------------------------- 10. settings / formatting bar
mark('settings');
const tbDefault = await page.evaluate(() => ({
  hidden: document.getElementById('editor-toolbar').hidden,
  display: getComputedStyle(document.getElementById('editor-toolbar')).display,
  stored: localStorage.getItem('editor_toolbar'),
}));
ok('the formatting toolbar is hidden by default',
  tbDefault.hidden && tbDefault.display === 'none' && tbDefault.stored === null,
  JSON.stringify(tbDefault));

await page.click('#settings-btn');
await wait(300);
const dlg = await page.evaluate(() => ({
  open: document.getElementById('settings-dialog').open,
  checked: document.getElementById('set-toolbar').checked,
}));
ok('the ⚙ button opens the settings dialog', dlg.open);
ok('its switch shows the stored state (off)', dlg.checked === false);

await page.click('#set-toolbar');
await wait(300);
const tbOn = await page.evaluate(() => ({
  hidden: document.getElementById('editor-toolbar').hidden,
  display: getComputedStyle(document.getElementById('editor-toolbar')).display,
  stored: localStorage.getItem('editor_toolbar'),
  rows: Math.round(document.querySelector('.editor-toolbar').getBoundingClientRect().height),
}));
ok('turning the switch on shows the toolbar and remembers it',
  !tbOn.hidden && tbOn.display !== 'none' && tbOn.stored === '1' && tbOn.rows > 10,
  JSON.stringify(tbOn));

await page.click('#settings-close');
await wait(250);
ok('the dialog closes', await page.$eval('#settings-dialog', n => !n.open));

// ...and it still formats, which is the only reason to have it
await setDoc('سرخط آزمایشی\nخط دوم');
await page.click('.cm-line', { clickCount: 3 });     // select the first line
await wait(200);
await page.click('#editor-toolbar [data-action="h1"]');
await wait(300);
ok('a toolbar button formats the selected line', (await doc()).startsWith('# '), await doc());

// and the switch turns it off again
await page.click('#settings-btn'); await wait(250);
await page.click('#set-toolbar'); await wait(250);
const tbOff = await page.evaluate(() => ({
  hidden: document.getElementById('editor-toolbar').hidden,
  stored: localStorage.getItem('editor_toolbar'),
}));
ok('turning it off hides it again', tbOff.hidden && tbOff.stored === '0', JSON.stringify(tbOff));
// leave it ON: the reload check at the end proves the choice is restored
await page.click('#set-toolbar'); await wait(250);
await page.click('#settings-close'); await wait(250);

// ------------------------------------------------------------ 11. keyboard
mark('keyboard');
const cdp = await page.createCDPSession();
// Puppeteer's press() only accepts known key names, so it cannot send
// "physical KeyB, layout character ذ" — exactly what a Persian layout produces.
const pressCode = async (code, key, modifiers = 0) => {
  const c = { code, key, windowsVirtualKeyCode: 0, modifiers };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: key.length === 1 ? key : undefined, ...c });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...c });
};
async function typeIn(val, caret) {
  await setDoc(val);
  await select(caret);
}

await typeIn('سلام', 4);
await select(0, 4);
await pressCode('KeyB', 'ذ', 2);   // 2 = Ctrl
await wait(250);
ok('Ctrl+B works when e.key is a Persian character (e.code path)',
  (await doc()).includes('**'), await doc());

for (const [label, before, caret, after] of [
  ['Enter continues an unordered list', '- item', 6, '- item\n- '],
  ['Enter increments an ordered list', '1. one', 6, '1. one\n2. '],
  ['Enter continues a task list unchecked', '- [ ] task', 10, '- [ ] task\n- [ ] '],
]) {
  await typeIn(before, caret);
  await page.keyboard.press('Enter');
  await wait(250);
  ok(label, (await doc()) === after, JSON.stringify(await doc()));
}

await typeIn('x', 1);
await page.keyboard.press('Tab');
await wait(250);
ok('Tab inserts two spaces instead of leaving the editor',
  (await doc()) === 'x  ', JSON.stringify(await doc()));

// -------------------------------------------------------------- 12. save
mark('save');
await setDoc('# عنوان تازه\n\nمتن فارسی ۱۲۳\n');
await wait(200);
ok('dirty indicator appears', await page.$eval('#dirty-dot', x => !x.hidden));
ok('commit button enabled when dirty', await page.$eval('#commit-btn', x => !x.disabled));
await page.click('#commit-btn');
await page.waitForFunction(() => document.getElementById('commit-dialog').open, { timeout: 5000 });
ok('commit dialog opens with a prefilled message',
  (await page.$eval('#commit-message', x => x.value)).length > 0,
  await page.$eval('#commit-message', x => x.value));
await page.evaluate(() => {
  const f = document.getElementById('commit-form');
  f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
});
await wait(900);
ok('PUT was sent to the API', putBodies.length === 1, JSON.stringify(putBodies.map(b => b.url)));
ok('PUT carried the current sha', putBodies[0]?.body?.sha === FAKE_SHA, putBodies[0]?.body?.sha);
ok('PUT content is valid base64 of the Persian text',
  putBodies[0] && Buffer.from(putBodies[0].body.content, 'base64').toString('utf8')
    === '# عنوان تازه\n\nمتن فارسی ۱۲۳\n',
  putBodies[0] && Buffer.from(putBodies[0].body.content, 'base64').toString('utf8'));
ok('PUT targeted the percent-encoded Persian path',
  putBodies[0]?.url.includes(encodeURIComponent('یادداشت.md')) && !putBodies[0]?.url.includes('%2F'),
  putBodies[0]?.url);
ok('dirty indicator cleared after a successful commit', await page.$eval('#dirty-dot', x => x.hidden));
ok('success toast shown', await page.$eval('#toast', x => x.className.includes('show')));

// the sha MUST have been refreshed from the response, or the next save 422s
putBodies = [];
await page.evaluate(() => {
  const ed = window.__editor;
  ed.view.dispatch({ changes: { from: ed.view.state.doc.length, insert: 'ویرایش دوم\n' } });
});
await wait(200);
await page.click('#commit-btn');
await page.waitForFunction(() => document.getElementById('commit-dialog').open, { timeout: 5000 });
await page.evaluate(() => document.getElementById('commit-form')
  .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
await wait(900);
ok('second save uses the NEW sha from the previous response (the 422 bug)',
  putBodies[0]?.body?.sha === NEW_SHA, putBodies[0]?.body?.sha);
ok('no spurious conflict dialog across two saves', dialogs.length === 0, dialogs.join(' | '));

// ------------------------------------------------------------- 13. modes
mark('modes');
await page.click('#mode-preview');
await wait(250);
// The regression that shipped in the textarea era: [hidden] and
// .editor-pane { display: flex } are both !important and equal-specificity, so
// the later rule won and preview rendered the editor *and* the preview stacked.
const paneGone = await page.evaluate(() => {
  const pane = document.getElementById('editor-pane');
  return { hidden: pane.hidden, display: getComputedStyle(pane).display };
});
ok('preview mode hides the editor pane (computed display, not just the attribute)',
  paneGone.hidden === true && paneGone.display === 'none', JSON.stringify(paneGone));
ok('preview pane starts at the top of the content area',
  (await page.evaluate(() => Math.round(document.getElementById('preview-pane').getBoundingClientRect().top))) < 120);
ok('preview mode shows the preview pane', await page.$eval('#preview-pane', x => !x.hidden));
ok('aria-pressed tracks the active mode',
  await page.$eval('#mode-preview', x => x.getAttribute('aria-pressed') === 'true'));
await page.click('#mode-edit');
await wait(250);
ok('edit mode hides the preview pane', await page.$eval('#preview-pane', x => x.hidden));

// ------------------------------------------------------- 14. final state
ok('no page errors overall', pageErrors.length === 0, pageErrors.join(' | '));
ok('no console errors overall', consoleErrors.length === 0, consoleErrors.join(' | '));

// ------------------------------------------------- 15. wrap + mobile shell
mark('wrap + mobile');
await page.evaluate(() => { document.getElementById('mode-edit').click(); });
await wait(300);

await page.click('#settings-btn'); await wait(300);
const wrapState = await page.evaluate(() => ({
  switchOn: document.getElementById('set-wrap').checked,
  numbersOn: document.getElementById('set-linenums').checked,
  wrapButtonGone: !document.getElementById('btn-wrap'),
  wrappingClass: document.querySelector('.cm-content').classList.contains('cm-lineWrapping'),
  scrollW: document.querySelector('.cm-scroller').scrollWidth,
  clientW: document.querySelector('.cm-scroller').clientWidth,
  gutterW: Math.round(document.querySelector('.cm-gutters').getBoundingClientRect().width),
}));
ok('soft wrap is on by default (settings switch, no header button)',
  wrapState.switchOn && wrapState.wrappingClass && wrapState.wrapButtonGone, JSON.stringify(wrapState));
ok('line numbers are on by default too', wrapState.numbersOn === true);
ok('nothing scrolls sideways with wrap on', wrapState.scrollW <= wrapState.clientW + 1,
  `${wrapState.scrollW}/${wrapState.clientW}`);
ok('line-number gutter is content-sized, not a fixed 52px', wrapState.gutterW <= 42, String(wrapState.gutterW));

await setDoc(('یک خط بسیار طولانی که باید از عرض ستون بیشتر شود تا شکستن خط معنی پیدا کند و همین‌طور ادامه پیدا کند. '.repeat(3) + '\n').repeat(12));
await page.click('#set-wrap');
await wait(400);
const noWrapState = await page.evaluate(() => ({
  pressed: document.getElementById('set-wrap').checked ? 'true' : 'false',
  stored: localStorage.getItem('editor_wrap'),
  wrappingClass: document.querySelector('.cm-content').classList.contains('cm-lineWrapping'),
  scrollW: document.querySelector('.cm-scroller').scrollWidth,
  clientW: document.querySelector('.cm-scroller').clientWidth,
  gutterNumbers: [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
    .filter((e) => /[۰-۹]/.test(e.textContent) && getComputedStyle(e).visibility !== 'hidden').length,
}));
ok('toggling wrap off removes the wrapping class and persists the choice',
  noWrapState.pressed === 'false' && noWrapState.stored === '0' && !noWrapState.wrappingClass,
  JSON.stringify(noWrapState));
ok('wrap off restores horizontal scrolling for that long line',
  noWrapState.scrollW > noWrapState.clientW, `${noWrapState.scrollW}/${noWrapState.clientW}`);
const docLines = await page.evaluate(() => window.__editor.lineCount());
ok('one gutter number per logical line, wrapped rows do not add numbers',
  noWrapState.gutterNumbers === docLines, `${noWrapState.gutterNumbers} numbers / ${docLines} lines`);

await page.click('#set-wrap');            // wrap back on
await wait(300);

// the line-number switch, from the same dialog
await page.click('#set-linenums');
await wait(400);
const noNums = await page.evaluate(() => ({
  gutters: document.querySelectorAll('#editor-host .cm-lineNumbers').length,
  stored: localStorage.getItem('editor_line_numbers'),
  codeStillThere: !!document.querySelector('#editor-host .cm-content')?.textContent.trim(),
}));
ok('turning line numbers off removes the gutter and keeps the text',
  noNums.gutters === 0 && noNums.stored === '0' && noNums.codeStillThere, JSON.stringify(noNums));
await page.click('#set-linenums');
await wait(400);
ok('turning them back on restores the gutter',
  (await page.evaluate(() => document.querySelectorAll('#editor-host .cm-lineNumbers').length)) === 1);
await page.click('#settings-close');
await wait(250);

// the old overlay drifted when the editor scrolled; decorations cannot
// Long wrapped filler with the searched token appearing exactly once, at the
// very start of the first line: it is far from any viewport edge, and there is
// no second mark with the same x to confuse the comparison with.
await setDoc(Array.from({ length: 20 }, (_, i) => (i === 0
  ? 'NEEDLE '
  : `خط ${i}: `) + 'واژه‌های پرکننده برای شکستن خط و سنجش جابه‌جایی نشانه‌ها. '.repeat(3)).join('\n'));
await wait(500);
await page.click('#find-open');
await page.type('#find-input', 'NEEDLE');
await wait(400);
const drift = await page.evaluate(() => {
  const scroller = document.querySelector('.cm-scroller');
  const marks = () => [...document.querySelectorAll('.cm-hl-match')]
    .map((m) => ({ left: Math.round(m.getBoundingClientRect().left), top: Math.round(m.getBoundingClientRect().top) }));
  scroller.scrollTop = 0;
  const before = marks();
  const followed = before[before.length - 1];
  if (!followed) return { note: 'no matches' };
  const scrolledFrom = scroller.scrollTop;
  scroller.scrollTop += 100;
  // two frames: one for the scroll, one for anything the editor schedules in
  // response to it. Measuring in the same frame as the scroll reads stale tops.
  return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const after = marks().find((m) => m.left === followed.left);
    res({
      scrollMoved: scroller.scrollTop - scrolledFrom,
      delta: after ? after.top - followed.top : null,
      before: followed.top, after: after ? after.top : null,
    });
  })));
});
ok('the scroll actually happened', drift.scrollMoved > 0, JSON.stringify(drift));
ok('search highlights move by exactly the scroll delta (no overlay drift)',
  drift.delta !== null && Math.abs(drift.delta + drift.scrollMoved) <= 2, JSON.stringify(drift));
await page.keyboard.press('Escape');
await wait(200);

await page.screenshot({ path: new URL('shot-desktop.png', import.meta.url).pathname });

await page.setViewport({ width: 390, height: 780 });
await wait(700);
const mobile = await page.evaluate(() => {
  const host = document.getElementById('editor-host');
  const scroller = host.querySelector('.cm-scroller');
  return {
    topbarH: Math.round(document.getElementById('topbar').getBoundingClientRect().height),
    findMoved: document.getElementById('find-open').closest('#menu-slot') !== null,
    noWrapButton: !document.getElementById('btn-wrap'),
    settingsMoved: document.getElementById('settings-btn').closest('#menu-slot') !== null,
    modeInHeader: document.getElementById('mode-split').closest('#topbar') !== null,
    sidebarClosed: document.body.classList.contains('sidebar-collapsed'),
    editorScrollW: scroller.scrollWidth,
    editorClientW: scroller.clientWidth,
    gutterW: Math.round(host.querySelector('.cm-gutters').getBoundingClientRect().width),
    pageScrollW: document.documentElement.scrollWidth,
    pageClientW: document.documentElement.clientWidth,
  };
});
ok('mobile header is two compact rows', mobile.topbarH <= 100, String(mobile.topbarH));
ok('secondary controls are inside the ⋯ menu on mobile, the mode switch stays put',
  mobile.findMoved && mobile.noWrapButton && mobile.settingsMoved && mobile.modeInHeader,
  JSON.stringify(mobile));
ok('the editor wraps on a 390px phone: no side scrolling',
  mobile.editorScrollW <= mobile.editorClientW + 1, `${mobile.editorScrollW}/${mobile.editorClientW}`);
ok('the page itself never scrolls sideways on mobile',
  mobile.pageScrollW <= mobile.pageClientW + 1, `${mobile.pageScrollW}/${mobile.pageClientW}`);
ok('gutter shrinks on mobile', mobile.gutterW <= 34, String(mobile.gutterW));

// On a phone the settings entry lives in the ⋯ menu, so the menu has to close
// and the dialog has to open — in that order, from one tap.
await page.click('#more-btn');
await wait(400);
await page.click('#settings-btn');
await wait(400);
const fromMenu = await page.evaluate(() => ({
  settings: document.getElementById('settings-dialog').open,
  menu: document.getElementById('more-dialog').open,
}));
ok('the ⋯ menu closes and settings opens from one tap on mobile',
  fromMenu.settings && !fromMenu.menu, JSON.stringify(fromMenu));
await page.click('#settings-close');
await wait(250);
await page.screenshot({ path: new URL('shot-mobile.png', import.meta.url).pathname });

// Drafts are per file, and only for the file that was actually edited.
const drafts = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('draft:')));
ok('exactly one draft exists, keyed to the edited file',
  drafts.length === 1 && drafts[0].includes('یادداشت'), drafts.join(','));

// ------------------------------------------------- 16. sidebar width ratio
// The reported problem was a fixed 320px sidebar: 31% of a 1024px window spent
// on file names. It is a share of the viewport now, so the ratio is what gets
// asserted — not a pixel count that would drift with the clamp bounds.
mark('sidebar width');
const sidebarAt = [];
for (const width of [1440, 1280, 1024, 900]) {
  await page.setViewport({ width, height: 900 });
  await wait(450);
  sidebarAt.push(await page.evaluate((vw) => {
    const box = document.getElementById('app-sidebar').getBoundingClientRect();
    const tree = document.getElementById('file-tree');
    return {
      vw,
      px: Math.round(box.width),
      pct: Math.round((box.width / vw) * 1000) / 10,
      treeW: tree ? Math.round(tree.clientWidth) : 0,
      // nothing may be pushed off the page by the grid column
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, width));
}
const pctAt = (vw) => sidebarAt.find((r) => r.vw === vw);

ok('at 1024px the sidebar is 25% of the window, not 31%',
  Math.abs(pctAt(1024).pct - 25) < 0.6, JSON.stringify(pctAt(1024)));
ok('the share holds as the window grows (25%, not a fixed width)',
  Math.abs(pctAt(1280).pct - 25) < 0.6 && Math.abs(pctAt(1440).pct - 25) < 0.6,
  JSON.stringify([pctAt(1280), pctAt(1440)]));
ok('a narrow desktop window keeps the floor, not 25% of almost nothing',
  pctAt(900).px >= 240 && pctAt(900).pct <= 27, JSON.stringify(pctAt(900)));
ok('the file tree still has room for a filename at every width',
  sidebarAt.every((r) => r.treeW > 180), JSON.stringify(sidebarAt.map((r) => r.treeW)));
ok('and the narrower column never pushes the page sideways',
  sidebarAt.every((r) => r.pageOverflow === 0), JSON.stringify(sidebarAt.map((r) => r.pageOverflow)));

// ------------------------------------------- 17. a reload keeps the settings
// The only honest proof that a preference is remembered: throw the page away.
// window.__editor exists from boot (the editor is wired before login), and the
// test handle is re-installed by evaluateOnNewDocument, so this needs no session.
mark('reload');
await page.setViewport({ width: 1440, height: 900 });
await page.click('#find-open'); await wait(300);
await page.type('#find-input', 'واژهٔ ماندگار');
await wait(400);
await page.click('#find-close'); await wait(200);

const beforeReload = await page.evaluate(() => ({
  toolbar: localStorage.getItem('editor_toolbar'),
  query: localStorage.getItem('find_query'),
}));
ok('both choices are in localStorage before the reload',
  beforeReload.toolbar === '1' && beforeReload.query === 'واژهٔ ماندگار',
  JSON.stringify(beforeReload));

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__editor);
await wait(500);
const afterReload = await page.evaluate(() => {
  // open the find bar through its own handler: the header may be inside a view
  // that is hidden until login, and a click on a hidden node cannot happen.
  document.getElementById('find-open').click();
  return {
    toolbarHidden: document.getElementById('editor-toolbar').hidden,
    findBarOpen: !document.getElementById('find-bar').hidden,
    query: document.getElementById('find-input').value,
  };
});
ok('the toolbar is still on after a reload', afterReload.toolbarHidden === false);
ok('the find bar reopens with the remembered query',
  afterReload.findBarOpen && afterReload.query === 'واژهٔ ماندگار',
  JSON.stringify(afterReload));

mark('end');
await page.evaluate(() => { document.getElementById('mode-split').click(); });
await wait(900);
await page.screenshot({ path: new URL('shot-split.png', import.meta.url).pathname });
await browser.close();

const bad = report('app checks');
if (dialogs.length) console.log('native dialogs seen: ' + dialogs.join(' | '));
process.exit(bad ? 1 : 0);


