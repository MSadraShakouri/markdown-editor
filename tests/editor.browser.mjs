// tests/editor.browser.mjs — js/editor.mjs, driven through its public API in a
// REAL browser, against the real stylesheet (tests/fixtures/editor-harness.html).
//
//   npm install puppeteer && npm run serve && npm run test:browser
//
// Why a browser and not jsdom: CodeMirror measures the document, and the things
// this suite is here to protect — per-line direction, wrap-aware line numbers,
// decorations that stay glued to the text while scrolling — are geometry. jsdom
// has no layout engine; CodeMirror cannot run under it at all.

import { BASE, wait, launchBrowser, requireServer, collector } from './browser-harness.mjs';

await requireServer();
const browser = await launchBrowser();
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 200)); });

await page.goto(BASE + 'tests/fixtures/editor-harness.html', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, { timeout: 15000 });
await wait(300);

const { check, report } = collector();


// ---- 1. per-line direction + gutter + wrap
let r = await page.evaluate(() => window.__report());
check('line 1 (Persian) resolves RTL', r.lines[0].dir === 'rtl', r.lines[0].dir);
check('line 2 (English) resolves LTR', r.lines[1].dir === 'ltr', r.lines[1].dir);
check('gutter shows Persian digits', r.gutter.length >= 4 && /[۰-۹]/.test(r.gutter.join('')), r.gutter.join(' '));
check('gutter numbers align with their lines',
  r.lines.every((l) => r.gutter.filter((g) => Math.abs(Number(g.split('@')[1]) - l.top) <= 2).length === 1),
  JSON.stringify(r.gutter) + ' vs ' + JSON.stringify(r.lines.map((l) => l.top)));
check('gutter is narrow (auto-sized, not 52px)', r.gutterWidth > 0 && r.gutterWidth <= 40, String(r.gutterWidth));
check('wrap on: no horizontal scrolling', r.scrollWidth <= r.clientWidth + 1, `${r.scrollWidth} vs ${r.clientWidth}`);
check('wrap flag reported', r.wrap === true);

// ---- 2. wrap off/on
await page.evaluate(() => window.ed.setWrap(false));
await page.evaluate(() => window.ed.setValue(
  'یک خط بسیار طولانی که باید در حالت بدون شکستن خط افقی اسکرول شود و ادامه پیدا کند تا از عرض ستون بیشتر شود '.repeat(4) + '\n'));
await new Promise((r2) => setTimeout(r2, 200));
r = await page.evaluate(() => window.__report());
check('wrap off: horizontal scrolling returns', r.scrollWidth > r.clientWidth, `${r.scrollWidth} vs ${r.clientWidth}`);
check('wrap off: caret line still numbered', r.gutter.length >= 1, JSON.stringify(r.gutter));
await page.evaluate(() => window.ed.setWrap(true));
await new Promise((r2) => setTimeout(r2, 200));

// ---- 3. wrapped long line: numbers stay aligned, one number per logical line
await page.evaluate(() => window.ed.setValue(
  'خط کوتاه اول\n' + 'این خط طولانی است و باید چند بار شکسته شود تا ارتفاع بیشتری بگیرد '.repeat(3) + '\nخط سوم'));
await new Promise((r2) => setTimeout(r2, 250));
r = await page.evaluate(() => window.__report());
const wrapped = r.lines[1].h > r.lines[0].h;
check('long logical line really wraps (taller row)', wrapped, JSON.stringify(r.lines.map((l) => l.h)));
check('a wrapped line still has ONE number',
  r.gutter.length === 3 && r.lines.length === 3,
  `gutter=${r.gutter.length} lines=${r.lines.length}`);
check('numbers track the first visual row of each logical line',
  r.lines.every((l) => r.gutter.filter((g) => Math.abs(Number(g.split('@')[1]) - l.top) <= 2).length === 1),
  JSON.stringify(r.gutter) + ' vs ' + JSON.stringify(r.lines.map((l) => l.top)));

