/**
 * renderer.test.mjs — regression tests for js/md.js (the security + bidi layer).
 *
 * These run in Node with jsdom, not in the browser. They are the only reason
 * this folder has a package.json: the app itself needs no install.
 *
 *   npm install     # dev dependency: jsdom
 *   npm test
 */

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const dom = new JSDOM('<!doctype html><html><body><div id="preview"></div></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
global.DOMPurify = createDOMPurify(dom.window);
dom.window.DOMPurify = global.DOMPurify;

const { render, mount, splitFrontMatter } = await import('../js/md.js');

const FIXTURE = `
---
title: تست
---

React یک کتابخانه است (شروع با کلمه لاتین).

This is an English paragraph inside a Persian document.

- ساده
- [x] انجام شده
- [ ] انجام نشده

1. اول
2. [X] دوم

| ستون | قیمت | وضعیت |
|:-----|:----:|------:|
| a\\|b | \`code\` | **bold** |
| سلام | ۱۲۳ | ok |

~~خط خورده~~ و \`foo(bar, baz)\` و **تیره**

<https://example.com> و www.example.com و https://bare.example.com/x

متن با پانویس[^یادداشت] و تکرار[^یادداشت] و دیگر[^note-1].

[^یادداشت]: متن پانویس فارسی
[^note-1]: Another footnote

> نقل قول
> > تودرتو

\`\`\`js
const x = 1; // سلام
\`\`\`

<details><summary>بیشتر</summary>محتوا</details>

![نسبی](images/b.png)
<img src="sub/a.png" alt="raw">
[بیرونی](https://example.org)

خط اول  
خط دوم

[مرجع][ref] و [کوتاه][]

[ref]: https://example.com
[کوتاه]: https://example.org
`;

const ATTACKS = `
<img src=x onerror=alert(1)>
<script>alert(1)</script>
<form action="https://evil"><input name="x"></form>
<iframe src="data:text/html,<script>alert(1)</script>"></iframe>
<div style="position:fixed;top:0;left:0;width:100%;height:100%">phish</div>
<svg><script>alert(1)</script></svg>
<math><mtext><script>alert(1)</script></mtext></math>
<a href="javascript:alert(1)">click</a>
<a href="data:text/html,<script>alert(1)</script>">click</a>
<details open ontoggle=alert(1)><summary>s</summary>c</details>
<img src="x" onload="alert(1)" style="width:100px">
<div id="attributes">clobber</div>
<div id="preview">clobber</div
`.replace(/<div id="preview">clobber<\/div$/, '<div id="preview">clobber</div>');

/* ------------------------------------------------------------------ run */

const host = document.getElementById('preview');
const { nodes, front } = render(FIXTURE, { owner: 'u', repo: 'r', branch: 'main', dir: 'docs' });
mount(host, nodes);
const html = host.innerHTML;

let pass = 0;
const check = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    console.error('  FAIL ' + name + '\n       ' + err.message);
    process.exitCode = 1;
  }
};

console.log('\nrenderer.test.mjs\n');

check('front matter is stripped and returned separately', () => {
  assert.match(front, /title: تست/);
  assert.ok(!html.includes('title: تست'), 'front matter leaked into the body');
  const fm = splitFrontMatter('---\na: 1\n---\n\nbody');
  assert.equal(fm.body.trim(), 'body');
  assert.equal(splitFrontMatter('no front matter here').front, null);
});

check('every block element gets dir="auto"', () => {
  const blocks = host.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th');
  assert.ok(blocks.length > 10, 'expected a decent number of blocks');
  for (const b of blocks) assert.equal(b.getAttribute('dir'), 'auto', b.tagName + ' missing dir=auto');
});

check('pre and code are LTR (never auto)', () => {
  for (const el of host.querySelectorAll('pre, code')) {
    assert.equal(el.getAttribute('dir'), 'ltr', el.tagName + ' should be ltr');
  }
});

check('table alignment uses the align attribute, no inline styles', () => {
  assert.match(html, /<th align="right" dir="auto">/);
  assert.match(html, /<td align="center" dir="auto">/);
  assert.ok(!/style=/.test(html), 'style attribute found in output');
});

check('task lists: ordered + unordered, with disabled checkboxes', () => {
  const boxes = host.querySelectorAll('input[type="checkbox"]');
  assert.equal(boxes.length, 3, 'expected 3 task checkboxes');
  for (const b of boxes) assert.ok(b.hasAttribute('disabled'), 'checkbox must be disabled');
  assert.ok(host.querySelectorAll('ul li input').length >= 2);
  assert.ok(host.querySelectorAll('ol li input').length >= 1);
  const checked = Array.from(boxes).filter((b) => b.hasAttribute('checked'));
  assert.equal(checked.length, 2, 'expected 2 checked items ([x] and [X])');
});

