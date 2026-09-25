/**
 * app.js — wiring, state, keyboard, GitHub flows.
 *
 * Sections: state · helpers · auth · repos · tree · file · preview ·
 *           commit · find · keyboard · boot
 */

import * as api from './api.js';
import * as store from './store.js';
import { render, mount } from './md.js';
import { buildTree, renderTree, collectDirs, dirname } from './tree.js';
import { createFinder } from './find.js';

const $ = (id) => document.getElementById(id);
const el = {};

const state = {
  user: null,
  repos: [],
  repo: null,          // { owner: {login}, name, full_name, default_branch, ... }
  branches: [],
  branch: '',
  root: null,
  truncated: false,
  entryCount: 0,
  expanded: new Set(),
  file: null,          // { owner, repo, branch, path }
  sha: null,           // blob sha of what is on disk / last commit
  base: '',            // text as loaded or last committed
  eol: '\n',
  bom: false,
  dirty: false,
  busy: false,
};

let p = store.prefs.get();          // live preferences object
let finder;

/* ============================================================== helpers */

const isMdPath = (path) => /\.(md|markdown|mdown|mkd|mkdn)$/i.test(path);
const baseName = (path) => path.split('/').pop();
const owner = () => state.repo && state.repo.owner.login;
const repoName = () => state.repo && state.repo.name;

const faDigits = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86400000;
  if (diff < day) return 'امروز';
  if (diff < 2 * day) return 'دیروز';
  if (diff < 30 * day) return faDigits(Math.floor(diff / day)) + ' روز پیش';
  if (diff < 365 * day) return faDigits(Math.floor(diff / (30 * day))) + ' ماه پیش';
  return faDigits(Math.floor(diff / (365 * day))) + ' سال پیش';
}

function clock(d = new Date()) {
  return d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
}

let toastTimer = null;
function toast(message, kind = 'info', link) {
  const node = el.toast;
  node.className = `toast is-${kind}`;
  node.replaceChildren(document.createTextNode(message));
  if (link) {
    const a = document.createElement('a');
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'مشاهدهٔ commit';
    node.append(' · ', a);
  }
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === 'error' ? 8000 : 4500);
}

function setBusy(on, label = 'در حال بارگیری…') {
  state.busy = on;
  el.app.classList.toggle('is-busy', on);
  el.statState.textContent = on ? label : (state.dirty ? 'تغییرات ذخیره‌نشده' : '');
  el.btnSave.disabled = on || !state.file;
}

function dialog(dlg) {
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true });
  });
}

function handleError(err, context = '') {
  console.error(context, err);                       // never logs the request/token
  if (err instanceof api.ApiError) {
    if (err.status === 0) return toast(err.message, 'error');
    if (err.status === 404) return toast('پیدا نشد — مسیر یا شاخه را بررسی کنید.', 'error');
    if (err.isRateLimit) return toast('محدودیت نرخ درخواست‌ها — کمی صبر کنید.', 'error');
    if (err.isConflict) return toast('تضاد: ' + err.message, 'error');
    if (err.status === 415) return toast(err.message, 'error');
    return toast(`خطای ${faDigits(err.status)}: ${err.message}`, 'error');
  }
  toast('خطای غیرمنتظره: ' + err.message, 'error');
}

/* ================================================================= auth */

function showAuth(message) {
  el.auth.hidden = false;
  el.app.hidden = true;
  el.authError.hidden = !message;
  el.authError.textContent = message || '';
  if (!message) el.tokenInput.focus();
}

async function signIn(token, remember) {
  el.authError.hidden = true;
  api.setToken(token);
  try {
    state.user = await api.user();
  } catch (err) {
    api.setToken('');
    el.authError.hidden = false;
    el.authError.textContent = 'اتصال ناموفق بود: ' + err.message;
    return;
  }
  store.token.set(token, remember);
  el.app.hidden = false;
  el.auth.hidden = true;
  renderUser();
  await startup();
}

function signOut() {
  store.token.clear();
  api.setToken('');
  state.user = null;
  el.auth.hidden = false;
  el.app.hidden = true;
  el.tokenInput.value = '';
  showAuth('برای ادامه دوباره وارد شوید.');
}

