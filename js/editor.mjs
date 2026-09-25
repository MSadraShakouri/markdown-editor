// js/editor.mjs — the markdown editor surface, built on the vendored CodeMirror 6.
//
// This module owns everything that used to be four hand-rolled layers around a
// <textarea>: the text, soft wrapping, line numbers, search highlighting,
// formatting commands and the typing keys. The rest of the app (files, GitHub,
// preview, demo) talks to the small surface returned by createEditor().
//
// Why CodeMirror instead of the textarea + overlay stack:
//   * the overlay had to be kept in sync with the textarea by copying scrollTop
//     and scrollLeft, and it drifted as soon as the two layers disagreed about
//     anything (direction, trailing newline, scrollbar width). Highlights are
//     now decorations inside the same scroll box as the text, so they cannot
//     drift by construction;
//   * after soft wrapping, one logical line is several visual rows, which a
//     fixed-height gutter cannot express. CM measures and paints the numbers;
//   * search/replace goes through real editor transactions, so undo keeps
//     working without the execCommand('insertText') trick.
//
// Persian/RTL notes (all verified in Chromium — see tests/browser.test.mjs):
//   * every rendered line gets dir="auto" (autoDirPlugin below), so each line
//     resolves its own direction from its own first strong character — the same
//     rule <textarea dir="auto"> used;
//   * EditorView.perLineTextDirection makes CM agree with that, so the caret,
//     selection and cursor motion follow per-line visual order;
//   * the text stays in the DOM (no canvas), so Vazirmatn, ZWNJ and Persian
//     digits are shaped by the browser exactly as they were.

import { state as stateNS, view as viewNS, commands as cmdNS, language as langNS,
         search as searchNS, markdown as mdNS, highlight as hlNS } from '../vendor/codemirror.esm.js';

const { EditorState, EditorSelection, Compartment, StateField, StateEffect, RangeSetBuilder } = stateNS;
const { EditorView, keymap, lineNumbers, Decoration, ViewPlugin, placeholder,
        highlightActiveLine } = viewNS;
const { defaultKeymap, history, historyKeymap, undo, redo } = cmdNS;
const { syntaxHighlighting, HighlightStyle } = langNS;
const { SearchQuery } = searchNS;
const { markdown: markdownLang } = mdNS;
const { tags } = hlNS;

/** Persian digits in the gutter, without touching the document text. */
const faNum = (n) => Number(n).toLocaleString('fa-IR');

// --------------------------------------------------------------- editor theme
// Structure only: font, rhythm, spacing, the wrapping column. Colours, gutters
// and the markdown skin live in css/app.css under .cm-*, so the editor is themed
// in the same place as the rest of the app and the mobile media query can
// restyle it without any JS (the old three-copies-of-the-same-rule problem).
const editorialTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '16px' },
  '.cm-scroller': {
    fontFamily: "'Vazirmatn', 'Segoe UI', Tahoma, system-ui, sans-serif",
    lineHeight: '1.85',
  },
  '.cm-content': {
    padding: '1rem 1.25rem',
    // A readable measure, centred in the pane. Padding (not max-width) keeps the
    // lines inside the scroll box, so dragging past the last line still works.
    paddingInline: 'max(1.25rem, calc((100% - 72ch) / 2))',
    tabSize: '2',
    minHeight: '100%',
  },
  // CM's default inline padding shifts the text out of the gutter's column.
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
});

// ------------------------------------------------------- per-line direction
// dir="auto" is what <textarea dir="auto"> did for the whole control; here it is
// applied per rendered line, so a Persian paragraph and an English paragraph in
// the same document each resolve their own base direction. A dir="auto" element's
// computed style is the *resolved* direction, which is exactly what
// EditorView.textDirectionAt() reads back.
const autoDirPlugin = ViewPlugin.fromClass(class {
  decorations;
  constructor(view) { this.decorations = this.build(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
  }
  build(view) {
    const ranges = [];
    for (const { from, to } of view.visibleRanges) {
      let line = view.state.doc.lineAt(from);
      for (;;) {
        ranges.push(Decoration.line({ attributes: { dir: 'auto' } }).range(line.from));
        if (line.to >= to || line.number >= view.state.doc.lines) break;
        line = view.state.doc.line(line.number + 1);
      }
    }
    return Decoration.set(ranges, true);
  }
}, { decorations: (v) => v.decorations });

// -------------------------------------------------------- search decorations
// The find bar stays the app's own (Persian, in the header); CM only supplies the
// query matching. Matches are painted as real decorations, which is the point:
// they scroll with the text and wrap with it.
const setSearchState = StateEffect.define();

const searchField = StateField.define({
  create: () => ({ ranges: [], current: -1 }),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setSearchState)) return effect.value;
    if (!tr.docChanged || !value.ranges.length) return value;
    const ranges = [];
    for (const r of value.ranges) {
      const from = tr.changes.mapPos(r.from, 1);
      const to = tr.changes.mapPos(r.to, -1);
      if (to > from) ranges.push({ from, to });
    }
    return { ranges, current: ranges.length ? Math.min(value.current, ranges.length - 1) : -1 };
  },
});

