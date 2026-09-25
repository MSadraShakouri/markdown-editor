// js/app.mjs — the whole application. No framework, no build step.
//
// Loaded as <script type="module"> after the three vendored UMD libraries.

import {
  GitHub, GitHubError, b64encode, b64decode, detectNewline, applyNewline,
  stripBOM, hasBOM, isLFSPointer, apiPath,
} from './github.mjs';
import { renderMarkdown, setRenderContext, splitFrontMatter } from './md.mjs';
import { DemoGitHub, DEMO_START_FILE } from './demo.mjs';

// --------------------------------------------------------------------- state
const S = {
  gh: null,
  user: null,
  repos: [],
  repo: null,          // { owner, name, default_branch, ... }
  branch: null,
  tree: [],            // raw tree entries
  treeTruncated: false,
  expanded: new Set(),
  path: null,
  content: null,       // what the textarea holds
  baseText: null,      // what the server had when we opened/last saved
  sha: null,
  newline: '\n',
  bom: false,
  readOnly: false,
  readOnlyWhy: '',
  dirty: false,
  saving: false,
  mode: 'edit',        // 'edit' | 'preview' | 'split'
  newFile: false,
  demo: false,         // token-free session: everything works except writing
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ------------------------------------------------------------------- storage
// Token defaults to sessionStorage (dies with the tab). "مرا به خاطر بسپار"
// promotes it to localStorage.
const TOKEN_KEY = 'github_token';
const REMEMBER_KEY = 'github_token_remember';

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ''; }
  catch { return ''; }
}
function writeToken(token, remember) {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
    localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
  } catch { /* private mode */ }
}
function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}

const draftKey = () => `draft:${S.repo?.owner}/${S.repo?.name}@${S.branch}:${S.path}`;

function saveDraft() {
  // Nothing in a demo session is worth keeping, and the draft key would be
  // indistinguishable from a real repo's.
  if (!S.path || S.readOnly || S.demo) return;
  try {
    localStorage.setItem(draftKey(), JSON.stringify({
      text: $('editor').value, baseSha: S.sha, savedAt: Date.now(),
    }));
  } catch {}
}
function readDraft() {
  if (S.demo) return null;
  try {
    const raw = localStorage.getItem(draftKey());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch {}
}

function getJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function setJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// --------------------------------------------------------------------- toast
let toastTimer = null;
function toast(message, kind = 'info', actionLabel, actionFn) {
  const box = $('toast');
  box.textContent = '';
  box.className = `toast show ${kind}`;
  box.appendChild(el('span', 'toast-msg', message));
  if (actionLabel && actionFn) {
    const b = el('button', 'toast-action', actionLabel);
    b.type = 'button';
    b.addEventListener('click', () => { actionFn(); hideToast(); });
    box.appendChild(b);
  }
  // window.setTimeout, not the bare global: the pending timer belongs to this
  // document and must die with it (browsers treat both identically).
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, kind === 'error' ? 9000 : 4500);
}
function hideToast() { $('toast').className = 'toast'; }

// ------------------------------------------------------------------ login UI
async function showLogin(errorMessage) {
  closeMenu();               // a <dialog> would otherwise linger in the top layer
  $('login-view').hidden = false;
  $('app-view').hidden = true;
  document.body.classList.remove('demo');
  $('demo-banner').hidden = true;
  if (errorMessage) {
    $('login-error').textContent = errorMessage;
    $('login-error').hidden = false;
  }
  $('remember').checked = localStorage.getItem(REMEMBER_KEY) === '1';
  $('token-input').focus();
}

async function doLogin() {
  const token = $('token-input').value.trim();
  if (!token) { $('login-error').textContent = 'توکن را وارد کنید.'; $('login-error').hidden = false; return; }
  $('login-btn').disabled = true;
  $('login-error').hidden = true;
  const gh = new GitHub(token);
  try {
    const user = await gh.user();
    writeToken(token, $('remember').checked);
    S.demo = false;
    S.gh = gh;
    S.user = user;
    await enterApp();
  } catch (err) {
    clearToken();
    $('login-error').textContent = err instanceof GitHubError ? err.message : 'ورود ناموفق بود.';
    $('login-error').hidden = false;
  } finally {
    $('login-btn').disabled = false;
  }
}

