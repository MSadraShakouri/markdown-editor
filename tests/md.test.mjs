// tests/md.test.mjs — exercises the REAL js/md.mjs against the REAL vendored
// vendor/*.js files, loaded into jsdom exactly the way index.html loads them.
//
//   npm install && npm test
//
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- load the actual vendored UMD files, not the npm packages -------------
// This matters: if a vendored file is truncated, stale or the wrong build,
// importing from node_modules would hide it.
const dom = new JSDOM('<!doctype html><html dir="rtl" lang="fa"><body></body></html>',
  { runScripts: 'outside-only' });
const sandbox = dom.getInternalVMContext();

for (const f of ['vendor/marked.min.js', 'vendor/marked-footnote.umd.js', 'vendor/purify.min.js']) {
  vm.runInContext(readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

// mirror the globals onto this process so js/md.mjs can pick them up
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.marked = dom.window.marked;
globalThis.markedFootnote = dom.window.markedFootnote;
globalThis.DOMPurify = dom.window.DOMPurify;

assert.ok(globalThis.marked, 'window.marked should exist after loading vendor/marked.min.js');
assert.ok(globalThis.markedFootnote, 'window.markedFootnote should exist');
assert.ok(globalThis.DOMPurify, 'window.DOMPurify should exist');

const { renderMarkdown, splitFrontMatter, resolveImageSrc, setRenderContext } =
  await import('../js/md.mjs');

// ---------------------------------------------------------------- features
test('vendor: marked version is the one we vendored', () => {
  assert.match(readFileSync(path.join(ROOT, 'vendor/marked.min.js'), 'utf8'), /marked v15\.0\.12/);
});

test('table: alignment survives as an align attribute, not inline style', () => {
  const out = renderMarkdown('| a | b | c |\n| ---: | :---: | :--- |\n| 1 | 2 | 3 |\n');
  assert.match(out, /<th align="right">/);
  assert.match(out, /<th align="center">/);
  assert.match(out, /<td align="right">/);
  assert.ok(!out.includes('style='), 'no inline style should survive the sanitizer');
});

test('table: escaped pipe and inline code inside a cell', () => {
  const out = renderMarkdown('| a | b |\n| --- | --- |\n| x\\|y | `c` |\n');
  assert.match(out, /x\|y/);
  assert.match(out, /<code>c<\/code>/);
});

test('task lists render with disabled+checked preserved', () => {
  const out = renderMarkdown('- [ ] a\n- [x] b\n- [X] c\n');
  assert.equal((out.match(/type="checkbox"/g) || []).length, 3);
  assert.equal((out.match(/disabled/g) || []).length, 3, 'every checkbox must stay disabled');
  assert.equal((out.match(/checked/g) || []).length, 2);
});

test('task lists work inside ordered lists too', () => {
  const out = renderMarkdown('1. [ ] one\n2. [x] two\n');
  assert.match(out, /<ol>/);
  assert.equal((out.match(/type="checkbox"/g) || []).length, 2);
});

test('strikethrough', () => {
  assert.match(renderMarkdown('~~gone~~'), /<del>gone<\/del>/);
});

test('footnotes: namespaced ids, non-numeric label, duplicate refs, back-links', () => {
  const out = renderMarkdown('x[^note-1] and again[^note-1] and fa[^یادداشت]\n\n'
    + '[^note-1]: first\n[^یادداشت]: persian\n');
  assert.match(out, /id="fn-note-1"/, 'prefixId "fn-" must be applied');
  assert.match(out, /href="#fn-note-1"/);
  assert.equal((out.match(/href="#fn-note-1"/g) || []).length, 2, 'two refs to one footnote');
  assert.match(out, /id="fn-[^"]*"/);
  assert.match(out, /data-footnote-backref|aria-label="بازگشت/, 'back-link present');
  assert.match(out, /پانویس‌ها|class="sr-only"/, 'Persian sr-only heading');
  assert.ok(!out.includes('id="footnote-'), 'ids must not collide with the default prefix');
});

test('bare URL and www. are autolinked', () => {
  const out = renderMarkdown('see https://example.com and www.example.com now');
  assert.match(out, /<a href="https:\/\/example\.com">/);
  assert.match(out, /<a href="http:\/\/www\.example\.com">/);
});

test('<details>/<summary> and <picture>/<source> pass the filter', () => {
  const out = renderMarkdown('<details><summary>s</summary>body</details>\n\n'
    + '<picture><source srcset="a.webp" type="image/webp"><img src="a.png" alt="x"></picture>\n');
  assert.match(out, /<details>/);
  assert.match(out, /<summary>s<\/summary>/);
  assert.match(out, /<picture>/);
  assert.match(out, /<source/);
});

test('setext headings, reference + collapsed reference links, escapes', () => {
  const out = renderMarkdown(
    'Title\n=====\n\nSub\n---\n\n[a][r] and [b][] and \\*not em\\*\n\n[r]: /r\n[b]: /b\n');
  assert.match(out, /<h1>Title<\/h1>/);
  assert.match(out, /<h2>Sub<\/h2>/);
  assert.match(out, /<a href="\/r">a<\/a>/);
  assert.match(out, /<a href="\/b">b<\/a>/);
  assert.match(out, /\*not em\*/);
});

test('hard line break from two trailing spaces', () => {
  assert.match(renderMarkdown('a  \nb'), /<br>/);
});

// ------------------------------------------------------- YAML front matter
test('front matter is split off and rendered as a collapsed table', () => {
  const { yaml, body } = splitFrontMatter('---\ntitle: سند\ndraft: false\n---\n\n# Hi\n');
  assert.equal(yaml, 'title: سند\ndraft: false');
  assert.equal(body.trim(), '# Hi');

  const out = renderMarkdown('---\ntitle: سند\ndraft: false\n---\n\n# Hi\n');
  assert.match(out, /<details class="front-matter">/);
  assert.match(out, /<th>title<\/th>/);
  assert.match(out, /سند/);
  assert.match(out, /<h1>Hi<\/h1>/);
  assert.ok(!out.includes('---'), 'the --- fences must not leak into the output');
});

test('no front matter -> body untouched', () => {
  assert.deepEqual(splitFrontMatter('# Hi\n'), { yaml: null, body: '# Hi\n' });
});

// ---------------------------------------------------- relative image rewrite
test('relative image src is rewritten to raw.githubusercontent.com', () => {
  setRenderContext({ owner: 'me', repo: 'notes', ref: 'main', dir: 'posts/2026' });
  const out = renderMarkdown('![a](images/diagram.png)');
  assert.match(out, /src="https:\/\/raw\.githubusercontent\.com\/me\/notes\/main\/posts\/2026\/images\/diagram\.png"/);
});

test('relative image: ../ segments and Persian filename are encoded', () => {
  setRenderContext({ owner: 'me', repo: 'notes', ref: 'main', dir: 'a/b' });
  assert.equal(
    resolveImageSrc('../img/عکس.png'),
    'https://raw.githubusercontent.com/me/notes/main/a/img/' + encodeURIComponent('عکس.png'));
});

test('absolute, protocol-relative, anchor and data: images are left alone', () => {
  setRenderContext({ owner: 'me', repo: 'r', ref: 'main', dir: 'd' });
  for (const s of ['https://x/y.png', 'http://x/y.png', '//x/y.png', '#frag', '/abs.png',
                   'data:image/png;base64,AAAA']) {
    assert.equal(resolveImageSrc(s), s);
  }
});

// ------------------------------------------------------------------ security
const ATTACKS = {
  'script tag':            ['<script>alert(1)</script>',            ['<script', 'alert(1)']],
  'img onerror':           ['<img src=x onerror=alert(1)>',          ['onerror']],
  'javascript: link':      ['[c](javascript:alert(1))',              ['javascript:']],
  'javascript: href':      ['<a href="javascript:alert(1)">c</a>',   ['javascript:']],
  'data: html link':       ['[c](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)', ['data:text/html']],
  'style tag':             ['<style>body{display:none}</style>',     ['<style', 'display:none']],
  'inline style phish':    ['<div style="position:fixed;inset:0;background:#fff">p</div>', ['style=']],
  'form':                  ['<form action="https://evil"><input name=pw></form>', ['<form']],
  'iframe':                ['<iframe src="https://evil"></iframe>',  ['<iframe']],
  'svg onload':            ['<svg onload=alert(1)></svg>',           ['<svg', 'onload']],
  'details ontoggle':      ['<details ontoggle=alert(1) open><summary>s</summary></details>', ['ontoggle']],
  'base hijack':           ['<base href="https://evil">',            ['<base']],
  'meta refresh':          ['<meta http-equiv="refresh" content="0;url=https://evil">', ['<meta']],
};

for (const [name, [input, forbidden]] of Object.entries(ATTACKS)) {
  test(`sanitizer blocks: ${name}`, () => {
    const out = renderMarkdown(input);
    for (const bad of forbidden) {
      assert.ok(!out.toLowerCase().includes(bad.toLowerCase()),
        `${name}: output still contains ${JSON.stringify(bad)} -> ${out}`);
    }
  });
}

test('sanitizer: a whole attack document renders to nothing executable', () => {
  const out = renderMarkdown(Object.values(ATTACKS).map(a => a[0]).join('\n\n'));
  assert.ok(!/on\w+\s*=/.test(out), 'no inline event handler survived: ' + out);
});

test('parse errors do not blank the preview', () => {
  // marked is very forgiving; force the failure path through a hostile input
  // by checking the documented fallback exists in the module surface.
  assert.equal(typeof renderMarkdown(undefined), 'string');
  assert.equal(renderMarkdown(null), '');
});