function renderUser() {
  const u = state.user;
  el.btnUser.textContent = '';
  if (u && u.avatar_url) {
    const img = document.createElement('img');
    img.src = u.avatar_url;
    img.alt = '';
    img.width = 24;
    img.height = 24;
    el.btnUser.appendChild(img);
  }
  el.btnUser.append(document.createTextNode((u && (u.name || u.login)) || 'خروج'));
  el.btnUser.title = u ? `${u.login} — خروج` : 'خروج';
}

/* ================================================================ repos */

async function startup() {
  setBusy(true, 'دریافت مخزن‌ها…');
  try {
    state.repos = await api.listRepos();
    renderRepos();
    const last = p.last;
    if (last) {
      const repo = state.repos.find((r) => r.full_name === last.repo);
      if (repo) await selectRepo(repo, last.branch, last.path);
    }
  } catch (err) {
    handleError(err, 'startup');
  } finally {
    setBusy(false);
  }
}

function renderRepos() {
  const query = el.repoFilter.value.trim().toLowerCase();
  el.repoList.replaceChildren();

  const list = state.repos
    .filter((r) => !query || r.full_name.toLowerCase().includes(query))
    .slice(0, 300);

  if (!list.length) {
    const p2 = document.createElement('p');
    p2.className = 'empty';
    p2.textContent = state.repos.length ? 'مخزنی با این نام نیست' : 'مخزنی یافت نشد';
    el.repoList.appendChild(p2);
    return;
  }

  for (const repo of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'repo-row';
    row.setAttribute('role', 'option');
    if (state.repo && repo.full_name === state.repo.full_name) {
      row.classList.add('is-selected');
      row.setAttribute('aria-selected', 'true');
    }
    row.addEventListener('click', () => selectRepo(repo));

    const name = document.createElement('span');
    name.className = 'repo-name';
    name.textContent = repo.full_name;

    const meta = document.createElement('span');
    meta.className = 'repo-meta';
    if (repo.private) {
      const badge = document.createElement('span');
      badge.className = 'tag';
      badge.textContent = 'خصوصی';
      meta.appendChild(badge);
    }
    if (repo.archived) {
      const badge = document.createElement('span');
      badge.className = 'tag';
      badge.textContent = 'بایگانی';
      meta.appendChild(badge);
    }
    meta.append(document.createTextNode(timeAgo(repo.pushed_at)));

    row.append(name, meta);
    el.repoList.appendChild(row);
  }
}

async function selectRepo(repo, branch, filePath) {
  state.repo = repo;
  p = store.prefs.set({ last: null });
  renderRepos();
  renderCrumb();
  setBusy(true, 'دریافت شاخه‌ها…');
  try {
    const [meta, branches] = await Promise.all([
      api.getRepo(owner(), repoName()),
      api.listBranches(owner(), repoName()).catch(() => []),
    ]);
    state.repo.default_branch = meta.default_branch;
    state.branches = branches.map((b) => b.name);
    if (!state.branches.includes(meta.default_branch)) state.branches.unshift(meta.default_branch);
    state.branch = branch && state.branches.includes(branch) ? branch : meta.default_branch;
    state.expanded = new Set();
    renderBranchSelect();
    await loadTree();
    if (filePath) await openFile(filePath, { force: true });
  } catch (err) {
    handleError(err, 'selectRepo');
  } finally {
    setBusy(false);
  }
}

function renderBranchSelect() {
  el.commitBranch.replaceChildren();
  for (const name of state.branches) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    el.commitBranch.appendChild(opt);
  }
  el.commitBranch.value = state.branch;
}

/* ================================================================= tree */

async function loadTree() {
  el.fileTree.replaceChildren();
  const msg = document.createElement('p');
  msg.className = 'empty';
  msg.textContent = 'در حال بارگیری…';
  el.fileTree.appendChild(msg);

  try {
    const tree = await api.getTree(owner(), repoName(), state.branch);
    state.root = buildTree(tree.tree || []);
    state.truncated = !!tree.truncated;
    state.entryCount = (tree.tree || []).length;
    state.expanded = new Set((p.expanded || []).filter((d) => typeof d === 'string'));
    paintTree();
    if (state.truncated) {
      toast(`درخت ناقص است (بیش از ${faDigits(state.entryCount)} مدخل) — از جستجو استفاده کنید.`, 'warn');
    }
  } catch (err) {
    if (err instanceof api.ApiError && err.isConflict) {
      state.root = null;
      el.fileTree.replaceChildren();
      const p2 = document.createElement('p');
      p2.className = 'empty';
      p2.textContent = 'این مخزن هنوز commit ندارد.';
      el.fileTree.appendChild(p2);
      return;
    }
    handleError(err, 'loadTree');
  }
}

