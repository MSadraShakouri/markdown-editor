// js/prefs.mjs — the settings this app remembers between visits.
//
// One table, one reader, one writer. Every read falls back to the default when
// the stored value is missing or unreadable, so a stale or hand-edited
// localStorage value cannot put the app into a state nobody tested, and a
// browser with storage switched off still runs (the choice just does not stick).
//
// The keys are the ones the app already used (`editor_wrap`, and now
// `editor_toolbar` / `find_query`), so an existing visitor keeps their setting.
// Nothing here is a secret: no token, no repo name, nothing about the account.

/** @type {Record<string, {key: string, fallback: boolean|string}>} */
export const PREFS = {
  /** Soft-wrap long lines. ON by default: wrapping is what removes the sideways
   *  scrolling, and a hard-wrapped Persian paragraph is unreadable on a phone. */
  wrap: { key: 'editor_wrap', fallback: true },

  /** The formatting toolbar above the editor (H1, quote, task list…). OFF by
   *  default — the editor is a writing surface first, and every toolbar action
   *  has a keyboard path (Ctrl+B, Ctrl+I, Ctrl+K, Enter continues a list…).
   *  Turned on from the app's settings dialog. */
  toolbar: { key: 'editor_toolbar', fallback: false },

  /** The line-number gutter. ON by default: it is how you find your place in a
   *  long file, and on mobile it is a couple of characters wide. */
  lineNumbers: { key: 'editor_line_numbers', fallback: true },

  /** The last thing searched for; the find bar reopens with it still there. */
  findQuery: { key: 'find_query', fallback: '' },
};

/** Read one pref, coerced to the type of its default. */
export function readPref(name) {
  const pref = PREFS[name];
  if (!pref) throw new Error(`unknown pref: ${name}`);
  let raw = null;
  try { raw = localStorage.getItem(pref.key); } catch { /* blocked storage */ }
  if (raw === null) return pref.fallback;
  // Booleans are stored as '0'/'1'; accept 'false'/'true' too, because a value
  // written by hand (or by an older version) should not read as `true` by
  // accident — `Boolean('0')` is true, which is exactly the trap here.
  if (typeof pref.fallback === 'boolean') return raw !== '0' && raw !== 'false';
  return raw;
}

/** Write one pref. Never throws: a full or disabled storage is not a failure. */
export function writePref(name, value) {
  const pref = PREFS[name];
  if (!pref) throw new Error(`unknown pref: ${name}`);
  const raw = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  try { localStorage.setItem(pref.key, raw); } catch { /* blocked storage */ }
}
