/**
 * api.js — GitHub REST client.
 *
 * Every request goes through gh(). Nothing in this file ever logs a request
 * object or a header, so the token cannot leak into the console by accident.
 */

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message || `GitHub API error ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
  get isAuth() { return this.status === 401 || this.status === 403 && /token|credential/i.test(this.message); }
  get isRateLimit() { return this.status === 403 || this.status === 429; }
  get isConflict() { return this.status === 409 || this.status === 422; }
  get isNotFound() { return this.status === 404; }
}

let token = '';
const listeners = { unauthorized: [], rate: [] };

export function setToken(t) { token = t; }
export function getToken() { return token; }
export function on(name, fn) { (listeners[name] ||= []).push(fn); }
const emit = (name, arg) => (listeners[name] || []).forEach((fn) => fn(arg));

/* --------------------------------------------------------------- helpers */

/** Percent-encode each path segment; never the slashes, never the query. */
export const apiPath = (p) => String(p).split('/').map(encodeURIComponent).join('/');

export function textToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToText(b64) {
  const bin = atob(String(b64).replace(/\s+/g, '')); // the API wraps content at 60 chars
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

const looksBinary = (text) => /[\u0000-\u0008\u000E-\u001F\uFFFD]/.test(text.slice(0, 8000));
const isLfsPointer = (text) => /^version https:\/\/git-lfs\.github\.com\/spec\/v1/.test(text.trim());

/* ------------------------------------------------------------- transport */

async function gh(path, { method = 'GET', body, accept, raw = false } = {}) {
  const headers = {
    Accept: accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(0, 'شبکه در دسترس نیست — اتصال اینترنت را بررسی کنید.');
  }

  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining !== null) {
    emit('rate', {
      remaining: Number(remaining),
      limit: Number(res.headers.get('x-ratelimit-limit') || 0),
      reset: Number(res.headers.get('x-ratelimit-reset') || 0) * 1000,
    });
  }

  if (res.status === 401 && token) {
    emit('unauthorized');
    throw new ApiError(401, 'توکن نامعتبر یا منقضی شده است.');
  }

  if (!res.ok) {
    let msg = res.statusText;
    let payload = null;
    try {
      payload = await res.json();
      if (payload && payload.message) msg = payload.message;
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, msg, payload);
  }

  if (res.status === 204) return null;
  return raw ? res.text() : res.json();
}

/** Follow Link: rel="next" up to `maxPages` pages. */
async function ghPaged(path, maxPages = 5) {
  const first = await fetch(API + path, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!first.ok) throw new ApiError(first.status, first.statusText);
  const out = await first.json();
  let url = (first.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/);
  let page = 1;
  while (url && page < maxPages) {
    const res = await fetch(url[1], {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) break;
    out.push(...(await res.json()));
    url = (res.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/);
    page += 1;
  }
  return out;
}

/* -------------------------------------------------------------- endpoints */

export const user = () => gh('/user');

export const listRepos = () =>
  ghPaged('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');

export const getRepo = (owner, repo) => gh(`/repos/${apiPath(owner + '/' + repo)}`);

export const listBranches = (owner, repo) =>
  ghPaged(`/repos/${owner}/${repo}/branches?per_page=100`, 2);

export const getTree = (owner, repo, branch) =>
  gh(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);

/** Metadata-only read: what is the current blob sha of this file? */
export async function remoteSha(owner, repo, path, ref) {
  try {
    const j = await gh(
      `/repos/${owner}/${repo}/contents/${apiPath(path)}?ref=${encodeURIComponent(ref)}`,
    );
    return Array.isArray(j) ? null : j.sha;
  } catch (err) {
    if (err instanceof ApiError && err.isNotFound) return null;
    throw err;
  }
}

/**
 * Read a text file. Falls back to the raw media type for files between
 * 1 MB and 100 MB, refuses binaries and Git LFS pointers.
 */
export async function getFile(owner, repo, path, ref) {
  const url = `/repos/${owner}/${repo}/contents/${apiPath(path)}?ref=${encodeURIComponent(ref)}`;
  let j = await gh(url);
  if (Array.isArray(j)) throw new ApiError(422, 'این مسیر یک پوشه است، نه فایل.');

  let text = '';
  if (j.encoding === 'base64' && typeof j.content === 'string' && j.content) {
    text = b64ToText(j.content);
  } else if (j.size > 0) {
    // 1–100 MB: content is empty with the default media type -> use raw.
    text = await gh(url, { accept: 'application/vnd.github.raw+json', raw: true });
  }

  if (isLfsPointer(text)) {
    throw new ApiError(415, 'این فایل یک اشاره‌گر Git LFS است و متن واقعی ندارد.');
  }
  if (looksBinary(text)) {
    throw new ApiError(415, 'این فایل باینری به نظر می‌رسد و در ویرایشگر باز نمی‌شود.');
  }

  return { text, sha: j.sha, size: j.size, downloadUrl: j.download_url, htmlUrl: j.html_url };
}

/**
 * Create or update a file. `sha` omitted => create; included => update.
 * Returns { sha, commitUrl } — always refresh your stored sha from this.
 */
export async function putFile(owner, repo, path, { message, content, sha, branch }) {
  const body = { message, content: textToB64(content), branch };
  if (sha) body.sha = sha; // omitting it is how the API distinguishes create from update
  const j = await gh(`/repos/${owner}/${repo}/contents/${apiPath(path)}`, {
    method: 'PUT',
    body,
  });
  return {
    sha: j.content && j.content.sha,
    commitUrl: j.commit && j.commit.html_url,
  };
}