function paintTree() {
  if (!state.root) return;
  renderTree(el.fileTree, {
    root: state.root,
    expanded: state.expanded,
    selected: state.file ? state.file.path : '',
    filter: el.fileFilter.value,
    onlyMarkdown: el.onlyMd.checked,
    onToggle: (path, open) => {
      if (open) state.expanded.add(path); else state.expanded.delete(path);
      p = store.prefs.set({ expanded: [...state.expanded].slice(0, 200) });
      paintTree();
    },
    onSelect: (path) => openFile(path),
  });

  let count = 0;
  const walk = (n) => n.children.forEach((c) => {
    if (c.type === 'dir') walk(c); else count += 1;
  });
  if (state.root) walk(state.root);
  el.treeTitle.textContent = `فایل‌ها (${faDigits(count)})`;
}

/* ================================================================= file */

async function openFile(path, { force = false } = {}) {
  if (!force && state.dirty && !confirm('تغییرات ذخیره‌نشده از بین می‌رود. ادامه می‌دهید؟')) return;

  setBusy(true, 'دریافت فایل…');
  try {
    const file = await api.getFile(owner(), repoName(), path, state.branch);
    state.file = { owner: owner(), repo: repoName(), branch: state.branch, path };

    state.bom = file.text.charCodeAt(0) === 0xfeff;
    const raw = state.bom ? file.text.slice(1) : file.text;
    state.eol = raw.includes('\r\n') ? '\r\n' : '\n';

    state.sha = file.sha;
    state.base = raw;
    el.editor.value = raw.replace(/\r\n/g, '\n');

    p = store.prefs.set({
      last: { repo: state.repo.full_name, branch: state.branch, path },
    });
    setDirty(false);
    renderCrumb();
    paintTree();
    renderPreview(true);

    // Draft recovery: only offer it when the draft was taken from this same
    // revision, otherwise warn that the remote has moved since.
    const draft = store.drafts.get(owner(), repoName(), state.branch, path);
    if (draft && draft.text !== el.editor.value) {
      const stale = draft.baseSha !== state.sha;
      el.draftInfo.textContent = stale
        ? `پیش‌نویسی از ${new Date(draft.savedAt).toLocaleString('fa-IR')} وجود دارد، اما فایل از آن زمان در گیت‌هاب تغییر کرده است.`
        : `پیش‌نویس ذخیره‌نشده از ${new Date(draft.savedAt).toLocaleString('fa-IR')} پیدا شد.`;
      const choice = await dialog(el.dlgDraft);
      if (choice === 'restore') {
        el.editor.value = draft.text.replace(/\r\n/g, '\n');
        setDirty(true);
        renderPreview(true);
      } else {
        store.drafts.remove(owner(), repoName(), state.branch, path);
      }
    }
    el.editor.focus();
  } catch (err) {
    handleError(err, 'openFile');
  } finally {
    setBusy(false);
    updateStats();
  }
}

function serialize() {
  let text = el.editor.value;
  if (state.eol === '\r\n') text = text.replace(/\r?\n/g, '\r\n');   // never rewrite EOLs silently
  return (state.bom ? '﻿' : '') + text;
}

function setDirty(value) {
  state.dirty = value;
  el.statState.textContent = value ? 'تغییرات ذخیره‌نشده' : (state.file ? `ذخیره‌شده ${clock()}` : '');
  el.editor.classList.toggle('is-dirty', value);
  document.title = (value ? '• ' : '') + (state.file ? baseName(state.file.path) : 'ویرایشگر مارک‌داون');
  el.statState.className = value ? 'is-dirty' : '';
}

