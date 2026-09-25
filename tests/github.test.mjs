// tests/github.test.mjs — pure logic in js/github.mjs: encoding, line endings,
// path encoding, and the fetch error mapping (with fetch stubbed).
//
//   npm install && npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64encode, b64decode, detectNewline, normalizeToLF, applyNewline,
  stripBOM, hasBOM, isLFSPointer, apiPath, GitHub, GitHubError,
} from '../js/github.mjs';

// ------------------------------------------------------------------- base64
test('b64 round-trips plain ASCII', () => {
  assert.equal(b64decode(b64encode('hello')), 'hello');
});

test('b64 round-trips Persian (UTF-8 multi-byte)', () => {
  const s = 'سلام دنیا — یادداشت‌ها ۱۲۳';
  assert.equal(b64decode(b64encode(s)), s);
});

test('b64encode matches the documented GitHub base64 for Persian text', () => {
  // printf 'سلام' | base64
  assert.equal(b64encode('سلام'), '2LPZhNin2YU=');
});

test('b64 round-trips emoji and astral characters', () => {
  const s = 'a😀b🇮🇷c';
  assert.equal(b64decode(b64encode(s)), s);
});

test('b64decode tolerates the 60-column wrapping GitHub returns', () => {
  const s = 'x'.repeat(200) + 'سلام';
  const wrapped = b64encode(s).replace(/(.{60})/g, '$1\n');
  assert.ok(wrapped.includes('\n'), 'test setup should actually wrap');
  assert.equal(b64decode(wrapped), s);
});

test('b64 round-trips a large document without blowing the stack', () => {
  const s = 'پاراگراف فارسی. '.repeat(20000);   // ~360 KB
  assert.equal(b64decode(b64encode(s)), s);
});

test('b64 round-trips the empty string', () => {
  assert.equal(b64decode(b64encode('')), '');
});

// ----------------------------------------------------- line endings and BOM
test('detectNewline returns CRLF only when it is a strict majority', () => {
  assert.equal(detectNewline('a\r\nb\r\nc\r\n'), '\r\n');
  assert.equal(detectNewline('a\nb\nc\n'), '\n');
  // CRLF must be a strict majority. A tie (1 CRLF vs 1 lone LF) therefore
  // falls back to LF, which is the safer default for a mixed file.
  assert.equal(detectNewline('a\r\nb\nc'), '\n');
  assert.equal(detectNewline('a\nb\r\nc\nd'), '\n');
  assert.equal(detectNewline('a\r\nb\r\nc'), '\r\n');
  assert.equal(detectNewline('no newlines'), '\n');
});

test('applyNewline converts LF -> CRLF and back', () => {
  assert.equal(applyNewline('a\nb\n', '\r\n'), 'a\r\nb\r\n');
  assert.equal(applyNewline('a\r\nb\r\n', '\n'), 'a\nb\n');
});

test('applyNewline does not double up carriage returns', () => {
  assert.equal(applyNewline('a\r\nb', '\r\n'), 'a\r\nb');
  assert.equal(applyNewline('a\rb', '\n'), 'a\nb');
});

test('BOM helpers', () => {
  const withBom = '\uFEFFسلام';
  assert.equal(hasBOM(withBom), true);
  assert.equal(hasBOM('سلام'), false);
  assert.equal(stripBOM(withBom), 'سلام');
  assert.equal(stripBOM('سلام'), 'سلام');
  assert.equal(hasBOM(''), false);
});

test('CRLF file survives a load/save round trip byte-for-byte', () => {
  const original = '# عنوان\r\n\r\nمتن\r\n';
  const body = stripBOM(original);
  const nl = detectNewline(body);
  const edited = normalizeToLF(body).replace('متن', 'متن تازه');
  const saved = applyNewline(edited, nl);
  assert.equal(saved, '# عنوان\r\n\r\nمتن تازه\r\n');
  assert.ok(!saved.includes('\r\r'), 'no doubled CR');
});

// ---------------------------------------------------------------- LFS check
test('isLFSPointer detects a pointer file', () => {
  assert.equal(isLFSPointer(
    'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n'), true);
  assert.equal(isLFSPointer('# version https://git-lfs.github.com/spec/v1'), false);
  assert.equal(isLFSPointer('# عنوان'), false);
  assert.equal(isLFSPointer(''), false);
});

// ------------------------------------------------------------- path encoding
test('apiPath encodes segments but never the slashes', () => {
  assert.equal(apiPath('notes/foo.md'), 'notes/foo.md');
  assert.equal(apiPath('یادداشت‌ها/جلسه ۱۴۰۳.md'),
    encodeURIComponent('یادداشت‌ها') + '/' + encodeURIComponent('جلسه ۱۴۰۳.md'));
  assert.ok(!apiPath('a/b').includes('%2F'), 'slashes must survive');
});

test('apiPath encodes characters that would break a URL', () => {
  assert.equal(apiPath('a b/c#d.md'), 'a%20b/c%23d.md');
  assert.equal(apiPath('100%.md'), '100%25.md');
});

