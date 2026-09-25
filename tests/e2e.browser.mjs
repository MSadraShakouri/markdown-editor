// e2e.browser.mjs — OPTIONAL headless-Chrome verification (needs puppeteer,
// not installed by default because it downloads a ~150 MB Chrome).
//
//   npm i -D puppeteer
//   npm run serve                 # static server on :8080, no build step
//   node tests/e2e.browser.mjs
//
// It drives the REAL flow (login -> repo list -> tree -> open file -> edit ->
// preview -> commit) against a stubbed api.github.com, so no token and no
// network are needed. Not part of `npm test` (which is jsdom-only): this file
// needs puppeteer plus a server. Run at a desktop viewport (1440x900) — the
// mobile layout is a different code path (see the 860px media query).
import puppeteer from 'puppeteer';

const BASE = 'http://127.0.0.1:8080/';
const results = [];
const ok = (name, cond, detail = '') => results.push([!!cond, name, String(detail ?? '')]);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- fixtures
const FAKE_SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const FILE_PATH = 'notes/یادداشت.md';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
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
const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'],
  protocolTimeout: 20000 });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

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
ok('file content loaded into the textarea',
  (await page.$eval('#editor', n => n.value)).startsWith('---'),
  (await page.$eval('#editor', n => n.value)).slice(0, 30));
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
ok('task checkboxes rendered', (await n('input[type=checkbox]')) >= 5, await n('input[type=checkbox]'));
ok('every task checkbox is disabled',
  await page.$$eval('#preview input[type=checkbox]', ns => ns.length > 0 && ns.every(x => x.disabled)));
ok('checked state survived the sanitizer',
  await page.$$eval('#preview input[type=checkbox]', ns => ns.some(x => x.checked)));
ok('strikethrough -> <del>', (await n('del')) >= 1);
ok('footnote ids namespaced with fn-', (await n('[id^="fn-"]')) >= 2, await n('[id^="fn-"]'));
ok('duplicate footnote ref appears twice', (await n('sup > a[href="#fn-note-1"]')) === 2,
  await n('sup > a[href="#fn-note-1"]'));
ok('footnote back-links present (prefixId also prefixes the data attr)',
  (await n('[data-fn-backref]')) >= 2, await n('[data-fn-backref]'));
ok('raw <details>/<summary> kept', (await n('details > summary')) >= 1);
ok('<picture>/<source> kept', (await n('picture > source')) >= 1);
ok('<kbd> kept', (await n('kbd')) >= 1);
ok('collapsed reference link resolved', html.includes('href="/collapsed"'));
ok('bare URL autolinked', html.includes('href="https://example.com/x"'));
ok('relative image rewritten to raw.githubusercontent.com with the Persian dir encoded',
  html.includes('raw.githubusercontent.com/octocat/notes/main/notes/images/diagram.png'),
  (html.match(/<img[^>]*>/) || ['(none)'])[0]);
ok('the rewritten image actually loaded (200 from the stub)',
  await page.$$eval('#preview img', ns => ns.some(i => i.naturalWidth > 0)));

// ------------------------------------------------------------- 6. security
mark('security');
for (const [label, re] of [
  ['<script>', /<script/i], ['onerror', /onerror/i], ['javascript: URL', /javascript:/i],
  ['<style>', /<style/i], ['<form>', /<form/i], ['<iframe>', /<iframe/i],
  ['<base>', /<base/i], ['<svg>', /<svg/i], ['data:text/html', /data:text\/html/i],
  ['any style attribute', /\sstyle=/i], ['any inline event handler', /\son\w+\s*=/i],
  // the literal word "ontoggle" appears in sample.md as visible text; what
  // matters is that no ontoggle ATTRIBUTE survives.
  ['ontoggle attribute', /<details[^>]*\sontoggle/i],
]) {
  ok('XSS blocked: ' + label, !re.test(html), (html.match(re) || [''])[0]);
}
ok('no uncaught page error during render', pageErrors.length === 0, pageErrors.join(' | '));

// --------------------------------------------------------- 7. bidi / RTL
mark('bidi');
const bidi = await page.evaluate(() => {
  const ps = [...document.querySelectorAll('#preview p')];
  const find = (needle) => ps.find(p => p.textContent.includes(needle));
  const wordX = (p, needle) => {
    const node = [...p.childNodes].find(x => x.nodeType === 3 && x.textContent.includes(needle));
    if (!node) return null;
    const off = node.textContent.indexOf(needle);
    const r = document.createRange();
    r.setStart(node, off); r.setEnd(node, off + needle.length);
    return Math.round(r.getBoundingClientRect().left);
  };
  const mixed = find('React یک کتابخانه');
  const english = find('This paragraph is pure English');
  const codeP = ps.find(p => p.querySelector('code'));
  const pre = document.querySelector('#preview pre');
  const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
  const main = document.querySelector('.main').getBoundingClientRect();
  return {
    mixedFirst: mixed ? wordX(mixed, 'React') : null,
    mixedLast: mixed ? wordX(mixed, 'است') : null,
    engFirst: english ? wordX(english, 'This') : null,
    engLast: english ? wordX(english, 'left.') : null,
    preDir: pre ? getComputedStyle(pre).direction : null,
    preBidi: pre ? getComputedStyle(pre).unicodeBidi : null,
    codeBidi: codeP ? getComputedStyle(codeP.querySelector('code')).unicodeBidi : null,
    bodyFont: getComputedStyle(document.body).fontFamily,
    editorBidi: getComputedStyle(document.getElementById('editor')).unicodeBidi,
    sidebarRight: sidebar.right > main.right,
  };
});