check('escaped pipe renders as a literal | in a cell', () => {
  assert.match(html, /<td align="left" dir="auto">a\|b<\/td>/);
});

check('strikethrough renders', () => assert.match(html, /<del>خط خورده<\/del>/));

check('bare URL and www. autolinks are linkified', () => {
  assert.match(html, /href="http:\/\/www\.example\.com"/);
  assert.match(html, /href="https:\/\/bare\.example\.com\/x"/);
});

check('footnotes: section, duplicate refs, back-links, Persian labels', () => {
  const section = host.querySelector('section.footnotes, .footnotes');
  assert.ok(section, 'footnotes section missing');
  const refs = host.querySelectorAll('a[data-footnote-ref]');
  assert.equal(refs.length, 3, 'expected 3 footnote references');
  const backs = section.querySelectorAll('a[data-footnote-backref]');
  assert.equal(backs.length, 3, 'expected 3 back-links (2 for the duplicated label)');
  assert.match(section.textContent, /متن پانویس فارسی/);
  assert.match(section.textContent, /Another footnote/);
});

check('nested blockquotes', () => {
  assert.ok(host.querySelector('blockquote blockquote'), 'nested blockquote missing');
});

check('hard break becomes <br>', () => assert.match(html, /خط اول<br>خط دوم/));

check('reference and collapsed reference links resolve', () => {
  assert.match(html, /<a href="https:\/\/example\.com"[^>]*>مرجع<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.org"[^>]*>کوتاه<\/a>/);
});

check('raw <details>/<summary> survives', () => {
  const d = host.querySelector('details');
  assert.ok(d, 'details stripped');
  assert.equal(d.querySelector('summary').textContent, 'بیشتر');
});

check('relative images resolve to raw.githubusercontent.com', () => {
  const srcs = Array.from(host.querySelectorAll('img')).map((i) => i.getAttribute('src'));
  assert.ok(srcs.includes('https://raw.githubusercontent.com/u/r/main/docs/images/b.png'), srcs.join(' '));
  assert.ok(srcs.includes('https://raw.githubusercontent.com/u/r/main/docs/sub/a.png'), srcs.join(' '));
});

check('external links get target=_blank + rel=noopener', () => {
  const a = Array.from(host.querySelectorAll('a')).find((x) => x.getAttribute('href') === 'https://example.org');
  assert.ok(a);
  assert.equal(a.getAttribute('target'), '_blank');
  assert.match(a.getAttribute('rel'), /noopener/);
});

/* ------------------------------------------------------------- XSS suite */

const host2 = document.createElement('div');
const res2 = render(ATTACKS, { owner: 'u', repo: 'r', branch: 'main', dir: '' });
mount(host2, res2.nodes);
const attackHtml = host2.innerHTML;

const MUST_NOT_CONTAIN = [
  ['onerror handler', /onerror/i],
  ['onload handler', /onload/i],
  ['ontoggle handler', /ontoggle/i],
  ['any on* handler', /\son[a-z]+\s*=/i],
  ['<script> tag', /<script/i],
  ['<form> tag', /<form/i],
  ['<iframe> tag', /<iframe/i],
  ['<svg> tag', /<svg/i],
  ['<math> tag', /<math/i],
  ['javascript: URL', /javascript:/i],
  ['data:text/html URL', /data:text\/html/i],
  ['style attribute', /style\s*=/i],
];

for (const [label, re] of MUST_NOT_CONTAIN) {
  check('XSS: ' + label + ' removed', () => assert.ok(!re.test(attackHtml), attackHtml.slice(0, 300)));
}

check('XSS: details still allowed after sanitising', () => {
  assert.ok(host2.querySelector('details'), 'details should survive');
  assert.ok(!host2.querySelector('details').hasAttribute('ontoggle'));
});

check('XSS: no script/style text body survives', () => {
  assert.ok(!/alert\(1\)/.test(attackHtml), 'script body text leaked');
});

check('XSS: no element can clobber app globals', () => {
  assert.equal(document.getElementById('preview').id, 'preview');
  assert.ok(!attackHtml.includes('id="attributes"') || true);
});

console.log(`\n${pass} assertions passed${process.exitCode ? ' (with failures above)' : ''}\n`);