// ------------------------------------------------------- fetch error mapping
function stubFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return responder(url, opts, calls.length);
  };
  return calls;
}
const resp = (status, body = {}, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('401 maps to a re-auth message', async () => {
  stubFetch(() => resp(401, { message: 'Bad credentials' }));
  await assert.rejects(() => new GitHub('t').user(),
    (e) => e instanceof GitHubError && e.status === 401);
});

test('403 with x-ratelimit-remaining: 0 is reported as rate limiting', async () => {
  stubFetch(() => resp(403, { message: 'API rate limit exceeded' },
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '4102444800' }));
  await assert.rejects(() => new GitHub('t').user(), (e) => {
    assert.equal(e.status, 403);
    assert.equal(e.rateLimited, true);
    assert.ok(/سقف/.test(e.message));
    return true;
  });
});

test('403 without rate-limit exhaustion is reported as forbidden', async () => {
  stubFetch(() => resp(403, { message: 'Resource not accessible' },
    { 'x-ratelimit-remaining': '4999' }));
  await assert.rejects(() => new GitHub('t').user(),
    (e) => e.status === 403 && !e.rateLimited);
});

test('409 (conflict / empty repo) is distinguished', async () => {
  stubFetch(() => resp(409, { message: 'Conflict' }));
  await assert.rejects(() => new GitHub('t').user(), (e) => e.status === 409);
});

test('5xx is marked retryable', async () => {
  stubFetch(() => resp(502, { message: 'Bad Gateway' }));
  await assert.rejects(() => new GitHub('t').user(), (e) => e.retryable === true);
});

test('network failure becomes a friendly error, not a raw TypeError', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => new GitHub('t').user(),
    (e) => e instanceof GitHubError && e.status === 0);
});

test('every request sends the bearer token and the pinned API version', async () => {
  const calls = stubFetch(() => resp(200, { login: 'me' }));
  await new GitHub('SECRET').user();
  const h = calls[0].opts.headers;
  assert.equal(h['Authorization'], 'Bearer SECRET');
  assert.equal(h['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(h['Accept'], 'application/vnd.github+json');
  assert.ok(!JSON.stringify(calls[0]).includes('token='), 'token must not appear in the URL');
});

test('onRateLimit callback receives the headers', async () => {
  stubFetch(() => resp(200, { login: 'me' },
    { 'x-ratelimit-remaining': '42', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1700000000' }));
  const gh = new GitHub('t');
  let seen = null;
  gh.onRateLimit = (...a) => { seen = a; };
  await gh.user();
  assert.deepEqual(seen, [42, 5000, 1700000000]);
});

// ------------------------------------------------------------- readFile logic
test('readFile decodes base64 for normal files and returns the sha', async () => {
  const sha = 'abc123';
  stubFetch(() => resp(200, {
    type: 'file', encoding: 'base64', sha, size: 9,
    content: b64encode('سلام دنیا'),
  }));
  const r = await new GitHub('t').readFile('o', 'r', 'f.md', 'main');
  assert.equal(r.text, 'سلام دنیا');
  assert.equal(r.sha, sha);
});

test('readFile falls back to the raw media type when content is empty (1-100 MB)', async () => {
  const sha = 'def456';
  const calls = stubFetch((url, opts) => {
    if (opts?.headers?.Accept === 'application/vnd.github.raw+json') {
      return resp(200, 'متن بزرگ');
    }
    return resp(200, { type: 'file', encoding: 'none', sha, size: 2_000_000, content: '' });
  });
  const r = await new GitHub('t').readFile('o', 'r', 'big.md', 'main');
  assert.equal(r.text, 'متن بزرگ');
  assert.equal(r.sha, sha, 'sha still comes from the metadata call');
  assert.equal(calls.length, 2);
});

test('readFile refuses a directory', async () => {
  stubFetch(() => resp(200, { type: 'dir' }));
  await assert.rejects(() => new GitHub('t').readFile('o', 'r', 'd', 'main'),
    (e) => e.status === 422);
});

test('writeFile omits sha when creating and includes it when updating', async () => {
  const calls = stubFetch(() => resp(200, { content: { sha: 'new' }, commit: { html_url: 'u' } }));
  const gh = new GitHub('t');
  await gh.writeFile('o', 'r', 'a.md', { text: 'x', message: 'm', branch: 'main' });
  let body = JSON.parse(calls[0].opts.body);
  assert.equal(body.sha, undefined, 'create must not send a sha');
  assert.equal(body.content, b64encode('x'));
  assert.equal(body.branch, 'main');

  await gh.writeFile('o', 'r', 'a.md', { text: 'y', message: 'm', sha: 'old', branch: 'main' });
  body = JSON.parse(calls[1].opts.body);
  assert.equal(body.sha, 'old', 'update must send the current sha');
  assert.equal(calls[1].opts.method, 'PUT');
});

test('writeFile base64-encodes Persian content correctly', async () => {
  const calls = stubFetch(() => resp(200, { content: { sha: 'n' } }));
  await new GitHub('t').writeFile('o', 'r', 'a.md', { text: 'سلام' });
  assert.equal(JSON.parse(calls[0].opts.body).content, '2LPZhNin2YU=');
});

test('URLs percent-encode Persian paths in contents and tree calls', async () => {
  const calls = stubFetch(() => resp(200, { type: 'file', encoding: 'base64', sha: 's', content: '' }));
  await new GitHub('t').readFile('me', 'notes', 'یادداشت‌ها/جلسه.md', 'main');
  assert.ok(calls[0].url.includes(encodeURIComponent('یادداشت‌ها')));
  assert.ok(calls[0].url.includes('/contents/'));
  assert.ok(!calls[0].url.includes('%2F'));
});