function renderCrumb() {
  el.crumb.replaceChildren();
  const parts = [];
  if (state.repo) parts.push(state.repo.full_name);
  if (state.branch) parts.push(state.branch);
  if (state.file) parts.push(state.file.path);
  el.crumb.textContent = parts.join('  /  ') || 'مخزنی انتخاب نشده';

  el.crumb.classList.toggle('is-empty', !state.repo);
}

/* ============================================================== preview */

let previewTimer = null;
function renderPreview(immediate = false) {
  clearTimeout(previewTimer);
  const run = () => {
    if (p.view === 'edit') return;
    const scroll = el.previewPane.scrollTop;
    const ctx = state.file
      ? { owner: owner(), repo: repoName(), branch: state.branch, dir: dirname(state.file.path) }
      : {};
    const { nodes, front } = render(el.editor.value, ctx);
    mount(el.preview, nodes);
    el.previewPane.scrollTop = scroll;
    el.frontMatter.hidden = !front;
    if (front) el.frontMatter.textContent = `front matter: ${front.split('\n')[0].slice(0, 60)}…`;
  };
  immediate ? run() : (previewTimer = setTimeout(run, 220));
}

function applyView(view) {
  p = store.prefs.set({ view });
  document.body.dataset.view = view;
  el.previewPane.hidden = view === 'edit';
  el.editorPane.hidden = view === 'preview';
  el.btnView.setAttribute('aria-pressed', String(view === 'preview'));
  el.btnSplit.setAttribute('aria-pressed', String(view === 'split'));
  el.btnView.textContent = view === 'preview' ? 'ویرایش' : 'پیش‌نمایش';
  renderPreview(true);
}

/* =============================================================== commit */

async function save() {
  if (state.busy) return;
  if (!state.file) return newFile();

  const text = serialize();
  if (text === state.base) {
    toast('تغییری برای ثبت وجود ندارد.');
    return;
  }

  setBusy(true, 'بررسی نسخهٔ گیت‌هاب…');
  let remote;
  try {
    remote = await api.remoteSha(owner(), repoName(), state.file.path, state.branch);
  } catch (err) {
    setBusy(false);
    return handleError(err, 'preflight');
  }
  setBusy(false);

  if (remote && state.sha && remote !== state.sha) {
    const choice = await dialog(el.dlgConflict);
    if (choice === 'remote') return openFile(state.file.path, { force: true });
    if (choice === 'copy') return saveAsCopy();
    if (choice !== 'overwrite') return;
    state.sha = remote;                       // deliberate overwrite
  }

  el.commitPath.textContent = `${state.repo.full_name}/${state.branch} — ${state.file.path}`;
  el.commitMsg.value = `Update ${baseName(state.file.path)}`;
  renderBranchSelect();
  if (await dialog(el.dlgCommit) !== 'ok') return;
  await doCommit(el.commitMsg.value.trim() || `Update ${baseName(state.file.path)}`, el.commitBranch.value);
}

async function doCommit(message, branch) {
  setBusy(true, 'در حال ثبت…');
  try {
    const res = await api.putFile(owner(), repoName(), state.file.path, {
      message,
      content: serialize(),
      sha: state.sha,                 // undefined for a brand new file -> create
      branch,
    });
    state.sha = res.sha;              // the blob sha CHANGES — always refresh it
    state.base = serialize();
    store.drafts.remove(owner(), repoName(), state.branch, state.file.path);
    setDirty(false);
    if (branch !== state.branch) {
      state.branch = branch;
      renderCrumb();
      loadTree();
    }
    toast(`ذخیره شد — ${clock()}`, 'ok', res.commitUrl);
  } catch (err) {
    if (err instanceof api.ApiError && err.isConflict) {
      toast('فایل در گیت‌هاب تغییر کرده است. دوباره تلاش کنید.', 'error');
    } else {
      handleError(err, 'commit');
    }
  } finally {
    setBusy(false);
  }
}

async function saveAsCopy() {
  const suggested = state.file.path.replace(/(\.md)?$/i, '-copy$1') || 'copy.md';
  el.newPath.value = suggested;
  if (await dialog(el.dlgNew) !== 'ok') return;
  const path = el.newPath.value.trim();
  if (!path) return;
  const oldSha = state.sha;
  state.file = { ...state.file, path };
  state.sha = null;              // no sha -> the API creates instead of updating
  state.base = '';
  setDirty(true);
  renderCrumb();
  await save();
  if (!oldSha) { /* nothing to roll back to */ }
}

