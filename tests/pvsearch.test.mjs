// tests/pvsearch.test.mjs — js/pvsearch.mjs, the preview's search engine.
//
//   npm test  (node --test "tests/*.test.mjs")
//
// Unlike CodeMirror, this module is plain DOM walking, so jsdom answers it
// honestly — and it is worth testing here rather than only in the browser,
// because the failure mode that matters is destructive: a search that leaves
// <mark> elements behind would end up inside the HTML the renderer produces on
// the next edit. Every test therefore works on the real thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html dir="rtl" lang="fa"><body><div id="preview"></div></body></html>');
globalThis.document = dom.window.document;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.Node = dom.window.Node;

const { createPreviewSearch } = await import('../js/pvsearch.mjs');
const root = dom.window.document.getElementById('preview');

/** Fresh search over fresh markup; returns everything a test needs. */
function setup(html) {
  root.innerHTML = html;
  const before = root.innerHTML;
  return { search: createPreviewSearch(root), before };
}

const marks = () => [...root.querySelectorAll('mark.pv-hl-match')];
const current = () => [...root.querySelectorAll('mark.pv-hl-current')];

test('finds every occurrence, across elements', () => {
  const { search } = setup('<h1>عنوان فایل</h1><p>یک فایل دیگر</p><li>فایل سوم</li>');
  const { count, index } = search.find('فایل');
  assert.equal(count, 3);
  assert.equal(index, 0, 'starts at the first match');
  assert.equal(marks().length, 3);
});

test('the current match is marked, and step() wraps around both ends', () => {
  const { search } = setup('<p>a x b x c x</p>');
  assert.deepEqual(search.find('x'), { count: 3, index: 0 });
  assert.deepEqual(search.step(1), { count: 3, index: 1 });
  assert.deepEqual(search.step(1), { count: 3, index: 2 });
  assert.deepEqual(search.step(1), { count: 3, index: 0 }, 'past the end → back to the first');
  assert.deepEqual(search.step(-1), { count: 3, index: 2 }, 'before the start → the last');
  assert.equal(current().length, 1, 'exactly one current match');
  assert.equal(current()[0].textContent, 'x');
});

test('case-insensitive by default, exact when asked', () => {
  const { search } = setup('<p>React و react و REACT</p>');
  assert.equal(search.find('react').count, 3);
  assert.equal(search.find('react', { caseSensitive: true }).count, 1);
  assert.equal(search.find('React', { caseSensitive: true }).count, 1);
});

test('a query is literal text, not a pattern', () => {
  const { search } = setup('<p>a.b a.b axb two dots: .</p>');
  assert.equal(search.find('a.b').count, 2, 'the dot matches a dot, not any character');
  assert.equal(search.find('.').count, 3);
  assert.equal(search.find('**').count, 0, 'markdown markers are not on screen');
});

test('clear() leaves the DOM exactly as the renderer produced it', () => {
  const { search, before } = setup('<h1>سلام دنیا</h1><p>دنیا یعنی world — یک دنیا</p><ul><li>دنیا</li></ul>');
  search.find('دنیا');
  assert.equal(marks().length, 4);
  assert.notEqual(root.innerHTML, before, 'while searching, the DOM is wrapped');
  search.clear();
  assert.equal(marks().length, 0);
  assert.equal(root.innerHTML, before, 'and afterwards it is byte-for-byte back');
});

test('searching twice does not wrap what the first search wrapped', () => {
  const { search } = setup('<p>تو تو تو</p>');
  assert.equal(search.find('تو').count, 3);
  assert.equal(search.find('تو').count, 3, 'not 6 — the first pass was undone');
  assert.equal(marks().length, 3);
  assert.equal(root.textContent, 'تو تو تو', 'the text itself never changes');
});

test('an empty query, and a query that matches nothing', () => {
  const { search, before } = setup('<p>چیزی اینجا نیست</p>');
  assert.deepEqual(search.find(''), { count: 0, index: -1 });
  assert.equal(marks().length, 0);
  assert.deepEqual(search.find('کلمه‌ای که نیست'), { count: 0, index: -1 });
  assert.deepEqual(search.step(1), { count: 0, index: -1 }, 'stepping with no matches is a no-op');
  assert.equal(search.current(), null);
  assert.equal(root.innerHTML, before);
});

test('a match spanning two elements is not found — a documented limit', () => {
  const { search } = setup('<p><strong>نی</strong>مفاصله</p>');
  // "نیم‌فاصله" is split across a text node boundary by the renderer, so the
  // index-of based scan cannot see it. Pinned here so nobody discovers it by
  // surprise; browsers have the same limit with find-on-page.
  assert.equal(search.find('نیم‌فاصله').count, 0);
  assert.equal(search.find('نی').count, 1);
});

test('script and style content is never searched or wrapped', () => {
  const { search } = setup('<p>visible</p><script>var hidden = "visible";</script><style>.x{content:"visible"}</style>');
  assert.equal(search.find('visible').count, 1);
  assert.equal(root.querySelector('script').innerHTML.includes('<mark'), false);
});

test('whitespace-only nodes are skipped, and indentation survives', () => {
  const { search, before } = setup('<ul>\n  <li>یک</li>\n  <li>یک</li>\n</ul>');
  assert.equal(search.find('یک').count, 2);
  search.clear();
  assert.equal(root.innerHTML, before);
});

test('it still works after the preview is re-rendered under it', () => {
  const { search } = setup('<p>متن قدیمی</p>');
  search.find('متن');
  // The app re-renders #preview on the next edit; the old marks go with it.
  root.innerHTML = '<p>متن تازه با متن دوم</p>';
  const { count } = search.find('متن');
  assert.equal(count, 2);
  assert.equal(marks().length, 2);
  search.clear();
  assert.equal(root.innerHTML, '<p>متن تازه با متن دوم</p>');
});

test('overlapping candidates advance, they do not loop forever', () => {
  const { search } = setup('<p>aaaa</p>');
  assert.equal(search.find('aa').count, 2, 'non-overlapping, left to right, like a browser');
  assert.equal(marks().map((m) => m.textContent).join('|'), 'aa|aa');
});

test('the marks are ordinary elements the stylesheet can reach', () => {
  const { search } = setup('<p>هدف</p>');
  search.find('هدف');
  assert.equal(marks()[0].tagName, 'MARK', 'a real <mark>, not a span with a class');
  assert.ok(marks()[0].classList.contains('pv-hl-match'));
  // The first match is the current one from the moment it is found, so it wears
  // both classes; step() just moves which element that is.
  assert.ok(current()[0].classList.contains('pv-hl-current'));
  assert.equal(current().length, 1);
});
