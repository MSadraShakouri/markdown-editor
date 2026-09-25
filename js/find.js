/**
 * find.js — the find & replace overlay.
 *
 * Two rules that matter:
 *  1. every edit goes through execCommand('insertText') so the browser's
 *     native undo stack survives (assigning to .value would wipe it);
 *  2. an empty query never reaches split()/join() — 'x'.split('') interleaves
 *     the replacement between every character and destroys the document.
 */

export function createFinder(els) {
  const { bar, input, replaceInput, counter, ta } = els;

  let matches = [];
  let index = -1;
  let caseSensitive = false;
  let query = '';

  const toast = (msg) => els.onMessage && els.onMessage(msg);

  /* ------------------------------------------------------------- matching */

  function scan() {
    query = input.value;
    if (!query) { matches = []; index = -1; paint(); return; }

    const value = ta.value;
    const hay = caseSensitive ? value : value.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    // Unicode gotcha: toLowerCase() can change length (e.g. 'İ'). If it does,
    // indices would no longer map onto the original string — fall back.
    if (hay.length !== value.length) {
      matches = indexOfAll(value, query, true);
    } else {
      matches = indexOfAll(hay, needle, false);
    }
    index = matches.length ? 0 : -1;
    paint();
    if (matches.length) goto(index);
  }

  const indexOfAll = (hay, needle) => {
    const out = [];
    let i = hay.indexOf(needle);
    while (i !== -1) {
      out.push(i);
      i = hay.indexOf(needle, i + needle.length);
    }
    return out;
  };

  function paint() {
    const total = matches.length;
    counter.textContent = total
      ? `${toFa(index + 1)} / ${toFa(total)}`
      : (query ? '۰ / ۰' : '—');
    counter.classList.toggle('is-zero', !!query && total === 0);
  }

  const toFa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);

  function goto(i) {
    if (!matches.length) return;
    index = (i + matches.length) % matches.length;   // wrap around
    const pos = matches[index];
    ta.focus();
    ta.setSelectionRange(pos, pos + query.length);
    scrollToSelection(ta, pos);
    paint();
  }

  /* Replace the current selection (or the current match) with `text`. */
  function replaceSelection(text) {
    ta.focus();
    if (matches.length && index >= 0) {
      const pos = matches[index];
      if (ta.selectionStart !== pos) ta.setSelectionRange(pos, pos + query.length);
    }
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch { ok = false; }
    if (!ok) {
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      ta.setRangeText(text, s, e, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function replaceOne() {
    if (!query) return;
    if (!matches.length) { toast('موردی برای جایگزینی پیدا نشد'); return; }
    replaceSelection(replaceInput.value);
    scan();                       // recompute; the document changed
    toast('جایگزین شد');
  }

  function replaceAll() {
    if (!query) return;                       // guard: split('') is destructive
    const next = ta.value.split(query).join(replaceInput.value);
    const count = matches.length;
    if (!count) { toast('موردی برای جایگزینی پیدا نشد'); return; }

    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, next);
    } catch { ok = false; }
    if (!ok) {
      ta.value = next;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    scan();
    toast(`${toFa(count)} مورد جایگزین شد — Ctrl+Z برای بازگشت`);
  }

  /* ------------------------------------------------------------------ api */

  const api = {
    get isOpen() { return !bar.hidden; },

    open(mode = 'find') {
      const hadSelection = ta.selectionStart !== ta.selectionEnd;
      if (hadSelection && !input.value) {
        input.value = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      }
      bar.hidden = false;
      scan();
      (mode === 'replace' ? replaceInput : input).focus();
      (mode === 'replace' ? replaceInput : input).select();
    },

    close() {
      bar.hidden = true;
      ta.focus();
    },

    next() { if (matches.length) goto(index + 1); },
    prev() { if (matches.length) goto(index - 1); },
    rescan: scan,
  };

  /* --------------------------------------------------------------- events */

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 150);           // do not block typing on big docs
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      api.close();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? api.prev() : api.next(); }
  });
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
    if (e.key === 'Escape') { e.preventDefault(); api.close(); }
  });

  els.btnNext.addEventListener('click', () => api.next());
  els.btnPrev.addEventListener('click', () => api.prev());
  els.btnReplace.addEventListener('click', replaceOne);
  els.btnReplaceAll.addEventListener('click', replaceAll);
  els.btnClose.addEventListener('click', () => api.close());
  els.btnCase.addEventListener('click', () => {
    caseSensitive = !caseSensitive;
    els.btnCase.setAttribute('aria-pressed', String(caseSensitive));
    els.btnCase.classList.toggle('is-on', caseSensitive);
    scan();
  });

  return api;
}

/** Keep the caret visible: textareas do not scroll to setSelectionRange(). */
function scrollToSelection(ta, pos) {
  const before = ta.value.slice(0, pos);
  const line = before.split('\n').length - 1;
  const styles = getComputedStyle(ta);
  const lineHeight = parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.6;
  const visible = ta.clientHeight / lineHeight;
  const target = (line - visible / 2) * lineHeight;
  ta.scrollTop = Math.max(0, Math.min(target, ta.scrollHeight - ta.clientHeight));
}