/** Token-free session: the same app, a fake transport (see js/demo.mjs). */
async function startDemo() {
  const btn = $('demo-btn');
  $('login-error').hidden = true;
  btn.disabled = true;
  try {
    const gh = new DemoGitHub();
    S.demo = true;
    S.gh = gh;
    S.user = await gh.user();
    await enterApp();
  } catch (err) {
    S.demo = false; S.gh = null;
    $('login-error').textContent = err.message || 'اجرای نسخهٔ نمایشی ناموفق بود.';
    $('login-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
}

/** Back to the login card — from a demo session or a real one. */
function logout() {
  clearToken();
  S.demo = false;
  S.gh = null; S.user = null; S.repo = null; S.branch = null; S.tree = [];
  S.path = null; S.sha = null; S.newFile = false; S.readOnly = false;
  S.baseText = ''; S.dirty = false; S.readOnlyWhy = '';
  $('editor').value = '';
  $('path-label').textContent = '';
  $('token-input').value = '';
  // Without this the header kept the previous session's filename and dirty dot,
  // so the next login showed «●» next to a file that is not open.
  updateEditorState();
  showLogin();
}

// ------------------------------------------------------------------- app boot
async function enterApp() {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  $('user-login').textContent = S.user.login;
  const av = $('user-avatar');
  if (S.user.avatar_url) { av.src = S.user.avatar_url; av.alt = S.user.login; av.hidden = false; }
  else { av.removeAttribute('src'); av.hidden = true; }

  document.body.classList.toggle('demo', S.demo);
  $('demo-banner').hidden = !S.demo;

  // Demo: no repo cache, no rate-limit panel, and we land directly in a document
  // so the editor is exercised the moment the button is pressed.
  if (S.demo) {
    await loadRepos(false);
    await openRepo(S.repos[0]);
    await openFile(DEMO_START_FILE);
    return;
  }

  S.gh.onRateLimit = (remaining, limit, reset) => {
    const box = $('ratelimit');
    if (!Number.isFinite(remaining)) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = `درخواست‌های باقی‌مانده: ${remaining.toLocaleString('fa-IR')}`;
    box.classList.toggle('warn', remaining < 200);
  };

  const cached = getJSON('repos_cache', null);
  if (cached?.repos?.length) {
    S.repos = cached.repos;
    renderRepoList();
    $('repo-status').textContent = `کش شده — ${cached.at ? new Date(cached.at).toLocaleString('fa-IR') : ''}`;
  }
  await loadRepos(!cached);
}

async function loadRepos(quiet) {
  $('repo-status').textContent = 'در حال بارگذاری مخزن‌ها…';

  // Never read or write repos_cache in a demo session — it would clobber the
  // real cache of a user who has a token stored.
  if (S.demo) {
    try {
      S.repos = await S.gh.repos();
      renderRepoList();
      $('repo-status').textContent = 'حالت نمایشی — بدون توکن';
    } catch (err) {
      $('repo-status').textContent = '';
      toast(err.message, 'error');
    }
    return;
  }

  try {
    let all = [];
    for (let page = 1; page <= 5; page++) {          // cap at 500 repos
      const batch = await S.gh.repos({ page });
      all = all.concat(batch);
      if (batch.length < 100) break;
    }
    S.repos = all.map(r => ({
      owner: r.owner.login, name: r.name, full_name: r.full_name,
      default_branch: r.default_branch, private: r.private,
      pushed_at: r.pushed_at, archived: r.archived, fork: r.fork,
    })).sort((a, b) => (b.pushed_at || '').localeCompare(a.pushed_at || ''));
    setJSON('repos_cache', { repos: S.repos, at: Date.now() });
    renderRepoList();
    $('repo-status').textContent = `${S.repos.length.toLocaleString('fa-IR')} مخزن`;
  } catch (err) {
    if (err.status === 401) { logout(); return; }
    $('repo-status').textContent = '';
    if (!quiet) toast(err.message || 'بارگذاری مخزن‌ها ناموفق بود.', 'error');
  }
}

// ----------------------------------------------------------------- repo list
function renderRepoList() {
  const q = $('repo-filter').value.trim().toLowerCase();
  const list = $('repo-list');
  list.textContent = '';
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const r of S.repos) {
    if (q && !r.full_name.toLowerCase().includes(q)) continue;
    shown++;
    const b = el('button', 'repo-item');
    b.type = 'button';
    b.dataset.full = r.full_name;
    b.appendChild(el('span', 'repo-name', r.name));
    if (r.owner !== S.user.login) b.appendChild(el('span', 'repo-owner', r.owner));
    if (r.private) b.appendChild(el('span', 'badge', 'خصوصی'));
    if (r.archived) b.appendChild(el('span', 'badge', 'بایگانی'));
    if (S.demo) b.appendChild(el('span', 'badge', 'نمایشی'));
    b.addEventListener('click', () => openRepo(r));
    frag.appendChild(b);
  }
  if (!shown) frag.appendChild(el('div', 'empty', 'مخزنی پیدا نشد.'));
  list.appendChild(frag);
}

// ---------------------------------------------------------------- open a repo
async function openRepo(r) {
  $('repo-list').querySelectorAll('.repo-item').forEach(n =>
    n.classList.toggle('active', n.dataset.full === r.full_name));
  $('file-tree').textContent = '';
  $('tree-status').textContent = 'در حال بارگذاری…';
  try {
    const full = await S.gh.repo(r.owner, r.name);
    S.repo = { owner: full.owner.login, name: full.name, default_branch: full.default_branch };
    S.branch = full.default_branch;
    const br = await S.gh.branches(r.owner, r.name);
    fillBranchSelect(br.map(b => b.name), S.branch);
    await loadTree();
  } catch (err) {
    if (err.status === 401) { logout(); return; }
    $('tree-status').textContent = '';
    toast(err.message, 'error');
  }
}

function fillBranchSelect(names, current) {
  const sel = $('branch-select');
  sel.textContent = '';
  for (const n of names) sel.appendChild(el('option', null, n));
  sel.value = current;
  sel.disabled = names.length === 0;
}

async function loadTree() {
  $('tree-status').textContent = 'در حال بارگذاری…';
  try {
    const t = await S.gh.tree(S.repo.owner, S.repo.name, S.branch);
    S.tree = (t.tree || []).filter(e =>
      e.type === 'blob' && e.mode !== '160000' && e.mode !== '120000');
    S.treeTruncated = !!t.truncated;
    const saved = S.demo ? null : getJSON(`expanded:${S.repo.owner}/${S.repo.name}`, null);
    S.expanded = new Set(Array.isArray(saved) ? saved : []);
    // First visit to a repo whose notes all live in one top-level folder would
    // otherwise show a single collapsed folder and no files at all. Expand a
    // lone root folder automatically.
    if (S.expanded.size === 0) {
      const roots = new Set(S.tree.map(e => e.path.split('/')[0]));
      const hasRootFiles = S.tree.some(e => !e.path.includes('/'));
      if (roots.size === 1 && !hasRootFiles) S.expanded.add([...roots][0]);
    }
    renderTree();
    const mdCount = S.tree.filter(isMarkdown).length;
    $('tree-status').textContent =
      `${S.tree.length.toLocaleString('fa-IR')} فایل، ${mdCount.toLocaleString('fa-IR')} مارک‌داون`
      + (S.treeTruncated ? ' — فهرست ناقص است' : '');
  } catch (err) {
    if (err.status === 409) { $('tree-status').textContent = 'این مخزن هنوز کامیتی ندارد.'; S.tree = []; renderTree(); return; }
    if (err.status === 401) { logout(); return; }
    $('tree-status').textContent = '';
    toast(err.message, 'error');
  }
}

const isMarkdown = (p) => /\.(md|markdown|mdown|mkdn)$/i.test(p);

// ------------------------------------------------------------------ file tree
function buildTreeModel(entries, filter) {
  const root = { dirs: new Map(), files: [] };
  for (const e of entries) {
    if (filter && !e.path.toLowerCase().includes(filter)) continue;
    const parts = e.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ name: parts[parts.length - 1], path: e.path, size: e.size });
  }
  return root;
}

function renderTree() {
  const host = $('file-tree');
  host.textContent = '';
  const filter = $('file-filter').value.trim().toLowerCase();
  // While filtering, show a flat list — nested folders hide matches.
  if (filter) {
    const matches = S.tree.filter(e => e.path.toLowerCase().includes(filter))
      .sort((a, b) => a.path.localeCompare(b.path)).slice(0, 400);
    if (!matches.length) { host.appendChild(el('div', 'empty', 'چیزی پیدا نشد.')); return; }
    const ul = el('ul', 'tree flat');
    for (const m of matches) ul.appendChild(fileLi(m.path, m.size, 0));
    host.appendChild(ul);
    return;
  }
  host.appendChild(renderNode(buildTreeModel(S.tree, ''), ''));
}