const matchMark = Decoration.mark({ class: 'cm-hl-match' });
const currentMark = Decoration.mark({ class: 'cm-hl-match cm-hl-current' });

const searchPlugin = ViewPlugin.fromClass(class {
  decorations;
  constructor(view) { this.decorations = this.build(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged
        || update.state.field(searchField) !== update.startState.field(searchField)) {
      this.decorations = this.build(update.view);
    }
  }
  /** Only decorate what is near the viewport: a 20k-match document must not build
   *  20k decorations on every keystroke. `ranges` is already in document order. */
  build(view) {
    const { ranges, current } = view.state.field(searchField);
    if (!ranges.length) return Decoration.none;
    const visible = view.visibleRanges;
    const lo = visible[0].from;
    const hi = visible[visible.length - 1].to;
    const builder = new RangeSetBuilder();
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (r.to < lo) continue;
      if (r.from > hi) break;
      builder.add(r.from, r.to, i === current ? currentMark : matchMark);
    }
    return builder.finish();
  }
}, { decorations: (v) => v.decorations });

// --------------------------------------------------------------- formatting
// The toolbar's commands, ported from the textarea implementation so the
// behaviour people already know does not change: a line prefix toggles off when
// every selected line already has it, ordered lists renumber, and an existing
// heading/list prefix is replaced rather than stacked.
const HEADING = /^(#{1,6}\s*)/;
const BULLET = /^(\s*[-*+]\s+|\s*>\s*|\s*\d+[.)]\s+)/;
const ORDERED = /^\s*\d+[.)]\s+/;

function selectedLines(state) {
  const sel = state.selection.main;
  const first = state.doc.lineAt(sel.from);
  const last = state.doc.lineAt(sel.to);
  const lines = [];
  for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n));
  return lines;
}

function changesForLines(state, fn) {
  const changes = [];
  for (const line of selectedLines(state)) {
    const next = fn(line.text, line.number);
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  }
  return changes;
}

function toggleLinePrefix(view, prefix) {
  const { state } = view;
  const texts = selectedLines(state).map((l) => l.text);
  const allPrefixed = texts.every((t) => !t.trim() || t.startsWith(prefix));
  const changes = changesForLines(state, (text) => {
    if (!text.trim()) return text;
    if (allPrefixed) return text.startsWith(prefix) ? text.slice(prefix.length) : text;
    if (prefix.startsWith('#')) return prefix + text.replace(HEADING, '');
    if (prefix === '- ' || prefix === '- [ ] ' || prefix === '> ') return prefix + text.replace(BULLET, '');
    return prefix + text;
  });
  if (!changes.length) return;
  view.dispatch({ changes, userEvent: 'input.format' });
  view.focus();
}

function toggleOrderedList(view) {
  const { state } = view;
  const texts = selectedLines(state).map((l) => l.text);
  const allNumbered = texts.every((t) => !t.trim() || ORDERED.test(t));
  let num = 1;
  const changes = changesForLines(state, (text) => {
    if (!text.trim()) return text;
    if (allNumbered) return text.replace(ORDERED, '');
    return `${num++}. ${text.replace(BULLET, '')}`;
  });
  if (!changes.length) return;
  view.dispatch({ changes, userEvent: 'input.format' });
  view.focus();
}

