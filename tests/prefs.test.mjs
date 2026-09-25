// tests/prefs.test.mjs — js/prefs.mjs, the one place that reads and writes the
// settings this app remembers between visits.
//
//   npm test  (node --test "tests/*.test.mjs")
//
// The module touches `localStorage` directly, so it is exercised against a real
// jsdom storage rather than a hand-rolled object: what matters is how it behaves
// with the values a browser actually hands back (strings), with nothing stored,
// and with storage that throws (Safari private mode does exactly that).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('', { url: 'https://example.test/' });
globalThis.localStorage = window.localStorage;

const { PREFS, readPref, writePref } = await import('../js/prefs.mjs');

const clear = () => window.localStorage.clear();

test('defaults: wrap on, toolbar off, empty search', () => {
  clear();
  assert.equal(readPref('wrap'), true);
  assert.equal(readPref('toolbar'), false);
  assert.equal(readPref('findQuery'), '');
});

test('the toolbar ships off — the app is a writing surface by default', () => {
  clear();
  assert.equal(PREFS.toolbar.fallback, false);
  assert.equal(readPref('toolbar'), false);
});

test('booleans round-trip as 0/1 and read back as booleans', () => {
  clear();
  for (const name of ['wrap', 'toolbar']) {
    writePref(name, false);
    assert.equal(window.localStorage.getItem(PREFS[name].key), '0', name);
    assert.equal(readPref(name), false, name);
    writePref(name, true);
    assert.equal(window.localStorage.getItem(PREFS[name].key), '1', name);
    assert.equal(readPref(name), true, name);
  }
});

test('"0", "false" and any other value are read the way a user would expect', () => {
  clear();
  // Boolean('0') is true — the trap a naive reader falls into.
  window.localStorage.setItem(PREFS.toolbar.key, '0');
  assert.equal(readPref('toolbar'), false);
  window.localStorage.setItem(PREFS.toolbar.key, 'false');
  assert.equal(readPref('toolbar'), false);
  window.localStorage.setItem(PREFS.toolbar.key, 'true');
  assert.equal(readPref('toolbar'), true);
  window.localStorage.setItem(PREFS.toolbar.key, '');
  assert.equal(readPref('toolbar'), true, 'an empty string is not "off"');
});

test('the search query is stored verbatim, Persian and all', () => {
  clear();
  const query = 'واژهٔ آزمایشی — ۱۲۳';
  writePref('findQuery', query);
  assert.equal(window.localStorage.getItem(PREFS.findQuery.key), query);
  assert.equal(readPref('findQuery'), query);
  writePref('findQuery', '');
  assert.equal(readPref('findQuery'), '', 'clearing the search clears the memory');
});

test('an unknown pref name is a programming error, not a silent default', () => {
  assert.throws(() => readPref('nope'), /unknown pref/);
  assert.throws(() => writePref('nope', 1), /unknown pref/);
});

test('storage that throws does not take the app down', () => {
  clear();
  const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: storage is disabled'); },
  });
  try {
    assert.equal(readPref('wrap'), true, 'falls back to the default');
    assert.doesNotThrow(() => writePref('toolbar', true), 'and writing stays quiet');
  } finally {
    Object.defineProperty(window, 'localStorage', real);
  }
});

test('keys are namespaced enough to be recognisable, and never secret', () => {
  for (const [name, pref] of Object.entries(PREFS)) {
    assert.match(pref.key, /^[a-z_]+$/, name);
    assert.doesNotMatch(pref.key, /token|secret|ghp_|github_pat/i, name);
  }
});