function renderNode(node, prefix) {
  const ul = el('ul', 'tree');
  const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b, 'fa'));
  for (const d of dirNames) {
    const path = prefix ? `${prefix}/${d}` : d;
    const open = S.expanded.has(path);
    const li = el('li', 'tree-dir');
    const btn = el('button', 'tree-toggle');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', String(open));
    btn.appendChild(el('span', 'twisty', open ? '▾' : '◂'));
    btn.appendChild(el('span', 'dir-name', d));
    btn.addEventListener('click', () => {
      if (open) S.expanded.delete(path); else S.expanded.add(path);
      if (!S.demo) setJSON(`expanded:${S.repo.owner}/${S.repo.name}`, [...S.expanded]);
      renderTree();
    });
    li.appendChild(btn);
    if (open) li.appendChild(renderNode(node.dirs.get(d), path));
    ul.appendChild(li);
  }
  const files = [...node.files].sort((a, b) => {
    const am = isMarkdown(a.path), bm = isMarkdown(b.path);
    if (am !== bm) return am ? -1 : 1;            // markdown first
    return a.name.localeCompare(b.name, 'fa');
  });
  for (const f of files) ul.appendChild(fileLi(f.path, f.size, prefix ? prefix.split('/').length : 0));
  return ul;
}

function fileLi(path, size, depth) {
  const li = el('li', 'tree-file');
  if (!isMarkdown(path)) li.classList.add('non-md');
  const b = el('button', 'tree-file-btn');
  b.type = 'button';
  b.dir = 'auto';
  b.title = path;
  b.textContent = path;
  b.addEventListener('click', () => openFile(path));
  li.appendChild(b);
  return li;
}

