// js/pvsearch.mjs — search inside the RENDERED preview.
//
// The editor search (js/editor.mjs) works on the source text and paints
// decorations. The preview shows different text — the markers are gone, so
// "**bold**" is nowhere to be found but "bold" is — and it is plain DOM, so it
// needs its own engine rather than a second mode bolted onto CodeMirror's.
//
// What it does, in one pass: walk the text nodes under the root, wrap every
// occurrence in <mark class="pv-hl-match">, keep the list in document order, and
// let the caller step through it. `clear()` unwraps them again, so the DOM is
// byte-for-byte what the renderer produced once the search is closed — that
// matters because the preview is re-rendered from source on the next edit, and
// a stray <mark> would end up inside the generated HTML.
//
// Deliberate limitations, both shared with every browser's own find-on-page:
//   * a match that spans two elements (part of it bold, say) is not found, only
//     matches inside a single text node are;
//   * text hidden by CSS is searched too — the preview has no such text today.
//
// It touches no globals and no app state: give it a root element and it works.

const HL = 'pv-hl-match';
const HL_CURRENT = 'pv-hl-current';

/** Case folding for matching. Persian has no case, so this only affects Latin. */
const fold = (s, caseSensitive) => (caseSensitive ? s : s.toLowerCase());

export function createPreviewSearch(root) {
  /** @type {HTMLElement[]} matches, in document order */
  let marks = [];
  let index = -1;

  /** Undo every wrapping, leaving the rendered DOM as the renderer made it. */
  function clear() {
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();          // merge the text nodes the split created
    }
    marks = [];
    index = -1;
  }

  /** Every text node worth searching, in document order. */
  function textNodes() {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentNode;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.nodeName;
        // Scripts and styles hold no user-visible text; <mark> is our own output,
        // which clear() has already removed, but skip it defensively.
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        if (parent.classList?.contains(HL)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const out = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  }

  /** Wrap every occurrence of `query`, right to left so earlier offsets stay valid. */
  function paint(query, caseSensitive) {
    const needle = fold(query, caseSensitive);
    for (const node of textNodes()) {
      const haystack = fold(node.nodeValue, caseSensitive);
      const starts = [];
      for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
        starts.push(at);
      }
      if (!starts.length) continue;
      // Back to front: splitText() numbers every node after the first, so doing
      // it in reverse keeps the offsets of the matches still to come untouched.
      for (let i = starts.length - 1; i >= 0; i--) {
        const from = starts[i];
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, from + needle.length);
        const mark = document.createElement('mark');
        mark.className = HL;
        try {
          range.surroundContents(mark);
        } catch {
          continue;                  // never expected: offsets are inside one node
        }
      }
    }
    // Read the result back out of the DOM: it is in document order by
    // construction, which the loop above (per node, back to front) is not.
    marks = [...root.querySelectorAll(`mark.${HL}`)];
  }

  /** Move the "current" highlight and bring it into view — inside the pane only. */
  function goto(i) {
    index = marks.length ? ((i % marks.length) + marks.length) % marks.length : -1;
    for (const [n, mark] of marks.entries()) mark.classList.toggle(HL_CURRENT, n === index);
    const current = marks[index];
    // 'center' scrolls the nearest scrollable ancestor (the preview pane). The
    // page itself no longer scrolls, so this cannot drag the whole document.
    // jsdom implements no scrolling at all, hence the guard.
    if (current && typeof current.scrollIntoView === 'function') {
      current.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    return { count: marks.length, index };
  }

  return {
    /** Find and highlight everything, from the top. */
    find(query, { caseSensitive = false } = {}) {
      clear();
      if (!query) return { count: 0, index: -1 };
      paint(query, caseSensitive);
      return marks.length ? goto(0) : { count: 0, index: -1 };
    },

    /** Same matches, different current one. Wraps around at both ends. */
    step(delta) {
      if (!marks.length) return { count: 0, index: -1 };
      return goto((index < 0 ? 0 : index + delta));
    },

    /** The element currently highlighted, for tests and for callers that scroll. */
    current: () => marks[index] || null,
    count: () => marks.length,
    clear,
  };
}
