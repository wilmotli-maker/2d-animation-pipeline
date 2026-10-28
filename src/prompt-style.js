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
export function styleDirective(styleLock, { locked, generic }) {
  const lock = (styleLock || '').trim();
  return lock ? locked(lock) : generic;
}