// ----------------------------------------------------------------- open file
async function openFile(path) {
  if (S.dirty && !confirm('تغییرات ذخیره‌نشده دارید. باز هم این فایل باز شود؟')) return;
  $('tree-status').textContent = '';
  setBusy(true);
  try {
    const { text, sha, size } = await S.gh.readFile(S.repo.owner, S.repo.name, path, S.branch);
    S.path = path;
    S.newFile = false;
    S.sha = sha;
    S.bom = hasBOM(text);
    const body = stripBOM(text);
    S.newline = detectNewline(body);
    S.readOnly = false; S.readOnlyWhy = '';
    if (isLFSPointer(body)) {
      S.readOnly = true;
      S.readOnlyWhy = 'این فایل یک اشاره‌گر Git LFS است. ذخیره کردن آن فایل واقعی را خراب می‌کند.';
    }
    const ed = $('editor');
    ed.value = body;
    S.baseText = body;
    S.dirty = false;

    const draft = readDraft();
    if (draft && draft.text !== body) {
      offerDraft(draft);
    }

    $('path-label').textContent = path;
    $('path-label').dir = 'auto';
    setRenderContext({ owner: S.repo.owner, repo: S.repo.name, ref: S.branch, dir: dirOf(path) });
    updateEditorState();
    updateLineNumbers();
    updatePreview();
    markActiveFile(path);
    // On small screens the drawer is an overlay: get out of the way of the file.
    if (isMobile()) setSidebarOpen(false);
  } catch (err) {
    if (err.status === 401) { logout(); return; }
    toast(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

function offerDraft(draft) {
  const when = new Date(draft.savedAt).toLocaleTimeString('fa-IR');
  const yes = confirm(`پیش‌نویس ذخیره‌نشده از ساعت ${when} پیدا شد.\n\n«تأیید» = بازیابی پیش‌نویس\n«لغو» = دور ریختن آن`);
  if (yes) {
    $('editor').value = draft.text;
    S.dirty = true;
    if (draft.baseSha && draft.baseSha !== S.sha) {
      toast('فایل روی سرور بعد از این پیش‌نویس تغییر کرده است.', 'warn');
    }
  } else {
    clearDraft();
  }
  updateEditorState();
  updatePreview();
}

const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

function markActiveFile(path) {
  document.querySelectorAll('.tree-file-btn').forEach(n =>
    n.classList.toggle('active', n.textContent === path));
}

function updateEditorState() {
  const ed = $('editor');
  ed.readOnly = S.readOnly;
  ed.classList.toggle('readonly', S.readOnly);
  $('readonly-banner').hidden = !S.readOnly;
  $('readonly-why').textContent = S.readOnlyWhy;
  $('demo-banner').hidden = !S.demo;
  $('dirty-dot').hidden = !S.dirty;

  const cBtn = $('commit-btn');
  if (cBtn) {
    // A demo session can edit but never write, so the button stays disabled and
    // says why instead of opening a commit dialog that must fail.
    cBtn.disabled = !S.dirty || S.saving || S.readOnly || !S.path || S.demo;
    cBtn.title = S.demo ? 'حالت نمایشی — برای کامیت با توکن وارد شوید' : 'ثبت تغییرات (Ctrl+S)';
  }
  const nBtn = $('btn-new-file');
  nBtn.disabled = !S.repo || S.demo;
  nBtn.title = S.demo ? 'حالت نمایشی — فقط خواندن فایل‌های نمونه' : 'فایل جدید';
  const words = ed.value.trim() ? ed.value.trim().split(/\s+/).length : 0;
  $('counts').textContent =
    `${words.toLocaleString('fa-IR')} واژه · ${ed.value.length.toLocaleString('fa-IR')} نویسه`;
}

function setBusy(on) {
  document.body.classList.toggle('busy', on);
}

// -------------------------------------------------------------------- editor
let draftTimer = null;
function onEditorInput() {
  const ed = $('editor');
  S.dirty = ed.value !== S.baseText;
  updateEditorState();
  updateLineNumbers();
  if (F.query) {
    runFind({ keepFocus: true });
  }
  updatePreviewDebounced();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { if (S.dirty) saveDraft(); }, 800);
}

let previewTimer = null;
function updatePreviewDebounced() {
  if (S.mode === 'edit') return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 200);
}


function syncPreviewToEditorCursor() {
  const pane = $('preview-pane');
  const box = $('preview');
  const ed = $('editor');
  if (!pane || pane.hidden || !box || !ed) return;

  const pos = ed.selectionStart;
  const before = ed.value.slice(0, pos);
  const curLine = before.split('\n').length;

  // Search for the closest rendered element with data-line <= curLine
  const elements = Array.from(box.querySelectorAll('[data-line]'));
  if (!elements.length) {
    const totalLines = Math.max(1, ed.value.split('\n').length);
    const ratio = curLine / totalLines;
    pane.scrollTop = ratio * (pane.scrollHeight - pane.clientHeight);
    return;
  }

  let match = elements[0];
  for (const el of elements) {
    const l = parseInt(el.getAttribute('data-line'), 10);
    if (l <= curLine) match = el;
    else break;
  }

  if (match) {
    const paneRect = pane.getBoundingClientRect();
    const elRect = match.getBoundingClientRect();
    const offset = elRect.top - paneRect.top + pane.scrollTop - 40;
    pane.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
  }
}

function annotatePreviewLines(box, markdown) {
  try {
    const { yaml, body } = splitFrontMatter(markdown);
    const yamlOffset = yaml != null ? (yaml.split(/\r?\n/).length + 2) : 0;
    const tokens = window.marked.lexer(body);
    if (window.marked.defaults && window.marked.defaults.walkTokens) {
      window.marked.walkTokens(tokens, window.marked.defaults.walkTokens);
    }

    let curLine = 1 + yamlOffset;
    const blocks = [];
    for (const t of tokens) {
      if (['heading', 'paragraph', 'table', 'blockquote', 'code', 'list', 'hr'].includes(t.type)) {
        blocks.push({ type: t.type, line: curLine });
      }
      curLine += (t.raw.match(/\n/g) || []).length;
    }

    const topElements = Array.from(box.children).filter(el => !el.classList.contains('front-matter') && el.tagName !== 'HR');
    for (let i = 0; i < topElements.length && i < blocks.length; i++) {
      topElements[i].setAttribute('data-line', blocks[i].line);
    }
  } catch (e) {
    // Non-fatal if line annotation fails
  }
}

function updatePreview(opts = {}) {
  const pane = $('preview-pane');
  if (S.mode === 'edit') { pane.hidden = true; return; }
  pane.hidden = false;
  const box = $('preview');
  const val = $('editor').value;
  box.innerHTML = renderMarkdown(val);
  annotatePreviewLines(box, val);
  document.body.classList.toggle('mode-split', S.mode === 'split');
  document.body.classList.toggle('mode-preview', S.mode === 'preview');

  if (opts.syncCursor) {
    syncPreviewToEditorCursor();
  }
}

function setMode(mode) {
  S.mode = mode;
  const showEditor = mode !== 'preview';
  $('editor-pane').hidden = !showEditor;
  $('preview-pane').hidden = mode === 'edit';
  document.body.classList.toggle('mode-split', mode === 'split');
  document.body.classList.toggle('mode-preview', mode === 'preview');
  for (const [m, id] of [['edit', 'mode-edit'], ['preview', 'mode-preview'], ['split', 'mode-split']]) {
    $(id).setAttribute('aria-pressed', String(mode === m));
  }
  if (mode !== 'edit') {
    updatePreview({ syncCursor: true });
  }
  if (mode !== 'preview') $('editor').focus();
}

// ---------------------------------------------------------------------- save
async function save() {
  if (S.demo) {                                  // Ctrl+S reaches here too
    toast('حالت نمایشی است؛ برای ثبت تغییرات با توکن وارد شوید.', 'warn', 'ورود با توکن', logout);
    return;
  }
  if (!S.path || S.saving || S.readOnly) return;
  const text = $('editor').value;
  if (!S.dirty && !S.newFile) { toast('تغییری برای ذخیره نیست.', 'info'); return; }

  const message = await promptCommitMessage(
    S.newFile ? `ایجاد ${S.path}` : `به‌روزرسانی ${baseName(S.path)}`);
  if (message == null) return;

  S.saving = true;
  updateEditorState();
  setBusy(true);
  try {
    // Pre-flight: has the remote moved since we opened the file?
    if (!S.newFile) {
      const remote = await remoteSha();
      if (remote && remote !== S.sha) {
        S.saving = false; setBusy(false);
        await handleConflict(remote);
        return;
      }
    }

    const outgoing = (S.bom ? '\uFEFF' : '') + applyNewline(text, S.newline);
    const res = await S.gh.writeFile(S.repo.owner, S.repo.name, S.path, {
      text: outgoing,
      message: message.trim() || `به‌روزرسانی ${S.path}`,
      sha: S.newFile ? undefined : S.sha,
      branch: S.branch,
    });

    // 🔴 The blob sha changes on every commit. Reusing the old one 422s.
    if (res?.content?.sha) S.sha = res.content.sha;
    S.baseText = text;
    S.dirty = false;
    S.newFile = false;
    clearDraft();
    updateEditorState();
    markActiveFile(S.path);
    loadTree();                                  // refresh the sidebar

    toast('کامیت انجام شد ✓', 'success',
      res?.commit?.html_url ? 'مشاهده کامیت' : null,
      res?.commit?.html_url ? () => window.open(res.commit.html_url, '_blank', 'noopener') : null);
  } catch (err) {
    if (err.status === 401) { logout(); return; }
    if (err.status === 409 || err.status === 422) {
      const remote = await remoteSha().catch(() => null);
      if (remote && remote !== S.sha) { await handleConflict(remote); return; }
    }
    toast(err.message || 'ذخیره ناموفق بود.', 'error');
  } finally {
    S.saving = false;
    updateEditorState();
    setBusy(false);
  }
}

async function remoteSha() {
  const r = await S.gh.readFile(S.repo.owner, S.repo.name, S.path, S.branch);
  return r.sha;
}

async function handleConflict(remoteShaValue) {
  const choice = confirm(
    'فایل روی GitHub بعد از باز شدن تغییر کرده است.\n\n'
    + '«تأیید» = نسخهٔ سرور را بگیر (تغییرات محلی شما در پیش‌نویس می‌ماند)\n'
    + '«لغو» = همین‌جا نگه دار و خودم تصمیم می‌گیرم');
  if (!choice) { toast('ذخیره لغو شد. متن شما دست‌نخورده است.', 'warn'); return; }
  saveDraft();
  try {
    const { text } = await S.gh.readFile(S.repo.owner, S.repo.name, S.path, S.branch);
    S.sha = remoteShaValue;
    const body = stripBOM(text);
    S.baseText = body;
    $('editor').value = body;
    S.dirty = false;
    updateEditorState();
    updateLineNumbers();
    updatePreview();
    toast('نسخهٔ سرور بارگذاری شد. پیش‌نویس شما ذخیره شده است.', 'warn');
  } catch (err) {
    toast(err.message, 'error');
  }
}

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

// ------------------------------------------------------------------- dialogs
// <dialog>.showModal() gives focus trapping, Escape handling and the top layer
// for free. Each helper resolves exactly once, through close(returnValue).
function promptCommitMessage(prefill) {
  const d = $('commit-dialog');
  const msgInput = $('commit-message');
  const descInput = $('commit-description');
  const branchName = $('commit-branch-name');
  const targetInfo = $('commit-target-info');

  msgInput.value = prefill || '';
  descInput.value = '';
  if (branchName) branchName.textContent = S.branch || 'main';
  if (targetInfo) targetInfo.textContent = `${S.repo.owner}/${S.repo.name} — ${S.path}`;

  $('commit-form').onsubmit = (e) => {
    e.preventDefault();
    const title = msgInput.value.trim();
    const desc = descInput.value.trim();
    const full = desc ? `${title}\n\n${desc}` : title;
    d.close(full);
  };
  $('commit-cancel').onclick = () => d.close('');
  return new Promise((resolve) => {
    d.onclose = () => resolve(d.returnValue === '' ? null : d.returnValue);
    d.showModal();
    setTimeout(() => { msgInput.focus(); msgInput.select(); }, 0);
  });
}

async function newFile() {
  if (!S.repo) return;
  const d = $('newfile-dialog');
  const input = $('newfile-path');
  input.value = '';
  $('newfile-form').onsubmit = (e) => { e.preventDefault(); d.close(input.value.trim()); };
  $('newfile-cancel').onclick = () => d.close('');
  const path = await new Promise((resolve) => {
    d.onclose = () => resolve(d.returnValue || '');
    d.showModal();
    setTimeout(() => input.focus(), 0);
  });
  if (!path) return;

  const clean = path.replace(/^\/+/, '').replace(/\\/g, '/');
  if (!clean || clean.includes('..')) { toast('مسیر نامعتبر است.', 'error'); return; }

  const exists = S.tree.some(e => e.path === clean);
  if (exists) {
    if (!confirm('این فایل وجود دارد. باز شود؟')) return;
    return openFile(clean);
  }
  if (S.dirty && !confirm('تغییرات ذخیره‌نشده دارید. ادامه داده شود؟')) return;

  S.path = clean;
  S.newFile = true;
  S.sha = null;
  S.bom = false;
  S.newline = '\n';
  S.readOnly = false;
  S.baseText = '';
  $('editor').value = '';
  $('editor').readOnly = false;
  $('path-label').textContent = clean + ' (فایل جدید)';
  setRenderContext({ owner: S.repo.owner, repo: S.repo.name, ref: S.branch, dir: dirOf(clean) });
  S.dirty = true;
  updateEditorState();
  updatePreview();
  $('editor').focus();
}

// ----------------------------------------------------------- line numbers gutter
let lastLineCount = 0;
function updateLineNumbers() {
  const ed = $('editor');
  const inner = $('gutter-inner');
  if (!ed || !inner) return;
  const lines = ed.value.split('\n');
  const count = Math.max(1, lines.length);
  if (count !== lastLineCount) {
    lastLineCount = count;
    let html = '';
    for (let i = 1; i <= count; i++) {
      html += `<div class="gutter-num" data-line="${i}">${i.toLocaleString('fa-IR')}</div>`;
    }
    inner.innerHTML = html;
  }
}

function syncEditorScroll() {
  const ed = $('editor');
  const gutter = $('gutter');
  const backdrop = $('editor-backdrop');
  if (gutter) gutter.scrollTop = ed.scrollTop;
  if (backdrop) {
    backdrop.scrollTop = ed.scrollTop;
    backdrop.scrollLeft = ed.scrollLeft;
  }
}

function highlightAllMatches() {
  const backdrop = $('search-highlights');
  if (!backdrop) return;
  if (!F.query || !F.matches.length) {
    backdrop.innerHTML = '';
    return;
  }
  const text = $('editor').value;
  let html = '';
  let last = 0;
  for (let mIdx = 0; mIdx < F.matches.length; mIdx++) {
    const at = F.matches[mIdx];
    const before = text.slice(last, at);
    const match = text.slice(at, at + F.query.length);
    const cls = mIdx === F.index ? 'hl-match hl-selected' : 'hl-match';
    html += escapeHtml(before) + `<mark class="${cls}">${escapeHtml(match)}</mark>`;
    last = at + F.query.length;
  }
  html += escapeHtml(text.slice(last));
  backdrop.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// -------------------------------------------------------------- find/replace
const F = { query: '', index: -1, matches: [], caseSensitive: false };

function openFind(focusWhich) {
  $('find-bar').hidden = false;
  if (!F.query) F.query = selectedText();
  $('find-input').value = F.query;
  runFind({ keepFocus: true });
  const target = $(focusWhich === 'replace' ? 'replace-input' : 'find-input');
  target.focus();
  target.select();
}

function closeFind() {
  $('find-bar').hidden = true;
  highlightAllMatches();
  if (S.mode !== 'preview') $('editor').focus();
}

function selectedText() {
  const ed = $('editor');
  return ed.value.slice(ed.selectionStart, ed.selectionEnd);
}

function runFind(opts = {}) {
  F.query = $('find-input').value;
  const text = $('editor').value;
  F.matches = [];
  if (!F.query) {
    F.index = -1;
    highlightAllMatches();
    updateFindStatus();
    return;
  }

  const hay = F.caseSensitive ? text : text.toLowerCase();
  const needle = F.caseSensitive ? F.query : F.query.toLowerCase();

  let i = hay.indexOf(needle);
  while (i !== -1 && F.matches.length < 20000) {
    F.matches.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }

  // Preserve closest match to caret if possible
  if (F.matches.length) {
    const curPos = $('editor').selectionStart;
    const closest = F.matches.findIndex((m) => m >= curPos);
    F.index = closest >= 0 ? closest : 0;
  } else {
    F.index = -1;
  }

  highlightAllMatches();
  updateFindStatus();
  showMatch(opts);
}

function step(delta) {
  if (!F.matches.length) return;
  F.index = (F.index + delta + F.matches.length) % F.matches.length;
  highlightAllMatches();
  updateFindStatus();
  showMatch({ keepFocus: false });
}

function showMatch(opts = {}) {
  if (F.index < 0 || !F.matches.length) return;
  const ed = $('editor');
  const at = F.matches[F.index];

  // Scroll textarea to make match visible without stealing focus from find-input
  const before = ed.value.slice(0, at);
  const line = before.split('\n').length - 1;
  const styles = getComputedStyle(ed);
  const lineHeight = parseFloat(styles.lineHeight) || 28;
  const targetScroll = Math.max(0, (line - 3) * lineHeight);
  ed.scrollTop = targetScroll;
  syncEditorScroll();

  // Only setSelectionRange and focus if user requested navigation or replace
  if (!opts.keepFocus) {
    ed.focus();
    ed.setSelectionRange(at, at + F.query.length);
  }
}

function updateFindStatus() {
  $('find-status').textContent = !F.query ? ''
    : F.matches.length
      ? `${(F.index + 1).toLocaleString('fa-IR')} از ${F.matches.length.toLocaleString('fa-IR')}`
      : 'یافت نشد';
  const none = !F.matches.length;
  $('find-next').disabled = none;
  $('find-prev').disabled = none;
  $('replace-one').disabled = none;
  $('replace-all').disabled = none;
}

/** Replace the current selection while KEEPING the native undo stack. */
function replaceCurrent() {
  if (F.index < 0 || !F.matches.length) return;
  const ed = $('editor');
  const r = $('replace-input').value;
  ed.focus();
  const at = F.matches[F.index];
  ed.setSelectionRange(at, at + F.query.length);
  if (!document.execCommand('insertText', false, r)) {
    ed.setRangeText(r, at, at + F.query.length, 'end');
  }
  S.dirty = ed.value !== S.baseText;
  updateEditorState();
  updateLineNumbers();
  runFindFrom(at + r.length);
  updatePreviewDebounced();
}

function replaceAll() {
  if (!F.query) return;
  const ed = $('editor');
  const r = $('replace-input').value;
  const count = F.matches.length;
  if (!count) return;
  const next = ed.value.split(F.query).join(r);
  ed.focus();
  ed.setSelectionRange(0, ed.value.length);
  if (!document.execCommand('insertText', false, next)) ed.value = next;
  S.dirty = ed.value !== S.baseText;
  updateEditorState();
  updateLineNumbers();
  runFind({ keepFocus: false });
  updatePreviewDebounced();
  toast(`${count.toLocaleString('fa-IR')} مورد جایگزین شد.`, 'success');
}

/** Re-scan, jumping to the first match at or after `from`. */
function runFindFrom(from) {
  const text = $('editor').value;
  F.matches = [];
  if (!F.query) {
    highlightAllMatches();
    updateFindStatus();
    return;
  }
  const hay = F.caseSensitive ? text : text.toLowerCase();
  const needle = F.caseSensitive ? F.query : F.query.toLowerCase();
  let i = hay.indexOf(needle);
  while (i !== -1 && F.matches.length < 20000) {
    F.matches.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  F.index = F.matches.findIndex((m) => m >= from);
  if (F.index < 0 && F.matches.length) F.index = 0;
  highlightAllMatches();
  updateFindStatus();
  showMatch({ keepFocus: false });
}

// ------------------------------------------------------------------ keyboard
// e.code, NOT e.key: with the Persian keyboard layout active, the physical F
// key produces «ب», so e.key === 'f' is never true and Ctrl+F silently dies.
function onKeydown(e) {
  const mod = e.metaKey || e.ctrlKey;          // Cmd on macOS

  if (e.key === 'Escape') {
    if (!$('find-bar').hidden) { e.preventDefault(); closeFind(); }
    return;
  }
  if (!mod || e.altKey) return;

  switch (e.code) {
    case 'KeyS': e.preventDefault(); save(); break;
    case 'KeyE': e.preventDefault(); setMode(S.mode === 'preview' ? 'edit' : 'preview'); break;
    case 'KeyF':
      if (S.mode === 'preview') return;        // let the browser find work
      e.preventDefault(); openFind('find'); break;
    case 'KeyH':
      if (S.mode === 'preview') return;
      e.preventDefault(); openFind('replace'); break;
    case 'KeyB': if (S.mode !== 'preview') { e.preventDefault(); wrapSelection('**', '**'); } break;
    case 'KeyI': if (S.mode !== 'preview') { e.preventDefault(); wrapSelection('*', '*'); } break;
    case 'KeyK': if (S.mode !== 'preview') { e.preventDefault(); insertLink(); } break;
  }
}


// ------------------------------------------------------------- formatting toolbar
function applyFormatting(action) {
  const ed = $('editor');
  ed.focus();
  const { selectionStart: s, selectionEnd: e, value } = ed;
  const sel = value.slice(s, e);

  switch (action) {
    case 'h1': toggleLinePrefix('# '); break;
    case 'h2': toggleLinePrefix('## '); break;
    case 'h3': toggleLinePrefix('### '); break;
    case 'bold': wrapSelection('**', '**'); break;
    case 'italic': wrapSelection('*', '*'); break;
    case 'strike': wrapSelection('~~', '~~'); break;
    case 'ul': toggleLinePrefix('- '); break;
    case 'ol': toggleOrderedList(); break;
    case 'task': toggleLinePrefix('- [ ] '); break;
    case 'quote': toggleLinePrefix('> '); break;
    case 'code': wrapSelection('`', '`'); break;
    case 'codeblock': insertCodeBlock(); break;
    case 'table': insertTable(); break;
    case 'link': insertLink(); break;
  }
}

function toggleLinePrefix(prefix) {
  const ed = $('editor');
  const { selectionStart: s, selectionEnd: e, value } = ed;
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  const lineEnd = (() => { const i = value.indexOf('\n', e); return i < 0 ? value.length : i; })();
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');

  // If all non-empty lines start with prefix, remove it; else add it
  const allPrefixed = lines.every(l => !l.trim() || l.startsWith(prefix));
  const newLines = lines.map(l => {
    if (!l.trim()) return l;
    if (allPrefixed) {
      return l.startsWith(prefix) ? l.slice(prefix.length) : l;
    } else {
      // Remove any existing heading/list prefix if adding another heading/list
      let clean = l;
      if (prefix.startsWith('#')) {
        clean = clean.replace(/^(#{1,6}\s*)/, '');
      } else if (prefix.startsWith('- ') || prefix.startsWith('> ')) {
        clean = clean.replace(/^(\s*[-*+]\s*|\s*>\s*|\s*\d+[.)]\s*)/, '');
      }
      return prefix + clean;
    }
  });

  const next = newLines.join('\n');
  ed.setSelectionRange(lineStart, lineEnd);
  if (!document.execCommand('insertText', false, next)) ed.setRangeText(next, lineStart, lineEnd, 'end');
  ed.setSelectionRange(lineStart, lineStart + next.length);
  onEditorInput();
}

function toggleOrderedList() {
  const ed = $('editor');
  const { selectionStart: s, selectionEnd: e, value } = ed;
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  const lineEnd = (() => { const i = value.indexOf('\n', e); return i < 0 ? value.length : i; })();
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');

  const allNumbered = lines.every(l => !l.trim() || /^\s*\d+[.)]\s+/.test(l));
  let num = 1;
  const newLines = lines.map(l => {
    if (!l.trim()) return l;
    if (allNumbered) {
      return l.replace(/^\s*\d+[.)]\s+/, '');
    } else {
      const clean = l.replace(/^(\s*[-*+]\s*|\s*>\s*|\s*\d+[.)]\s*)/, '');
      return `${num++}. ${clean}`;
    }
  });

  const next = newLines.join('\n');
  ed.setSelectionRange(lineStart, lineEnd);
  if (!document.execCommand('insertText', false, next)) ed.setRangeText(next, lineStart, lineEnd, 'end');
  ed.setSelectionRange(lineStart, lineStart + next.length);
  onEditorInput();
}

function insertCodeBlock() {
  const ed = $('editor');
  const { selectionStart: s, selectionEnd: e, value } = ed;
  const sel = value.slice(s, e) || '// کد اینجا';
  const text = "```\n" + sel + "\n```";
  if (!document.execCommand('insertText', false, text)) ed.setRangeText(text, s, e, 'end');
  ed.setSelectionRange(s + 3, s + 3);
  onEditorInput();
}

function insertTable() {
  const ed = $('editor');
  const { selectionStart: s, selectionEnd: e } = ed;
  const tableTpl = `| ستون ۱ | ستون ۲ | ستون ۳ |\n| --- | --- | --- |\n| داده ۱ | داده ۲ | داده ۳ |\n`;
  if (!document.execCommand('insertText', false, tableTpl)) ed.setRangeText(tableTpl, s, e, 'end');
  ed.setSelectionRange(s, s + tableTpl.length);
  onEditorInput();
}

function wrapSelection(before, after = before) {
  const ed = $('editor');
  const { selectionStart: s, selectionEnd: e, value } = ed;
  const sel = value.slice(s, e);
  // toggle off if already wrapped
  if (value.slice(s - before.length, s) === before && value.slice(e, e + after.length) === after) {
    ed.focus();
    ed.setSelectionRange(s - before.length, e + after.length);
    if (!document.execCommand('insertText', false, sel)) ed.setRangeText(sel, s - before.length, e + after.length, 'end');
  } else {
    ed.focus();
    const text = before + (sel || 'متن') + after;
    if (!document.execCommand('insertText', false, text)) ed.setRangeText(text, s, e, 'end');
    ed.setSelectionRange(s + before.length, s + before.length + (sel || 'متن').length);
  }
  onEditorInput();
}

function insertLink() {
  const ed = $('editor');
  const { selectionStart: s, selectionEnd: e, value } = ed;
  const sel = value.slice(s, e) || 'متن پیوند';
  ed.focus();
  const text = `[${sel}](https://)`;
  if (!document.execCommand('insertText', false, text)) ed.setRangeText(text, s, e, 'end');
  ed.setSelectionRange(s + sel.length + 3, s + sel.length + 11);
  onEditorInput();
}

// Tab inserts two spaces (and Shift+Tab outdents) instead of leaving the editor.
function onEditorKeydown(e) {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const ed = $('editor');
  const { selectionStart: s, selectionEnd: e2, value } = ed;
  if (s !== e2 || e.shiftKey) {
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const lineEnd = (() => { const i = value.indexOf('\n', e2); return i < 0 ? value.length : i; })();
    const block = value.slice(lineStart, lineEnd);
    const next = e.shiftKey
      ? block.replace(/^ {1,2}/gm, '')
      : block.replace(/^/gm, '  ');
    ed.setSelectionRange(lineStart, lineEnd);
    if (!document.execCommand('insertText', false, next)) ed.setRangeText(next, lineStart, lineEnd, 'end');
    ed.setSelectionRange(lineStart, lineStart + next.length);
  } else {
    if (!document.execCommand('insertText', false, '  ')) ed.setRangeText('  ', s, e2, 'end');
  }
  onEditorInput();
}

// Continue list markers on Enter.
function onEditorEnter(e) {
  if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  const ed = $('editor');
  const { selectionStart: s, selectionEnd: e2, value } = ed;
  if (s !== e2) return;
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  const line = value.slice(lineStart, s);
  const m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/.exec(line);
  if (!m) return;
  e.preventDefault();
  // An empty list item: remove the marker instead of adding another.
  if (line.trim() === m[2] || line.trim() === m[2] + ' ' || (m[3] && line.trim() === m[2] + ' ' + m[3].trim())) {
    ed.setSelectionRange(lineStart, s);
    if (!document.execCommand('insertText', false, '\n')) ed.setRangeText('\n', lineStart, s, 'end');
    onEditorInput();
    return;
  }
  let marker = m[2];
  const ordered = /^(\d+)([.)])$/.exec(marker);
  if (ordered) marker = (parseInt(ordered[1], 10) + 1) + ordered[2];
  const insert = '\n' + m[1] + marker + ' ' + (m[3] ? '[ ] ' : '');
  if (!document.execCommand('insertText', false, insert)) ed.setRangeText(insert, s, e2, 'end');
  onEditorInput();
}

