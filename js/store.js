/**
 * store.js — localStorage / sessionStorage helpers.
 *
 * Key policy:
 *   mded.token      -> sessionStorage by default ("this tab only"),
 *                      localStorage only if the user ticks "remember".
 *   mded.prefs      -> localStorage (theme, layout, last file, expanded dirs)
 *   mded.draft:*    -> localStorage (crash recovery, keyed per file)
 */

const P = 'mded.';

/* ---------------------------------------------------------------- token */

export const token = {
  get() {
    return sessionStorage.getItem(P + 'token') || localStorage.getItem(P + 'token') || '';
  },
  set(value, remember) {
    this.clear();
    if (remember) localStorage.setItem(P + 'token', value);
    else sessionStorage.setItem(P + 'token', value);
  },
  clear() {
    sessionStorage.removeItem(P + 'token');
    localStorage.removeItem(P + 'token');
  },
  isRemembered() {
    return !!localStorage.getItem(P + 'token');
  },
};

/* ---------------------------------------------------------------- prefs */

const DEFAULT_PREFS = {
  theme: 'auto',        // auto | light | dark
  view: 'edit',         // edit | preview | split
  sidebar: true,        // sidebar visible
  onlyMarkdown: true,   // tree filter
  sidebarWidth: 300,
  last: null,           // { owner, repo, branch, path }
  expanded: [],         // expanded directory paths for the current repo
};

export const prefs = {
  get() {
    try {
      return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(P + 'prefs') || '{}') };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  },
  set(patch) {
    const next = { ...this.get(), ...patch };
    localStorage.setItem(P + 'prefs', JSON.stringify(next));
    return next;
  },
};

/* --------------------------------------------------------------- drafts */

const draftKey = (owner, repo, branch, path) =>
  `${P}draft:${owner}/${repo}/${branch}/${path}`;

export const drafts = {
  save(owner, repo, branch, path, text, baseSha) {
    if (!text) return this.remove(owner, repo, branch, path);
    try {
      localStorage.setItem(
        draftKey(owner, repo, branch, path),
        JSON.stringify({ text, baseSha, savedAt: Date.now() }),
      );
    } catch {
      /* quota exceeded: drop the oldest draft and try once more */
      this.prune();
      try {
        localStorage.setItem(
          draftKey(owner, repo, branch, path),
          JSON.stringify({ text, baseSha, savedAt: Date.now() }),
        );
      } catch { /* give up silently — the editor stays usable */ }
    }
  },
  get(owner, repo, branch, path) {
    try {
      return JSON.parse(localStorage.getItem(draftKey(owner, repo, branch, path)) || 'null');
    } catch {
      return null;
    }
  },
  remove(owner, repo, branch, path) {
    localStorage.removeItem(draftKey(owner, repo, branch, path));
  },
  prune(keep = 20) {
    const keys = Object.keys(localStorage)
      .filter((k) => k.startsWith(P + 'draft:'))
      .map((k) => [k, JSON.parse(localStorage.getItem(k) || '{}').savedAt || 0])
      .sort((a, b) => a[1] - b[1]);
    keys.slice(0, Math.max(0, keys.length - keep)).forEach(([k]) => localStorage.removeItem(k));
  },
};