// ---- 4. formatting commands
const fmt = async (action, doc, sel) => {
  await page.evaluate((d, s) => { window.ed.setValue(d); window.ed.view.dispatch({ selection: { anchor: s[0], head: s[1] } }); }, doc, sel);
  await page.evaluate((a) => window.ed.format(a), action);
  return page.evaluate(() => window.ed.getValue());
};
check('bold wraps the selection', await fmt('bold', 'سلام دنیا', [0, 4]) === '**سلام** دنیا');
check('bold toggles off again', await fmt('bold', '**سلام** دنیا', [2, 6]) === 'سلام دنیا');
check('h1 prefixes the line', await fmt('h1', 'عنوان', [0, 0]) === '# عنوان');
check('h2 replaces an existing heading level', await fmt('h2', '# عنوان', [0, 0]) === '## عنوان');
check('ul prefixes', await fmt('ul', 'مورد', [0, 0]) === '- مورد');
check('task list prefixes', await fmt('task', 'کار', [0, 0]) === '- [ ] کار');
check('ordered list numbers lines', await fmt('ol', 'اول\nدوم', [0, 6]) === '1. اول\n2. دوم');
check('quote prefixes', await fmt('quote', 'نقل', [0, 0]) === '> نقل');
check('inline code wraps', await fmt('code', 'کد', [0, 2]) === '`کد`');

// ---- 5. Enter continues lists (real typing)
await page.evaluate(() => { window.ed.setValue('- مورد اول'); window.ed.focus(); window.ed.view.dispatch({ selection: { anchor: window.ed.view.state.doc.length } }); });
await page.keyboard.press('Enter');
await page.keyboard.type('دوم');
let doc = await page.evaluate(() => window.ed.getValue());
check('Enter continues an unordered list', doc === '- مورد اول\n- دوم', JSON.stringify(doc));

await page.evaluate(() => { window.ed.setValue('1. یکی'); window.ed.focus(); window.ed.view.dispatch({ selection: { anchor: window.ed.view.state.doc.length } }); });
await page.keyboard.press('Enter');
doc = await page.evaluate(() => window.ed.getValue());
check('Enter increments an ordered list', doc === '1. یکی\n2. ', JSON.stringify(doc));

await page.evaluate(() => { window.ed.setValue('- [ ] کار'); window.ed.focus(); window.ed.view.dispatch({ selection: { anchor: window.ed.view.state.doc.length } }); });
await page.keyboard.press('Enter');
doc = await page.evaluate(() => window.ed.getValue());
check('Enter continues a task list', doc === '- [ ] کار\n- [ ] ', JSON.stringify(doc));

await page.evaluate(() => { window.ed.setValue('- '); window.ed.focus(); window.ed.view.dispatch({ selection: { anchor: window.ed.view.state.doc.length } }); });
await page.keyboard.press('Enter');
doc = await page.evaluate(() => window.ed.getValue());
check('Enter on an empty item clears the marker', doc === '', JSON.stringify(doc));

// ---- 6. Tab
await page.evaluate(() => { window.ed.setValue('متن'); window.ed.focus(); window.ed.view.dispatch({ selection: { anchor: 3 } }); });
await page.keyboard.press('Tab');
doc = await page.evaluate(() => window.ed.getValue());
check('Tab inserts two spaces', doc === 'متن  ', JSON.stringify(doc));

// ---- 7. search: matches, navigation, replace
await page.evaluate(() => { window.ed.setValue('سیب و پرتقال و سیب\nدومی: سیب\n'); });
const found = await page.evaluate(() => window.ed.find('سیب'));
await new Promise((r2) => setTimeout(r2, 200));
r = await page.evaluate(() => window.__report());
check('find counts every match', found.count === 3, JSON.stringify(found));
check('all matches are highlighted in the DOM', r.matches === 3, String(r.matches));
check('exactly one match is the "current" one', r.currentMatches === 1, String(r.currentMatches));

const nav = await page.evaluate(() => { const a = window.ed.findStep(1); const b = window.ed.findStep(1); return [a, b]; });
check('findStep moves through matches', nav[0].index === 1 && nav[1].index === 2, JSON.stringify(nav));
check('findStep wraps around', (await page.evaluate(() => window.ed.findStep(1))).index === 0, '');