/** Wrap/unwrap the selection and keep it selected, for every selection range. */
function wrapSelection(view, before, after = before) {
  const { state } = view;
  const changes = [];
  const selections = [];
  for (const sel of state.selection.ranges) {
    const selected = state.sliceDoc(sel.from, sel.to);
    const outerBefore = state.sliceDoc(Math.max(0, sel.from - before.length), sel.from);
    const outerAfter = state.sliceDoc(sel.to, Math.min(state.doc.length, sel.to + after.length));
    if (outerBefore === before && outerAfter === after) {
      changes.push({ from: sel.from - before.length, to: sel.from, insert: '' });
      changes.push({ from: sel.to, to: sel.to + after.length, insert: '' });
      selections.push(EditorSelection.range(sel.from - before.length, sel.to - before.length));
    } else {
      const text = selected || 'متن';
      changes.push({ from: sel.from, to: sel.to, insert: before + text + after });
      selections.push(EditorSelection.range(sel.from + before.length, sel.from + before.length + text.length));
    }
  }
  view.dispatch({ changes, selection: EditorSelection.create(selections), userEvent: 'input.format' });
  view.focus();
}

function insertSnippet(view, text, caret) {
  const sel = view.state.selection.main;
  const at = sel.from;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: at + (caret ?? text.length) },
    userEvent: 'input.format',
  });
  view.focus();
}

// ------------------------------------------------------------------ create
/**
 * @param {object} opts
 * @param {HTMLElement} opts.parent            element the editor mounts into
 * @param {string}  [opts.doc]                 initial text
 * @param {boolean} [opts.wrap]                soft wrap on/off
 * @param {string}  [opts.placeholder]
 * @param {(text: string) => void} [opts.onChange]
 * @param {() => void} [opts.onCursor]
 * @param {() => void} [opts.onScroll]
 */