// --------------------------------------------------------- responsive shell
// One source of truth for "are we in the mobile shell". It mirrors the 860px
// media query in css/app.css — keep the two numbers in step.
const mobileMQ = window.matchMedia?.('(max-width: 860px)') ?? null;
const isMobile = () => !!mobileMQ?.matches;

const isSidebarOpen = () => !document.body.classList.contains('sidebar-collapsed');

function setSidebarOpen(open) {
  document.body.classList.toggle('sidebar-collapsed', !open);
  $('sidebar-toggle').setAttribute('aria-expanded', String(open));
}

/**
 * On mobile the secondary header controls move into the ⋯ dialog; on desktop
 * they live in the header. The real nodes are MOVED (not duplicated), so ids,
 * listeners and styles keep working and there is only ever one of each.
 */
function layoutTopbar(mobile = isMobile()) {
  const slot = $(mobile ? 'menu-slot' : 'topbar-extra');
  for (const id of ['find-open', 'btn-new-file', 'user-box']) slot.appendChild($(id));
  setSidebarOpen(!mobile);          // each shell starts in its natural state
}

function openMenu() {
  const d = $('more-dialog');
  $('more-btn').setAttribute('aria-expanded', 'true');
  // showModal() gives focus trapping, Escape and the top layer for free; the
  // fallback keeps the menu reachable in environments without <dialog> support.
  if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
}
function closeMenu() {
  const d = $('more-dialog');
  if (d.open && typeof d.close === 'function') d.close();
  $('more-btn').setAttribute('aria-expanded', 'false');
}

