// tests/app.boot.test.mjs — boots the REAL index.html + js/app.mjs in jsdom.
//
// app.mjs wires itself to the DOM at import time and has no exported surface, so
// this is the only automated check that the element ids, the demo session and the
// responsive header shell actually fit together. It is NOT a substitute for
// tests/e2e.browser.mjs: jsdom has no layout engine, so anything geometric
// (gutter alignment, scroll sync, real wrapping) must be checked in a browser.
//
// jsdom gaps stubbed below: matchMedia, ResizeObserver, <dialog>.showModal,
// Element.scrollTo, document.execCommand, and same-origin fetch.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --------------------------------------------------------------- the document
const dom = new JSDOM(readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
  url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
});
const { window } = dom;
const document = window.document;

// The vendored UMD libraries, loaded exactly the way index.html loads them.
const sandbox = dom.getInternalVMContext();
for (const f of ['vendor/marked.min.js', 'vendor/marked-footnote.umd.js', 'vendor/purify.min.js']) {
  vm.runInContext(readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

// ------------------------------------------------------------ stubs / harness
/** A MediaQueryList we can flip, so the 860px breakpoint is testable. */
function makeMediaQuery(media) {
  const listeners = new Set();
  return {
    media, matches: false, onchange: null,
    addEventListener: (type, fn) => { if (type === 'change') listeners.add(fn); },
    removeEventListener: (type, fn) => listeners.delete(fn),
    flip(matches) {
      this.matches = matches;
      for (const fn of [...listeners]) fn({ matches, media, type: 'change' });
    },
  };
}
let mobileMQ = null;
window.matchMedia = (media) => {
  const mq = makeMediaQuery(media);
  if (media.includes('max-width: 860px')) mobileMQ = mq;
  return mq;
};

window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.Element.prototype.scrollTo = function scrollTo() {};
window.Element.prototype.scrollIntoView = function scrollIntoView() {};

if (typeof window.HTMLDialogElement.prototype.showModal !== 'function') {
  window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
}
if (typeof window.HTMLDialogElement.prototype.close !== 'function') {
  window.HTMLDialogElement.prototype.close = function close(value) {
    this.removeAttribute('open');
    this.returnValue = value ?? '';
    this.dispatchEvent(new window.Event('close'));
  };
}

// applyFormatting()/replaceCurrent() keep the native undo stack by going through
// execCommand('insertText'). jsdom has no editor commands, so emulate that one.
document.execCommand = (cmd, _ui, value) => {
  if (cmd !== 'insertText') return false;
  const ta = document.getElementById('editor');
  const { selectionStart: s, selectionEnd: e } = ta;
  ta.value = ta.value.slice(0, s) + value + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + String(value).length;
  return true;
};

globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.marked = window.marked;
globalThis.markedFootnote = window.markedFootnote;
globalThis.DOMPurify = window.DOMPurify;
globalThis.confirm = () => true;
globalThis.prompt = () => null;
globalThis.fetch = async (url) => {
  const file = path.join(ROOT, decodeURIComponent(String(url)));
  if (!existsSync(file)) return { ok: false, status: 404, text: async () => '' };
  const text = readFileSync(file, 'utf8');
  return { ok: true, status: 200, text: async () => text };
};

const { DEMO_FILES, DEMO_START_FILE } = await import('../js/demo.mjs');
await import('../js/app.mjs');           // boots: wire() + setMode('edit') + showLogin()

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${what}\n  login-error: ${$('login-error').textContent}`
        + `\n  tree-status: ${$('tree-status').textContent}`);
    }
    await sleep(10);
  }
}
const pressKey = (code, opts = {}) => document.dispatchEvent(
  new window.KeyboardEvent('keydown', { code, key: opts.key || code, bubbles: true, cancelable: true, ...opts }));
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

after(() => window.close());

// ------------------------------------------------------------------- the tests
test('boot: visitors without a token land on the login card', () => {
  assert.equal($('login-view').hidden, false);
  assert.equal($('app-view').hidden, true);
  assert.equal($('demo-btn').type, 'button',
    'a submit button here would run the required token input and never reach the handler');
  assert.equal($('token-input').required, true, 'the token field is still required for a real login');
});

test('shell: the desktop header is one flat row, extras live in #topbar-extra', () => {
  assert.equal(mobileMQ.matches, false);
  for (const id of ['find-open', 'btn-new-file', 'user-box']) {
    assert.equal($(id).parentElement.id, 'topbar-extra', `${id} should sit in the header on desktop`);
  }
  assert.equal($('menu-slot').children.length, 0);
  assert.equal($('sidebar-toggle').getAttribute('aria-expanded'), 'true');
});

test('demo: the demo button opens a real document without a token', async () => {
  click($('demo-btn'));
  await until(() => $('path-label').textContent === DEMO_START_FILE, 'the demo file to open');

  assert.equal($('app-view').hidden, false);
  assert.equal($('login-view').hidden, true);
  assert.equal(document.body.classList.contains('demo'), true);
  assert.equal($('demo-banner').hidden, false, 'the demo banner must be visible');
  assert.equal($('repo-status').textContent, 'حالت نمایشی — بدون توکن');
  assert.match($('editor').value, /نسخهٔ نمایشی/, 'the start document should be in the editor');
  assert.equal($('user-login').textContent, 'نمونه');
  assert.equal($('commit-btn').disabled, true, 'a demo session must not be committable');
  assert.equal($('btn-new-file').disabled, true, 'a new file could never be saved in the demo');
  assert.match($('commit-btn').title, /حالت نمایشی/);

  // Files at the top level show straight away; the nested archive folder opens
  // on click (the lone root folder is auto-expanded by loadTree()).
  const visible = () => [...document.querySelectorAll('.tree-file-btn')].map((b) => b.title);
  const topLevel = DEMO_FILES.filter((p) => p.split('/').length === 2);   // demo/x.md
  const nested = DEMO_FILES.filter((p) => p.split('/').length > 2);       // demo/dir/x.md
  for (const p of topLevel) assert.ok(visible().includes(p), `${p} missing from the sidebar`);

  const folder = [...document.querySelectorAll('.tree-toggle')].find((b) => b.textContent.includes('آرشیو'));
  assert.ok(folder, 'the nested folder should be listed');
  click(folder);
  for (const p of nested) assert.ok(visible().includes(p), `${p} missing after expanding its folder`);
  click(folder);

  // The demo must not touch the storage of a real session.
  assert.equal(window.localStorage.length, 0,
    `demo wrote to localStorage: ${JSON.stringify(Object.keys(window.localStorage))}`);
});

test('shell: crossing the breakpoint MOVES the controls into the ⋯ menu', async () => {
  const moved = ['find-open', 'btn-new-file', 'user-box'].map($);
  mobileMQ.flip(true);
  await sleep(0);

  for (const node of moved) {
    assert.equal(node.parentElement.id, 'menu-slot', `${node.id} should move into the menu`);
  }
  assert.equal(document.body.classList.contains('sidebar-collapsed'), true,
    'the drawer is an overlay on mobile: it must start closed');
  assert.equal($('sidebar-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal($('mode-edit').closest('.topbar') !== null, true, 'the mode switch stays in the header');

  mobileMQ.flip(false);
  await sleep(0);
  for (const node of moved) {
    assert.equal(node.parentElement.id, 'topbar-extra', `${node.id} should move back`);
    assert.equal(node.isConnected, true, 'nodes are moved, never cloned or dropped');
  }
  assert.equal(document.body.classList.contains('sidebar-collapsed'), false);
});

test('shell: the ⋯ menu opens, and an action inside it closes it', async () => {
  click($('more-btn'));
  assert.equal($('more-dialog').open, true);
  assert.equal($('more-btn').getAttribute('aria-expanded'), 'true');

  mobileMQ.flip(true);
  await sleep(0);
  click($('find-open'));                       // a moved control, so this is the menu path
  assert.equal($('more-dialog').open, false, 'the menu must close when an action runs');
  assert.equal($('find-bar').hidden, false, 'جستوجو should have opened the find bar');
  click($('find-close'));
  assert.equal($('find-bar').hidden, true);
  mobileMQ.flip(false);
  await sleep(0);
});

test('sidebar: the toggle keeps aria-expanded in step with the drawer', () => {
  const before = $('sidebar-toggle').getAttribute('aria-expanded');
  click($('sidebar-toggle'));
  assert.notEqual($('sidebar-toggle').getAttribute('aria-expanded'), before);
  assert.equal(document.body.classList.contains('sidebar-collapsed'),
    $('sidebar-toggle').getAttribute('aria-expanded') === 'false');
  click($('sidebar-toggle'));
  assert.equal(document.body.classList.contains('sidebar-collapsed'), false);
});

test('editor: a demo session can edit and preview, but Ctrl+S only explains', async () => {
  const ed = $('editor');
  ed.focus();
  ed.value += '\n\nیک خط تازه برای امتحان.\n';
  ed.dispatchEvent(new window.Event('input', { bubbles: true }));

  assert.equal($('dirty-dot').hidden, false, 'editing should mark the document dirty');
  assert.equal($('commit-btn').disabled, true, 'still not committable in demo mode');
  assert.match($('counts').textContent, /واژه/);

  pressKey('KeyS', { ctrlKey: true, key: 's' });
  await until(() => $('toast').className.includes('show'), 'the demo toast');
  assert.match($('toast').textContent, /حالت نمایشی/);
  assert.ok($('toast').className.includes('warn'));

  click($('mode-preview'));
  assert.equal($('editor-pane').hidden, true);
  assert.equal($('preview-pane').hidden, false);
  assert.match($('preview').innerHTML, /<h1[^>]*>/, 'the preview must render the heading');
  assert.match($('preview').innerHTML, /<table/, '…and the demo document’s table');
  click($('mode-edit'));
  assert.equal($('preview-pane').hidden, true);
});

test('demo: leaving the demo returns to the login card and clears the editor', async () => {
  click($('demo-login'));
  await until(() => $('login-view').hidden === false, 'the login card');
  assert.equal($('app-view').hidden, true);
  assert.equal(document.body.classList.contains('demo'), false);
  assert.equal($('editor').value, '');
  assert.equal($('demo-banner').hidden, true);
  // Stale header state would show the old filename (and a dirty dot) after the
  // next login, before any file is open.
  assert.equal($('path-label').textContent, '');
  assert.equal($('dirty-dot').hidden, true);
});

test('toolbar: formatting reaches the textarea through the real handlers', async () => {
  // The demo is over; drive the editor directly, as the real flow would.
  click($('demo-btn'));
  await until(() => $('path-label').textContent === DEMO_START_FILE, 'the demo file again');

  const ed = $('editor');
  ed.value = 'سلام دنیا';
  ed.dispatchEvent(new window.Event('input', { bubbles: true }));
  ed.focus();
  ed.setSelectionRange(0, 4);                  // «سلام»
  click(document.querySelector('[data-action="bold"]'));
  assert.equal(ed.value, '**سلام** دنیا');
  assert.equal($('dirty-dot').hidden, false);
});