export function createEditor({
  parent, doc = '', wrap = true, lineNumbers: showLineNumbers = true,
  placeholder: placeholderText = '', onChange, onCursor, onScroll,
}) {
  const wrapCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const gutterCompartment = new Compartment();
  let suppressChange = false;
  // Tracked here, not only in the compartments: setValue() rebuilds the state
  // from the extension list below, and a plain `extensions` array would come back
  // with the *initial* wrap/read-only configuration, silently undoing both.
  let wrapOn = !!wrap;
  let readOnlyOn = false;
  let gutterOn = !!showLineNumbers;

  // The line-number gutter is its own compartment, so turning it off costs one
  // reconfigure instead of a rebuilt document (and therefore keeps the undo
  // history, the selection and the scroll position).
  const gutterExt = () => (gutterOn ? lineNumbers({ formatNumber: (n) => faNum(n) }) : []);

  const baseExtensions = [
    history(),
    highlightActiveLine(),
    autoDirPlugin,
    searchField,
    searchPlugin,
    // dir="auto" plus Persian keyboard habits: no autocorrect or autocapitalise
    // fighting the text, and spellcheck off as the textarea had it.
    EditorView.contentAttributes.of({
      dir: 'auto', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off',
      'aria-label': 'متن مارک‌داون',
    }),
    EditorView.perLineTextDirection.of(true),
    markdownLang(),
    syntaxHighlighting(HighlightStyle.define([
      // Markers are dimmed rather than hidden: the text still reads as markdown,
      // but the prose is what the eye lands on.
      { tag: tags.processingInstruction, opacity: '0.4' },
      { tag: tags.heading1, fontWeight: '700', fontSize: '1.45em' },
      { tag: tags.heading2, fontWeight: '700', fontSize: '1.25em' },
      { tag: tags.heading3, fontWeight: '700', fontSize: '1.1em' },
      { tag: tags.heading4, fontWeight: '700' },
      { tag: tags.strong, fontWeight: '700' },
      { tag: tags.emphasis, fontStyle: 'italic' },
      { tag: tags.strikethrough, textDecoration: 'line-through' },
      { tag: tags.link, color: 'var(--accent)' },
      { tag: tags.url, opacity: '0.6' },
      { tag: tags.monospace, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      { tag: tags.quote, color: 'var(--fg-muted)' },
      { tag: tags.list, opacity: '0.7' },
    ])),
    editorialTheme,
    placeholder(placeholderText),
    keymap.of([
      { key: 'Enter', run: continueOnEnter },      // keep lists going
      { key: 'Tab', run: indentMore, shift: outdentLess },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !suppressChange) onChange?.(update.state.doc.toString());
      if (update.selectionSet || update.docChanged) onCursor?.();
    }),
  ];

  const extensions = () => [
    wrapCompartment.of(wrapOn ? EditorView.lineWrapping : []),
    readOnlyCompartment.of(EditorState.readOnly.of(readOnlyOn)),
    gutterCompartment.of(gutterExt()),
    ...baseExtensions,
  ];

  const view = new EditorView({ state: EditorState.create({ doc, extensions: extensions() }), parent });
  view.scrollDOM.addEventListener('scroll', () => onScroll?.(), { passive: true });

  /** Programmatic replacement (opening a file, the conflict flow): no change
   *  event, and the undo history goes with it — you cannot undo into another file. */
  function setValue(text) {
    suppressChange = true;
    try {
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
    } finally {
      suppressChange = false;
    }
  }

  // -------------------------------------------------------------- searching
  function collectRanges(text, caseSensitive) {
    if (!text) return [];
    const query = new SearchQuery({ search: text, caseSensitive: !!caseSensitive });
    const out = [];
    const cursor = query.getCursor(view.state);
    for (let r = cursor.next(); !r.done; r = cursor.next()) {
      out.push({ from: r.value.from, to: r.value.to });
      if (out.length >= 20000) break;              // same cap the textarea version had
    }
    return out;
  }

  function find(text, { caseSensitive = false } = {}) {
    const ranges = collectRanges(text, caseSensitive);
    const caret = view.state.selection.main.from;
    let index = ranges.findIndex((r) => r.from >= caret);
    if (index < 0 && ranges.length) index = 0;
    view.dispatch({ effects: setSearchState.of({ ranges, current: index }) });
    return { count: ranges.length, index };
  }

  const searchState = () => view.state.field(searchField);

  function showCurrent(ranges, index) {
    const r = ranges[index];
    if (!r) return;
    view.dispatch({
      selection: { anchor: r.from, head: r.to },
      effects: EditorView.scrollIntoView(r.from, { y: 'center' }),
    });
  }

  function step(delta) {
    const { ranges, current } = searchState();
    if (!ranges.length) return { count: 0, index: -1 };
    const index = (current + delta + ranges.length) % ranges.length;
    view.dispatch({ effects: setSearchState.of({ ranges, current: index }) });
    showCurrent(ranges, index);
    return { count: ranges.length, index };
  }

  function replaceCurrent(replacement) {
    const { ranges, current } = searchState();
    if (current < 0 || !ranges.length) return { count: ranges.length, index: current };
    const r = ranges[current];
    const delta = replacement.length - (r.to - r.from);
    const after = ranges.slice(current + 1).map((x) => ({ from: x.from + delta, to: x.to + delta }));
    view.dispatch({
      changes: { from: r.from, to: r.to, insert: replacement },
      effects: setSearchState.of({ ranges: after, current: after.length ? 0 : -1 }),
      selection: { anchor: r.from + replacement.length },
      userEvent: 'input.replace',
    });
    // focus back to the editor, as the textarea version did: undo (Ctrl+Z) is an
    // editor keybinding, and it must work right after a replace.
    view.focus();
    return { count: after.length, index: after.length ? 0 : -1 };
  }

  function replaceAll(replacement) {
    const { ranges } = searchState();
    if (!ranges.length) return 0;
    view.dispatch({
      changes: ranges.map((r) => ({ from: r.from, to: r.to, insert: replacement })),
      effects: setSearchState.of({ ranges: [], current: -1 }),
      userEvent: 'input.replace.all',
    });
    view.focus();
    return ranges.length;
  }

  function clearSearch() {
    view.dispatch({ effects: setSearchState.of({ ranges: [], current: -1 }) });
  }

  // ---------------------------------------------------------------- surface
  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue,
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    getSelection: () => {
      const sel = view.state.selection.main;
      return view.state.sliceDoc(sel.from, sel.to);
    },
    setReadOnly(on) {
      readOnlyOn = !!on;
      view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnlyOn)) });
      view.contentDOM.classList.toggle('is-readonly', readOnlyOn);
    },
    // NOT view.lineWrapping: that reads the height oracle, which is only updated
    // during the next measure pass, so it reports the *previous* value right after
    // a toggle. wrapOn is what the state was actually configured with.
    getWrap: () => wrapOn,
    setWrap(on) {
      wrapOn = !!on;
      view.dispatch({ effects: wrapCompartment.reconfigure(wrapOn ? EditorView.lineWrapping : []) });
      if (!wrapOn) view.scrollDOM.scrollLeft = 0;
      view.requestMeasure();
    },
    // Same rule as getWrap: report the flag the state was configured with, not
    // whatever the DOM happens to look like during the next measure pass.
    getLineNumbers: () => gutterOn,
    setLineNumbers(on) {
      gutterOn = !!on;
      view.dispatch({ effects: gutterCompartment.reconfigure(gutterExt()) });
      view.requestMeasure();
    },
    /** 1-based line number of the caret, used by the preview sync. */
    cursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
    lineCount: () => view.state.doc.lines,
    wordCount: () => {
      const text = view.state.doc.toString().trim();
      return text ? text.split(/\s+/).length : 0;
    },
    charCount: () => view.state.doc.length,
    scrollTop: () => view.scrollDOM.scrollTop,
    /** CM measures lazily; call after a hidden pane becomes visible again. */
    refresh() { view.requestMeasure(); },
    focusCaretIntoView() {
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) });
    },

    undo: () => undo(view),
    redo: () => redo(view),

    format(action) {
      switch (action) {
        case 'h1': return toggleLinePrefix(view, '# ');
        case 'h2': return toggleLinePrefix(view, '## ');
        case 'h3': return toggleLinePrefix(view, '### ');
        case 'bold': return wrapSelection(view, '**', '**');
        case 'italic': return wrapSelection(view, '*', '*');
        case 'strike': return wrapSelection(view, '~~', '~~');
        case 'ul': return toggleLinePrefix(view, '- ');
        case 'ol': return toggleOrderedList(view);
        case 'task': return toggleLinePrefix(view, '- [ ] ');
        case 'quote': return toggleLinePrefix(view, '> ');
        case 'code': return wrapSelection(view, '`', '`');
        case 'codeblock': return insertSnippet(view, '```\n' + (this.getSelection() || '// کد اینجا') + '\n```', 3);
        case 'table': return insertSnippet(view,
          '| ستون ۱ | ستون ۲ | ستون ۳ |\n| --- | --- | --- |\n| داده ۱ | داده ۲ | داده ۳ |\n');
        case 'link': return insertSnippet(view, `[${this.getSelection() || 'متن پیوند'}](https://)`, undefined);
      }
    },

    find,
    findStep: step,
    replaceCurrent,
    replaceAll,
    clearSearch,
    searchState,
    destroy() { view.destroy(); },
  };
}