const replaced = await page.evaluate(() => {
  window.ed.setValue('سیب و پرتقال و سیب\nدومی: سیب\n');
  window.ed.find('سیب');
  window.ed.replaceCurrent('انار');
  return window.ed.getValue();
});
check('replaceCurrent replaces only the current match',
  replaced === 'انار و پرتقال و سیب\nدومی: سیب\n', JSON.stringify(replaced));

const replacedAll = await page.evaluate(() => {
  window.ed.setValue('سیب و پرتقال و سیب\nدومی: سیب\n');
  window.ed.find('سیب');
  const n = window.ed.replaceAll('خرما');
  return [n, window.ed.getValue()];
});
check('replaceAll replaces every match, reports the count',
  replacedAll[0] === 3 && replacedAll[1] === 'خرما و پرتقال و خرما\nدومی: خرما\n',
  JSON.stringify(replacedAll));

// ---- 8. undo survives a replace (the old execCommand trick is gone)
await page.evaluate(() => {
  window.ed.setValue('یک سیب');
  window.ed.focus();
  window.ed.view.dispatch({ selection: { anchor: 6 } });
});
await page.keyboard.type(' و یک سیب دیگر');
await new Promise((r2) => setTimeout(r2, 100));
const typed = await page.evaluate(() => window.ed.getValue());
await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
await new Promise((r2) => setTimeout(r2, 100));
const undone = await page.evaluate(() => window.ed.getValue());
check('Ctrl+Z undoes typed input', typed !== undone, `${JSON.stringify(typed)} -> ${JSON.stringify(undone)}`);

// ---- 9. read-only + change events + counts
const counters = await page.evaluate(() => {
  const before = { changes: window.__changes || 0, cursors: window.__cursors || 0 };
  window.ed.setValue('متن تازه');
  const afterSet = { changes: window.__changes || 0 };
  window.ed.view.dispatch({ changes: { from: 0, insert: 'X' } });
  return { before, afterSet, after: window.__changes || 0 };
});
check('setValue does not fire onChange (opening a file is not an edit)',
  counters.afterSet.changes === counters.before.changes, JSON.stringify(counters));
check('typing does fire onChange', counters.after > counters.afterSet.changes, JSON.stringify(counters));

const counts = await page.evaluate(() => {
  window.ed.setValue('دو واژه سه');
  return { words: window.ed.wordCount(), chars: window.ed.charCount(), lines: window.ed.lineCount() };
});
check('counts are sane', counts.words === 3 && counts.chars === 10 && counts.lines === 1, JSON.stringify(counts));

await page.evaluate(() => window.ed.setReadOnly(true));
const ro = await page.evaluate(() => {
  const before = window.ed.getValue();
  window.ed.view.focus();
  return { isReadOnly: window.ed.view.state.readOnly, before };
});
await page.keyboard.type('باید مسدود شود');
const roAfter = await page.evaluate(() => window.ed.getValue());
check('read-only blocks typing', ro.isReadOnly && roAfter === ro.before, `${JSON.stringify(roAfter)}`);
await page.evaluate(() => window.ed.setReadOnly(false));

// ---- 10. screenshot of the real skin
await page.evaluate(() => {
  window.ed.setValue([
    '## سرفصل دوم',
    '',
    'این خط فارسی است و باید راست‌چین شود، با **تأکید** و `کد` درونش.',
    'This line is English and must stay left aligned.',
    '',
    '- مورد فهرست',
    '- [ ] کار انجام‌نشده',
    '',
    '> نقل‌قول کوتاه',
    '',
    '```js',
    'const x = 1;',
    '```',
  ].join('\n'));
  window.ed.find('فارسی');
});
await new Promise((r2) => setTimeout(r2, 400));
await page.screenshot({ path: '/tmp/editor-skin.png' });

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

const bad = report('editor checks');
await browser.close();
process.exit(bad ? 1 : 0);