/** --topbar-h drives the mobile drawer's offset, so it must be the real height. */
function measureTopbar() {
  const h = $('topbar')?.offsetHeight;
  if (h) document.documentElement.style.setProperty('--topbar-h', `${h}px`);
}

// ------------------------------------------------------------------ wiring
function wire() {
  $('login-form').addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
  $('demo-btn').addEventListener('click', startDemo);
  $('demo-login').addEventListener('click', logout);
  $('logout-btn').addEventListener('click', logout);
  $('refresh-repos').addEventListener('click', () => loadRepos(false));
  $('repo-filter').addEventListener('input', renderRepoList);
  $('file-filter').addEventListener('input', renderTree);
  $('branch-select').addEventListener('change', async (e) => {
    if (S.dirty && !confirm('تغییرات ذخیره‌نشده دارید. شاخه عوض شود؟')) {
      e.target.value = S.branch; return;
    }
    S.branch = e.target.value;
    if (S.path) { S.path = null; S.dirty = false; }
    $('editor').value = '';
    S.baseText = '';
    $('path-label').textContent = '';
    updateEditorState();
    await loadTree();
  });

  $('editor').addEventListener('input', onEditorInput);
  $('editor').addEventListener('scroll', syncEditorScroll);
  $('editor').addEventListener('click', () => {
    if (S.mode === 'split') syncPreviewToEditorCursor();
  });
  $('editor').addEventListener('keyup', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
      if (S.mode === 'split') syncPreviewToEditorCursor();
    }
  });
  $('editor').addEventListener('keydown', onEditorKeydown);
  $('editor').addEventListener('keydown', onEditorEnter);

  $('mode-edit').addEventListener('click', () => setMode('edit'));
  $('mode-preview').addEventListener('click', () => setMode('preview'));
  $('mode-split').addEventListener('click', () => setMode('split'));
  $('commit-btn')?.addEventListener('click', save);
  $('btn-new-file').addEventListener('click', newFile);
  $('sidebar-toggle').addEventListener('click', () => setSidebarOpen(!isSidebarOpen()));
  $('sidebar-overlay')?.addEventListener('click', () => setSidebarOpen(false));

  // ⋯ menu. Capture phase, so the menu is already closed when the button's own
  // handler runs (e.g. خروج hides the whole app view underneath it).
  $('more-btn').addEventListener('click', openMenu);
  $('more-close').addEventListener('click', closeMenu);
  $('more-dialog').addEventListener('click', (e) => {
    if (e.target === $('more-dialog') || e.target.closest('button')) closeMenu();
  }, true);
  $('more-dialog').addEventListener('close', () =>
    $('more-btn').setAttribute('aria-expanded', 'false'));

  // On touch, tapping a toolbar button blurs the textarea before the click
  // handler runs, and the selection it formats is gone. Refusing the default on
  // pointerdown keeps focus (and the selection) in the editor.
  $('editor-toolbar')?.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-action]')) e.preventDefault();
  });

  // Formatting toolbar listener
  $('editor-toolbar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.preventDefault();
    applyFormatting(btn.dataset.action);
  });

  $('find-open').addEventListener('click', () => openFind('find'));
  $('find-close').addEventListener('click', closeFind);
  $('find-input').addEventListener('input', debounce(() => runFind({ keepFocus: true }), 150));
  $('find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('find-case')?.addEventListener('click', () => {
    F.caseSensitive = !F.caseSensitive;
    $('find-case').setAttribute('aria-pressed', String(F.caseSensitive));
    $('find-case').classList.toggle('active', F.caseSensitive);
    runFind({ keepFocus: true });
  });
  $('find-next').addEventListener('click', () => step(1));
  $('find-prev').addEventListener('click', () => step(-1));
  $('replace-one').addEventListener('click', replaceCurrent);
  $('replace-all').addEventListener('click', replaceAll);

  // Escape and the ✕ button close it; a click anywhere else in the document
  // closes it too (review ask). Editor clicks included, deliberately.
  document.addEventListener('pointerdown', (e) => {
    const bar = $('find-bar');
    if (!bar.hidden && !bar.contains(e.target)) closeFind();
  });

  document.addEventListener('keydown', onKeydown);

  window.addEventListener('beforeunload', (e) => {
    // A demo session saves nothing, so a "changes may be lost" prompt would be
    // a lie — and everyone closes a demo tab eventually.
    if (S.dirty && !S.demo) { e.preventDefault(); e.returnValue = ''; }
  });

  // Responsive shell: rows/menu on mobile, drawer offset tracking the header.
  layoutTopbar();
  measureTopbar();
  if (window.ResizeObserver) new window.ResizeObserver(measureTopbar).observe($('topbar'));
  else window.addEventListener('resize', measureTopbar);
  mobileMQ?.addEventListener('change', () => { layoutTopbar(); measureTopbar(); });
  document.fonts?.ready?.then(measureTopbar);   // the webfont swap changes heights

  window.addEventListener('error', (e) => {
    toast('خطای غیرمنتظره: ' + (e.message || 'نامشخص'), 'error');
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// -------------------------------------------------------------------- start
wire();
setMode('edit');
if (readToken()) {
  const gh = new GitHub(readToken());
  S.gh = gh;
  gh.user()
    .then((u) => { S.user = u; return enterApp(); })
    .catch((err) => { clearToken(); showLogin(err.status === 401 ? '' : err.message); });
} else {
  showLogin();
}