// ---------------------------------------------------------------- typing keys
// Enter keeps lists going and clears the marker on an empty item — the textarea
// behaviour, kept so muscle memory survives the engine swap.
function continueOnEnter(view) {
  const { state } = view;
  if (state.selection.ranges.some((r) => r.from !== r.to)) return false;
  const changes = [];
  for (const sel of state.selection.ranges) {
    const line = state.doc.lineAt(sel.head);
    const before = state.sliceDoc(line.from, sel.head);
    const m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/.exec(before);
    if (!m) return false;
    const [whole, indent, marker, task] = m;
    if (!before.slice(whole.length).trim()) {
      changes.push({ from: line.from, to: sel.head, insert: '' });   // empty item: drop the marker
      continue;
    }
    const ordered = /^(\d+)([.)])$/.exec(marker);
    const next = ordered ? `${parseInt(ordered[1], 10) + 1}${ordered[2]}` : marker;
    changes.push({ from: sel.head, to: sel.head, insert: '\n' + indent + next + ' ' + (task ? '[ ] ' : '') });
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: 'input.enter' });
  return true;
}

// Tab indents by two spaces (or indents whole lines), Shift+Tab outdents.
// Neither ever moves focus out of the editor.
function indentMore(view) {
  const sel = view.state.selection.main;
  if (sel.empty) {
    view.dispatch({ changes: { from: sel.from, insert: '  ' }, selection: { anchor: sel.from + 2 } });
    return true;
  }
  return reindent(view, true);
}

function outdentLess(view) {
  if (view.state.selection.main.empty) return false;
  return reindent(view, false);
}

function reindent(view, more) {
  const { state } = view;
  const changes = [];
  for (const line of selectedLines(state)) {
    if (more) changes.push({ from: line.from, to: line.from, insert: '  ' });
    else {
      const m = /^ {1,2}/.exec(line.text);
      if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: '' });
    }
  }
  if (!changes.length) return true;
  view.dispatch({ changes });
  return true;
}