async function newFile() {
  if (!state.repo) { toast('ابتدا یک مخزن انتخاب کنید.'); return; }
  if (state.dirty && !confirm('تغییرات ذخیره‌نشده از بین می‌رود. ادامه می‌دهید؟')) return;
  el.newPath.value = '';
  if (await dialog(el.dlgNew) !== 'ok') return;

  let path = el.newPath.value.trim().replace(/^\/+/, '');
  if (!path) return;
  if (path.includes('..')) { toast('مسیر نمی‌تواند شامل .. باشد.', 'error'); return; }
  if (!isMdPath(path)) toast('توجه: این فایل پسوند مارک‌داون ندارد.', 'warn');

  state.file = { owner: owner(), repo: repoName(), branch: state.branch, path };
  state.sha = null;
  state.base = '';
  state.eol = '\n';
  state.bom = false;
  el.editor.value = '';
  setDirty(true);
  renderCrumb();
  renderPreview(true);
  el.editor.focus();
  toast('فایل جدید ایجاد شد — پس از نوشتن، ذخیره را بزنید.');
}

/* ============================================================== keyboard */

function wrap(marker) {
  const ta = el.editor;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const text = ta.value.slice(s, e) || 'متن';
  const next = marker + text + marker;
  ta.focus();
  let ok = false;
  try { ok = document.execCommand('insertText', false, next); } catch { ok = false; }
  if (!ok) {
    ta.setRangeText(next, s, e, 'preserve');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  ta.setSelectionRange(s + marker.length, s + marker.length + text.length);
}

function handleEditorKeys(e) {
  const ta = el.editor;

  // Tab / Shift+Tab -> indent, never leave the editor
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = ta.selectionStart;
    const end = ta.selectionEnd;
    const multiline = ta.value.slice(s, end).includes('\n');
    let ok = false;
    if (multiline && !e.shiftKey) {
      const block = ta.value.slice(s, end).replace(/^/gm, '  ');
      try { ok = document.execCommand('insertText', false, block); } catch { ok = false; }
      if (!ok) { ta.setRangeText(block, s, end, 'preserve'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    } else if (multiline && e.shiftKey) {
      const block = ta.value.slice(s, end).replace(/^ {1,2}/gm, '');
      try { ok = document.execCommand('insertText', false, block); } catch { ok = false; }
      if (!ok) { ta.setRangeText(block, s, end, 'preserve'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    } else if (e.shiftKey) {
      const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
      if (ta.value.slice(lineStart, lineStart + 2) === '  ') {
        ta.setSelectionRange(lineStart, lineStart + 2);
        try { ok = document.execCommand('delete'); } catch { ok = false; }
        if (!ok) { ta.setRangeText('', lineStart, lineStart + 2, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    } else {
      try { ok = document.execCommand('insertText', false, '  '); } catch { ok = false; }
      if (!ok) { ta.setRangeText('  ', s, end, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    return;
  }

  // Enter -> continue lists (including task items)
  if (e.key === 'Enter' && !e.shiftKey && ta.selectionStart === ta.selectionEnd) {
    const pos = ta.selectionStart;
    const line = ta.value.slice(ta.value.lastIndexOf('\n', pos - 1) + 1, pos);
    const m = /^(\s*)([-*+]|(\d+)([.)]))\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (!m) return;
    const body = m[6];
    e.preventDefault();
    let insert = '\n';
    if (body.trim()) {
      const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
      const task = m[5] ? (m[5].trim().startsWith('[x') ? '[x] ' : '[ ] ') : '';
      insert = `\n${m[1]}${marker} ${task}`;
    }
    let ok = false;
    try { ok = document.execCommand('insertText', false, insert); } catch { ok = false; }
    if (!ok) {
      ta.setRangeText(insert, pos, pos, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}

function onKeydown(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey) return;
  if (el.app.hidden) return;

  const inEditor = e.target === el.editor;

  switch (e.code) {
    case 'KeyS':
      if (!inEditor) return;
      e.preventDefault();
      save();
      break;
    case 'KeyE':
      e.preventDefault();
      applyView(p.view === 'preview' ? 'edit' : 'preview');
      break;
    case 'KeyF':
      if (e.shiftKey) { e.preventDefault(); finder.open('replace'); return; }
      if (!inEditor) return;                 // let the browser find in the preview
      e.preventDefault();
      finder.open('find');
      break;
    case 'KeyH':
      if (!inEditor) return;
      e.preventDefault();
      finder.open('replace');
      break;
    case 'KeyB':
      if (!inEditor) return;
      e.preventDefault();
      wrap('**');
      break;
    case 'KeyI':
      if (!inEditor) return;
      e.preventDefault();
      wrap('*');
      break;
    default:
      break;
  }
}

function onGlobalKeydown(e) {
  if (e.key === 'Escape') {
    if (finder && finder.isOpen) {
      e.preventDefault();
      e.stopPropagation();
      finder.close();
    }
  }
}

/* ================================================================ stats */

let draftTimer = null;
function onEditorInput() {
  const dirty = serialize() !== state.base;
  if (dirty !== state.dirty) setDirty(dirty);
  renderPreview();
  updateStats();

  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!state.file || !state.dirty) return;
    store.drafts.save(owner(), repoName(), state.branch, state.file.path, el.editor.value, state.sha);
  }, 800);
}

function updateStats() {
  const text = el.editor.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  el.statCount.textContent = `${faDigits(words)} واژه · ${faDigits(text.length)} نویسه`;

  const pos = el.editor.selectionStart;
  const line = text.slice(0, pos).split('\n').length;
  const col = pos - (text.lastIndexOf('\n', pos - 1) + 1) + 1;
  el.statFile.textContent = state.file
    ? `${state.file.path} — سطر ${faDigits(line)}, ستون ${faDigits(col)}`
    : 'هیچ فایلی باز نیست';
}

/* ================================================================ events */

function applyTheme(theme) {
  p = store.prefs.set({ theme });
  document.documentElement.dataset.theme = theme;
  el.btnTheme.textContent = theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '🌓';
  el.btnTheme.title = theme === 'dark' ? 'پوسته: تیره' : theme === 'light' ? 'پوسته: روشن' : 'پوسته: خودکار';
}

function applySidebar(visible, width) {
  p = store.prefs.set({ sidebar: visible, sidebarWidth: width });
  document.body.classList.toggle('no-sidebar', !visible);
  if (width) document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
}

function bindEvents() {
  el.authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const token = el.tokenInput.value.trim();
    if (!token) return;
    signIn(token, el.remember.checked);
  });

  el.btnUser.addEventListener('click', () => {
    if (confirm('خروج؟ توکن ذخیره‌شده حذف می‌شود (در خود گیت‌هاب همچنان معتبر است).')) signOut();
  });

  el.repoFilter.addEventListener('input', renderRepos);
  el.fileFilter.addEventListener('input', paintTree);
  el.onlyMd.addEventListener('change', () => {
    p = store.prefs.set({ onlyMarkdown: el.onlyMd.checked });
    paintTree();
  });

  el.btnRefreshRepos.addEventListener('click', startup);
  el.btnRefreshTree.addEventListener('click', loadTree);

  el.btnNew.addEventListener('click', newFile);
  el.btnSave.addEventListener('click', save);
  el.btnReload.addEventListener('click', () => {
    if (!state.file) return;
    openFile(state.file.path, { force: true });
  });
  el.btnView.addEventListener('click', () => applyView(p.view === 'preview' ? 'edit' : 'preview'));
  el.btnSplit.addEventListener('click', () => applyView(p.view === 'split' ? 'edit' : 'split'));
  el.btnFind.addEventListener('click', () => finder.open('find'));
  el.btnSidebar.addEventListener('click', () => applySidebar(!p.sidebar, p.sidebarWidth));
  el.btnTheme.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    applyTheme(order[(order.indexOf(p.theme) + 1) % order.length]);
  });

  el.editor.addEventListener('input', onEditorInput);
  el.editor.addEventListener('keydown', handleEditorKeys);
  el.editor.addEventListener('click', updateStats);
  el.editor.addEventListener('keyup', updateStats);

  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('keydown', onGlobalKeydown);

  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  api.on('unauthorized', () => {
    store.token.clear();
    api.setToken('');
    showAuth('توکن نامعتبر یا منقضی شده است. توکن جدید وارد کنید.');
  });

  api.on('rate', (info) => {
    el.statRate.textContent = `API: ${faDigits(info.remaining)}`;
    el.statRate.classList.toggle('is-low', info.remaining < 100);
    if (info.remaining === 0) {
      const at = new Date(info.reset);
      toast(`سقف درخواست‌ها پر شد — تا ${clock(at)} صبر کنید.`, 'error');
    }
  });

  /* sidebar resizer (RTL: the sidebar sits on the right) */
  let startX = 0;
  let startW = 0;
  el.resizer.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
    startW = el.sidebar.getBoundingClientRect().width;
    el.resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('is-resizing');
  });
  el.resizer.addEventListener('pointermove', (e) => {
    if (!el.resizer.hasPointerCapture(e.pointerId)) return;
    const width = Math.min(640, Math.max(200, startW + (startX - e.clientX)));
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
  });
  el.resizer.addEventListener('pointerup', (e) => {
    if (!el.resizer.hasPointerCapture(e.pointerId)) return;
    el.resizer.releasePointerCapture(e.pointerId);
    document.body.classList.remove('is-resizing');
    const width = Math.round(el.sidebar.getBoundingClientRect().width);
    p = store.prefs.set({ sidebarWidth: width });
  });
  el.resizer.addEventListener('dblclick', () => applySidebar(true, 300));
}

/* ================================================================== boot */

function boot() {
  const ids = [
    'app', 'auth', 'authForm', 'authError', 'tokenInput', 'remember',
    'topbar', 'btnSidebar', 'crumb', 'btnNew', 'btnReload', 'btnView', 'btnSplit',
    'btnFind', 'btnSave', 'btnTheme', 'btnUser',
    'sidebar', 'repoFilter', 'repoList', 'btnRefreshRepos', 'treeTitle',
    'fileFilter', 'onlyMd', 'fileTree', 'btnRefreshTree', 'resizer',
    'editorPane', 'editor', 'previewPane', 'frontMatter', 'preview',
    'statFile', 'statState', 'statCount', 'statRate', 'toast',
    'findbar', 'findInput', 'findCount', 'findPrev', 'findNext', 'findCase',
    'replaceInput', 'replaceOne', 'replaceAll', 'findClose',
    'dlgCommit', 'commitPath', 'commitMsg', 'commitBranch',
    'dlgNew', 'newPath', 'dlgConflict', 'dlgDraft', 'draftInfo',
  ];
  for (const id of ids) el[id] = $(id);

  finder = createFinder({
    bar: el.findbar,
    input: el.findInput,
    replaceInput: el.replaceInput,
    counter: el.findCount,
    ta: el.editor,
    btnNext: el.findNext,
    btnPrev: el.findPrev,
    btnReplace: el.replaceOne,
    btnReplaceAll: el.replaceAll,
    btnClose: el.findClose,
    btnCase: el.findCase,
    onMessage: (msg) => toast(msg),
  });

  bindEvents();

  el.onlyMd.checked = p.onlyMarkdown !== false;
  applyTheme(p.theme || 'auto');
  applySidebar(p.sidebar !== false, p.sidebarWidth || 300);
  applyView(p.view || 'edit');
  updateStats();

  const token = store.token.get();
  if (token) {
    api.setToken(token);
    el.app.hidden = true;
    api.user()
      .then((u) => {
        state.user = u;
        renderUser();
        el.app.hidden = false;
        el.auth.hidden = true;
        return startup();
      })
      .catch((err) => {
        if (err instanceof api.ApiError && err.status === 401) {
          store.token.clear();
          showAuth('توکن ذخیره‌شده دیگر معتبر نیست.');
        } else {
          showAuth('اتصال برقرار نشد: ' + err.message);
        }
      });
  } else {
    showAuth('');
  }
}

document.addEventListener('DOMContentLoaded', boot);
