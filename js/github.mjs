// js/github.mjs — everything that talks to api.github.com, plus the encoding
// and line-ending helpers. No DOM access in this file, so it is unit-testable.

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export class GitHubError extends Error {
  constructor(status, message, meta = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    Object.assign(this, meta);
  }
}

// --------------------------------------------------------------------- base64
// Not btoa(unescape(encodeURIComponent(x))): `unescape` is deprecated Annex B
// and the pattern builds several full copies of the string.

export function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64decode(b64) {
  // The contents API returns base64 wrapped at 60 columns.
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// --------------------------------------------------------- line endings / BOM
// Preserve whatever the file already uses, otherwise saving rewrites every line
// and the commit diffs as 100% changed.

export function detectNewline(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

export function normalizeToLF(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function applyNewline(text, newline) {
  return newline === '\r\n' ? normalizeToLF(text).replace(/\n/g, '\r\n') : normalizeToLF(text);
}

const BOM = '\uFEFF';
export function stripBOM(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}
export function hasBOM(text) {
  return text.charCodeAt(0) === 0xFEFF;
}

// Git LFS pointer files are ~130 bytes of text that will happily open in the
// editor and destroy the real asset if you save over them.
export function isLFSPointer(text) {
  return /^version https:\/\/git-lfs\.github\.com\/spec\/v1\b/.test(text);
}

// ------------------------------------------------------------------- fetching
export class GitHub {
  #token;
  onRateLimit = null;   // (remaining, limit, resetEpochSeconds) => void

  constructor(token) { this.#token = token; }

  #headers(accept = 'application/vnd.github+json') {
    const h = {
      'Authorization': `Bearer ${this.#token}`,
      'Accept': accept,
      'X-GitHub-Api-Version': API_VERSION,
    };
    return h;
  }

  #noteRate(res) {
    // A missing header must mean "no info", NOT zero. (Number(null) is 0,
    // which would flash a false "rate limit exhausted" warning.)
    const raw = res.headers.get('x-ratelimit-remaining');
    if (raw === null) return;
    const remaining = Number(raw);
    const limit = Number(res.headers.get('x-ratelimit-limit'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(remaining) && this.onRateLimit) {
      this.onRateLimit(remaining, limit, reset);
    }
  }

  async request(path, { method = 'GET', accept, body } = {}) {
    const headers = this.#headers(accept);
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // fetch rejects on network failure; CORS errors look the same.
      throw new GitHubError(0, 'اتصال به GitHub برقرار نشد. اتصال اینترنت را بررسی کنید.');
    }
    this.#noteRate(res);

    if (res.status === 204) return null;

    if (res.status === 401) {
      throw new GitHubError(401, 'توکن نامعتبر یا منقضی است. دوباره وارد شوید.');
    }
    if (res.status === 403) {
      const remaining = Number(res.headers.get('x-ratelimit-remaining'));
      if (remaining === 0) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const when = Number.isFinite(reset)
          ? new Date(reset * 1000).toLocaleTimeString('fa-IR')
          : 'بعداً';
        throw new GitHubError(403, `سقف درخواست‌های GitHub پر شده است. ساعت ${when} دوباره تلاش کنید.`,
          { rateLimited: true, reset });
      }
      throw new GitHubError(403, await this.#msg(res, 'دسترسی ندارید (توکن یا محافظت از شاخه).'));
    }
    if (res.status === 404) {
      throw new GitHubError(404, await this.#msg(res, 'پیدا نشد (مسیر یا شاخه اشتباه است).'));
    }
    if (res.status === 409) {
      throw new GitHubError(409, await this.#msg(res, 'تعارض: فایل تغییر کرده یا مخزن خالی است.'));
    }
    if (res.status === 422) {
      throw new GitHubError(422, await this.#msg(res, 'درخواست نامعتبر است.'));
    }
    if (res.status >= 500) {
      throw new GitHubError(res.status, 'خطای سمت GitHub. دوباره تلاش کنید.', { retryable: true });
    }
    if (!res.ok) {
      throw new GitHubError(res.status, await this.#msg(res, `خطای ${res.status}`));
    }
    return res;
  }

  async #msg(res, fallback) {
    try {
      const j = await res.json();
      return j.message ? `${fallback} (${j.message})` : fallback;
    } catch { return fallback; }
  }

  async json(path, opts) {
    const res = await this.request(path, opts);
    return res === null ? null : res.json();
  }

  // ------------------------------------------------------------- endpoints
  async user() {
    return this.json('/user');
  }

  async repos({ page = 1 } = {}) {
    return this.json(`/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`);
  }

  async repo(owner, name) {
    return this.json(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  }

  async branches(owner, name) {
    return this.json(`/repos/${enc(owner)}/${enc(name)}/branches?per_page=100`);
  }

  async tree(owner, name, ref) {
    return this.json(`/repos/${enc(owner)}/${enc(name)}/git/trees/${enc(ref)}?recursive=1`);
  }

  /**
   * Read a file. Handles the 1 MB boundary: the JSON contents endpoint returns
   * full features up to 1 MB; from 1-100 MB you must ask for the raw media type.
   */
  async readFile(owner, name, path, ref) {
    const base = `/repos/${enc(owner)}/${enc(name)}/contents/${apiPath(path)}`;
    const q = ref ? `?ref=${enc(ref)}` : '';

    const meta = await this.json(base + q);
    if (meta.type !== 'file') {
      throw new GitHubError(422, 'این مسیر یک فایل نیست.');
    }
    if (meta.encoding === 'base64' && meta.content) {
      return { text: b64decode(meta.content), sha: meta.sha, size: meta.size, encoding: 'base64' };
    }
    // encoding === 'none' for 1-100 MB files (and binary blobs).
    const res = await this.request(base + q, { accept: 'application/vnd.github.raw+json' });
    return { text: await res.text(), sha: meta.sha, size: meta.size, encoding: 'none' };
  }

  /**
   * Create or update a file. Omit `sha` to create.
   * Returns the response body — the caller MUST take `content.sha` from it.
   */
  async writeFile(owner, name, path, { text, message, sha, branch }) {
    const body = { message, content: b64encode(text) };
    if (sha) body.sha = sha;
    if (branch) body.branch = branch;
    return this.json(
      `/repos/${enc(owner)}/${enc(name)}/contents/${apiPath(path)}`,
      { method: 'PUT', body }
    );
  }
}

/** Percent-encode each path segment; never the slashes. Persian filenames. */
export function apiPath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}
const enc = encodeURIComponent;

export { API };


