// js/demo.mjs — the token-free demo session.
//
// DemoGitHub deliberately mirrors the surface of GitHub (js/github.mjs):
// user(), repos(), repo(), branches(), tree(), readFile(), writeFile() and an
// `onRateLimit` field. app.mjs therefore needs no demo-specific branching in
// the tree/editor/preview/find paths — the same code runs, only the transport
// is replaced. The one thing it must NOT do is write: writeFile() throws.
//
// The documents live in /demo as ordinary files, so they are also readable
// straight from the repo (and on GitHub Pages, where the app is served).

import { GitHubError } from './github.mjs';

export const DEMO_USER = { login: 'نمونه', name: 'حالت نمایشی', avatar_url: '' };

export const DEMO_REPO = {
  owner: DEMO_USER.login,
  name: 'notes',
  full_name: `${DEMO_USER.login}/notes`,
  default_branch: 'main',
  private: false,
  archived: false,
  fork: false,
  pushed_at: null,
};

export const DEMO_BRANCH = 'main';

/** The tree, in the order the sidebar would show it. Every path must exist in /demo. */
export const DEMO_FILES = [
  'demo/شروع.md',
  'demo/فرمت‌دهی.md',
  'demo/English-notes.md',
  'demo/آرشیو/۱۴۰۴.md',
  'demo/notes.txt',
];

/** The file opened when the demo starts. */
export const DEMO_START_FILE = 'demo/شروع.md';

/** Stable fake shas: openFile() compares them, nothing displays them. */
export function demoSha(path) {
  let h = 2166136261;
  for (const ch of String(path)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return 'demo' + (h >>> 0).toString(16).padStart(8, '0') + '000000000000000000000000';
}

/** Default loader: same-origin fetch, so a GitHub Pages subpath keeps working. */
async function fetchText(path) {
  let res;
  try {
    res = await fetch(path, { cache: 'no-store' });
  } catch {
    throw new GitHubError(0, `فایل نمایشی «${path}» بارگذاری نشد.`);
  }
  if (!res.ok) throw new GitHubError(res.status, `فایل نمایشی «${path}» پیدا نشد.`);
  return res.text();
}

export class DemoGitHub {
  onRateLimit = null;                 // never fires: there is no rate limit here
  #load;
  #cache = new Map();

  /** @param {{load?: (path: string) => Promise<string>}} [opts] injectable for tests */
  constructor({ load } = {}) {
    this.#load = load || fetchText;
  }

  async user() { return { ...DEMO_USER }; }

  async repos() { return [{ ...DEMO_REPO }]; }

  async repo() {
    return { owner: { login: DEMO_REPO.owner }, name: DEMO_REPO.name, default_branch: DEMO_BRANCH };
  }

  async branches() { return [{ name: DEMO_BRANCH }]; }

  async tree() {
    return {
      truncated: false,
      tree: DEMO_FILES.map(path => ({
        path, type: 'blob', mode: '100644', sha: demoSha(path), size: 0,
      })),
    };
  }

  async readFile(_owner, _name, path) {
    const text = await this.#text(path);
    return { text, sha: demoSha(path), size: text.length, encoding: 'utf8' };
  }

  async writeFile() {
    throw new GitHubError(403, 'حالت نمایشی است؛ برای ثبت تغییرات باید با توکن وارد شوید.');
  }

  async #text(path) {
    if (!this.#cache.has(path)) this.#cache.set(path, await this.#load(path));
    return this.#cache.get(path);
  }
}
