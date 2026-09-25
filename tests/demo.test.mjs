// tests/demo.test.mjs — the demo transport must be a drop-in for the real one.
//
// app.mjs calls S.gh.repos()/repo()/branches()/tree()/readFile() the same way in
// both sessions, so DemoGitHub has to keep that surface. If someone renames a
// method on GitHub, this test is the thing that notices.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GitHub, GitHubError } from '../js/github.mjs';
import {
  DemoGitHub, DEMO_FILES, DEMO_REPO, DEMO_BRANCH, DEMO_START_FILE, demoSha,
} from '../js/demo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const onDisk = (p) => path.join(ROOT, ...String(p).split('/'));

// In the browser the default loader is a same-origin fetch(path); Node has no
// document to resolve a relative URL against, so tests inject an fs loader.
const demoGH = (opts = {}) => new DemoGitHub({
  load: async (p) => readFileSync(onDisk(p), 'utf8'),
  ...opts,
});

test('surface parity: every method app.mjs calls exists on both clients', () => {
  const demo = demoGH();
  for (const m of ['user', 'repos', 'repo', 'branches', 'tree', 'readFile', 'writeFile']) {
    assert.equal(typeof GitHub.prototype[m], 'function', `GitHub.${m} missing`);
    assert.equal(typeof demo[m], 'function', `DemoGitHub.${m} missing`);
  }
  assert.equal(demo.onRateLimit, null, 'the demo must not report a rate limit');
});

test('every demo file in the tree exists in /demo on disk', () => {
  for (const p of DEMO_FILES) {
    assert.ok(existsSync(onDisk(p)), `${p} is listed in the tree but missing on disk`);
  }
  assert.ok(DEMO_FILES.includes(DEMO_START_FILE), 'the start file must be in the tree');
});

test('tree entries look like blob entries the sidebar can render', async () => {
  const { tree, truncated } = await demoGH().tree();
  assert.equal(truncated, false);
  assert.equal(tree.length, DEMO_FILES.length);
  for (const e of tree) {
    assert.equal(e.type, 'blob');
    assert.equal(e.mode, '100644');
    assert.match(e.sha, /^demo[0-9a-f]{8}0+$/);
  }
});

test('readFile returns the real document text and a stable sha', async () => {
  const gh = demoGH();
  const first = await gh.readFile(DEMO_REPO.owner, DEMO_REPO.name, DEMO_START_FILE);
  const again = await gh.readFile(DEMO_REPO.owner, DEMO_REPO.name, DEMO_START_FILE);
  assert.equal(first.sha, demoSha(DEMO_START_FILE));
  assert.equal(first.sha, again.sha, 'shas must not change between reads');
  assert.equal(first.text, readFileSync(onDisk(DEMO_START_FILE), 'utf8'));
  assert.match(first.text, /نسخهٔ نمایشی/);
  assert.ok(!first.text.includes('\uFEFF'), 'no BOM in the fixtures');
});

test('readFile surfaces a missing document as a GitHubError', async () => {
  const gh = new DemoGitHub({ load: async () => { throw new GitHubError(404, 'پیدا نشد.'); } });
  await assert.rejects(
    () => gh.readFile(DEMO_REPO.owner, DEMO_REPO.name, 'demo/nope.md'),
    (err) => err instanceof GitHubError && err.status === 404);
});

test('writeFile always refuses: the demo can edit, never save', async () => {
  // app.mjs disables the commit button in demo mode; this is the second lock, so
  // a stray Ctrl+S can never reach the real API with a fixture path.
  await assert.rejects(
    () => demoGH().writeFile(DEMO_REPO.owner, DEMO_REPO.name, DEMO_START_FILE, {
      text: 'x', message: 'm', branch: DEMO_BRANCH,
    }),
    (err) => err instanceof GitHubError && err.status === 403 && /حالت نمایشی/.test(err.message));
});

test('repo + branch fixtures agree with each other', async () => {
  const gh = demoGH();
  const repo = await gh.repo(DEMO_REPO.owner, DEMO_REPO.name);
  assert.equal(repo.default_branch, DEMO_BRANCH);
  const branches = await gh.branches(DEMO_REPO.owner, DEMO_REPO.name);
  assert.deepEqual(branches.map((b) => b.name), [DEMO_BRANCH]);
  const repos = await gh.repos();
  assert.equal(repos[0].full_name, DEMO_REPO.full_name);
});