// unicode-bidi: plaintext changes the USED base direction of each bidi paragraph,
// not the computed `direction` property (which still reads rtl from <html>).
// So assert on laid-out coordinates, which is the thing users actually see.
ok('pure-English para lays out LTR (plaintext reached the leaf block)',
  bidi.engFirst < bidi.engLast, `This@${bidi.engFirst} vs left.@${bidi.engLast}`);
ok('a Persian para that STARTS with a Latin word lays out LTR (UBA rule P2)',
  bidi.mixedFirst < bidi.mixedLast, `React@${bidi.mixedFirst} vs است@${bidi.mixedLast}`);
ok('<pre> is direction:ltr', bidi.preDir === 'ltr', bidi.preDir);
ok('<pre> is unicode-bidi:isolate', bidi.preBidi === 'isolate', bidi.preBidi);
ok('inline <code> is unicode-bidi:isolate', bidi.codeBidi === 'isolate', bidi.codeBidi);
ok('body font is Vazirmatn', /Vazirmatn/.test(bidi.bodyFont), bidi.bodyFont);
ok('textarea is unicode-bidi:plaintext', bidi.editorBidi === 'plaintext', bidi.editorBidi);
ok('sidebar sits on the RIGHT in RTL', bidi.sidebarRight);

const align = await page.$$eval('#preview th[align]',
  ns => ns.map(x => x.getAttribute('align') + ':' + getComputedStyle(x).textAlign));
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

await page.evaluate(() => {
  const e = document.getElementById('editor');
  e.value = 'alpha beta alpha';
  e.dispatchEvent(new Event('input', { bubbles: true }));
  const f = document.getElementById('find-input');
  f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.type('#find-input', 'alpha');
await wait(350);
await page.type('#replace-input', 'ALPHA');
await page.click('#replace-all');
await wait(300);
ok('replace-all replaced every occurrence',
  (await page.$eval('#editor', x => x.value)) === 'ALPHA beta ALPHA',
  await page.$eval('#editor', x => x.value));
await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
await wait(300);
ok('Ctrl+Z undoes replace-all (native undo stack preserved)',
  (await page.$eval('#editor', x => x.value)) === 'alpha beta alpha',
  await page.$eval('#editor', x => x.value));
await page.click('#find-close');
ok('find bar closes', await page.$eval('#find-bar', n => n.hidden));

// ------------------------------------------------------------ 9. keyboard
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
  await page.evaluate((v, c) => {
    const e = document.getElementById('editor');
    e.value = v;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.focus(); e.setSelectionRange(c, c);
  }, val, caret);
}

await typeIn('سلام', 4);
await page.evaluate(() => document.getElementById('editor').setSelectionRange(0, 4));
await pressCode('KeyB', 'ذ', 2);   // 2 = Ctrl
await wait(250);
ok('Ctrl+B works when e.key is a Persian character (e.code path)',
  (await page.$eval('#editor', x => x.value)).includes('**'),
  await page.$eval('#editor', x => x.value));

for (const [label, before, caret, after] of [
  ['Enter continues an unordered list', '- item', 6, '- item\n- '],
  ['Enter increments an ordered list', '1. one', 6, '1. one\n2. '],
  ['Enter continues a task list unchecked', '- [ ] task', 10, '- [ ] task\n- [ ] '],
]) {
  await typeIn(before, caret);
  await page.keyboard.press('Enter');
  await wait(250);
  ok(label, (await page.$eval('#editor', x => x.value)) === after,
    JSON.stringify(await page.$eval('#editor', x => x.value)));
}

await typeIn('x', 1);
await page.keyboard.press('Tab');
await wait(250);
ok('Tab inserts two spaces instead of leaving the editor',
  (await page.$eval('#editor', x => x.value)) === 'x  ',
  JSON.stringify(await page.$eval('#editor', x => x.value)));

// -------------------------------------------------------------- 10. save
mark('save');
await page.evaluate(() => {
  const e = document.getElementById('editor');
  e.value = '# عنوان تازه\n\nمتن فارسی ۱۲۳\n';
  e.dispatchEvent(new Event('input', { bubbles: true }));
});
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
  const e = document.getElementById('editor');
  e.value = e.value + 'ویرایش دوم\n';
  e.dispatchEvent(new Event('input', { bubbles: true }));
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

// ------------------------------------------------------------- 11. modes
mark('modes');
await page.click('#mode-preview');
await wait(250);
ok('preview mode hides the editor pane', await page.$eval('#editor-pane', x => x.hidden));
ok('preview mode shows the preview pane', await page.$eval('#preview-pane', x => !x.hidden));
ok('aria-pressed tracks the active mode',
  await page.$eval('#mode-preview', x => x.getAttribute('aria-pressed') === 'true'));
await page.click('#mode-edit');
await wait(250);
ok('edit mode hides the preview pane', await page.$eval('#preview-pane', x => x.hidden));

// ------------------------------------------------------- 12. final state
ok('no page errors overall', pageErrors.length === 0, pageErrors.join(' | '));
ok('no console errors overall', consoleErrors.length === 0, consoleErrors.join(' | '));

mark('end');
await page.evaluate(() => { document.getElementById('mode-split').click(); });
await wait(900);
await page.screenshot({ path: new URL('shot-split.png', import.meta.url).pathname });
await browser.close();

let bad = 0;
for (const [pass, name, detail] of results) {
  if (!pass) bad++;
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (pass || !detail ? '' : '\n          -> ' + detail));
}
console.log(`\n${results.length - bad}/${results.length} browser checks passed`);
if (dialogs.length) console.log('native dialogs seen: ' + dialogs.join(' | '));
process.exit(bad ? 1 : 0);


