// tests/browser-harness.mjs — shared plumbing for the optional browser suites
// (tests/editor.browser.mjs and tests/app.browser.mjs).
//
// These suites are NOT part of `npm test`: they need puppeteer and a real
// browser engine, because CodeMirror measures the DOM (it cannot run under
// jsdom — verified) and because wrapping, gutters and per-line bidi are
// geometry, which only a real layout engine can answer.
//
//   npm install puppeteer            # ~1 download, not a runtime dependency
//   npm run serve                    # static server on :8080, no build step
//   npm run test:browser
//
// Two environment overrides, both for CI images that ship their own tooling:
//   CHROME_PATH=/path/to/chrome        use that browser binary
//   PUPPETEER_MODULE=/path/to/puppeteer.mjs   import puppeteer from there
//     instead of node_modules (a globally installed copy, for instance)

import assert from 'node:assert/strict';

export const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch a browser, or skip the suite with a readable explanation. */
export async function launchBrowser() {
  let puppeteer;
  try {
    ({ default: puppeteer } = await import(process.env.PUPPETEER_MODULE || 'puppeteer'));
  } catch {
    console.log('SKIP: puppeteer is not installed.  npm install puppeteer');
    process.exit(0);
  }
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    protocolTimeout: 60000,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      // software GL: the sandbox/CI images this runs in have no GPU. Ignored by
      // real desktops.
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-features=Vulkan', '--ozone-platform=headless', '--no-zygote',
      '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--disable-extensions', '--disable-background-networking',
      '--disable-component-update', '--metrics-recording-only',
    ],
  });
}

/** Fail early (and loudly) when the static server is not up. */
export async function requireServer() {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(4000) });
    assert.ok(res.ok, `HTTP ${res.status}`);
  } catch (err) {
    console.error(`Cannot reach ${BASE} (${err.message}).\n`
      + 'Start the static server first:  npm run serve   # python3 -m http.server 8080');
    process.exit(2);
  }
}

/** A tiny check collector, so every suite reports the same way. */
export function collector() {
  const results = [];
  return {
    check(name, ok, detail = '') { results.push([!!ok, name, String(detail ?? '')]); },
    report(label) {
      let bad = 0;
      for (const [ok, name, detail] of results) {
        if (!ok) bad++;
        console.log(`${ok ? '  PASS  ' : '  FAIL  '}${name}${ok || !detail ? '' : '\n           -> ' + detail}`);
      }
      console.log(`\n${results.length - bad}/${results.length} ${label} passed`);
      return bad;
    },
  };
}
