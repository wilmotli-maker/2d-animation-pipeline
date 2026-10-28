// src/prompt-style.js
// Shared rule for folding a character's style lock into a generation prompt, used by BOTH the
// edit/shot-gen prompt (src/edit-ui/trim-prompt.js) and the harmonize restyle prompt (src/harmonize.js)
// so the two never diverge on how render style is driven.
//
// When a style lock is present, use the `locked` directive (which appends the lock verbatim); when
// absent, fall back to the `generic` directive — which MUST be medium-neutral: it defers render style
// to the reference frames and imposes no art style (2D / 3D / cel / hand-drawn / painterly / photoreal)
// the references do not themselves show. This is the guard against the bug where harmonize hardcoded a
// "hand-drawn 2D cartoon" target and overrode a 3D character's own style lock.
// --- Structured style lock → prose -------------------------------------------------------------
// A style lock reaches us either as free text (the edit-ui field) OR as the structured
// style-lock.yaml object the rest of the pipeline persists per element (styleRegister, palette,
// lineWeight, proportions, wardrobe, skin, hair, …; see docs/style-lock-schema.md). Both `locked`
// directives below append the lock as a run of design phrases, so the object has to be flattened
// into one readable string first — otherwise `[object Object]` (or raw YAML) would land in the
// prompt. `styleLockToText` does that flattening, and is the single place that knows the schema.

// The conventional keys, in the order they read best in a prompt, each mapped to how it is phrased.
// A key not listed here is still emitted (its name labelised) so the free-form schema is never
// silently dropped. `notes` goes last and is quoted verbatim.
const STYLE_FIELDS = [
  ['styleRegister', (v) => `${v} style`],
  ['proportions', (v) => `${v} proportions`],
  ['lineWeight', (v) => `line weight ${v}`],
  ['palette', (v) => `palette ${v}`],
  ['wardrobe', (v) => `wardrobe: ${v}`],
  ['skin', (v) => `skin: ${v}`],
  ['hair', (v) => `hair: ${v}`],
  ['fabric', (v) => `fabric: ${v}`],
  ['grade', (v) => `grade: ${v}`],
];

const PHRASE = new Map(STYLE_FIELDS);
const ORDER = STYLE_FIELDS.map(([k]) => k);

// camelCase / snake_case / kebab-case key → spaced lowercase words ("logoPlacement" → "logo placement").
function labelize(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
}

// A value → a trimmed string; an array → its non-empty items joined with ", ".
function valueText(v) {
  if (Array.isArray(v)) return v.map((x) => (x == null ? '' : String(x).trim())).filter(Boolean).join(', ');
  return v == null ? '' : String(v).trim();
}

export function styleLockToText(styleLock) {
  if (styleLock == null) return '';
  if (typeof styleLock !== 'object') return String(styleLock).trim();

  const seen = new Set();
  const parts = [];
  const add = (key) => {
    if (seen.has(key) || key === 'notes' || !(key in styleLock)) return;
    seen.add(key);
    const val = valueText(styleLock[key]);
    if (!val) return;
    const phrase = PHRASE.get(key);
    parts.push(phrase ? phrase(val) : `${labelize(key)}: ${val}`);
  };
  for (const key of ORDER) add(key);
  for (const key of Object.keys(styleLock)) add(key);
  // `notes` always trails, verbatim.
  const notes = valueText(styleLock.notes);
  if (notes) parts.push(notes);
  return parts.join('; ');
}

export function styleDirective(styleLock, { locked, generic }) {
  const lock = styleLockToText(styleLock);
  return lock ? locked(lock) : generic;
}
