// test/prompt-style.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styleLockToText, styleDirective } from '../src/prompt-style.js';

// styleLockToText normalises a style lock — a free-text string OR the structured style-lock.yaml
// object (see docs/style-lock-schema.md) — into one prose design directive for the prompt, so BOTH
// the edit prompt (trim-prompt.js) and the harmonize restyle prompt (harmonize.js) can carry the
// real per-character lock, not just a hand-typed string.

test('a free-text string passes through, trimmed (backward compatible)', () => {
  assert.equal(styleLockToText('  a red cartoon dragon, pale belly  '), 'a red cartoon dragon, pale belly');
});

test('null / undefined / empty-ish values yield an empty string (→ caller falls back to generic)', () => {
  assert.equal(styleLockToText(null), '');
  assert.equal(styleLockToText(undefined), '');
  assert.equal(styleLockToText(''), '');
  assert.equal(styleLockToText({}), '');
  assert.equal(styleLockToText({ palette: [], notes: '  ' }), '');
});

test('an illustrated style-lock object is phrased into prose with all its conventional fields', () => {
  const t = styleLockToText({
    styleRegister: 'flat-cartoon',
    palette: ['#1b1b1b', '#ff5a5f'],
    lineWeight: 2,
    proportions: 'chibi',
    wardrobe: 'red hoodie, denim shorts',
    notes: 'no gradients; hard cel shading only',
  });
  assert.match(t, /flat-cartoon style/);
  assert.match(t, /chibi proportions/);
  assert.match(t, /line weight 2/);
  assert.match(t, /palette #1b1b1b, #ff5a5f/);
  assert.match(t, /wardrobe: red hoodie, denim shorts/);
  assert.match(t, /no gradients; hard cel shading only/);
});

test('a photoreal style-lock object is phrased into prose', () => {
  const t = styleLockToText({
    skin: 'visible pores, subsurface scattering',
    hair: 'strand-by-strand, warm brown',
    fabric: 'cotton weave',
    grade: 'Kodak Vision3, low contrast',
    wardrobe: 'charcoal wool coat',
  });
  assert.match(t, /skin: visible pores, subsurface scattering/);
  assert.match(t, /hair: strand-by-strand, warm brown/);
  assert.match(t, /fabric: cotton weave/);
  assert.match(t, /grade: Kodak Vision3, low contrast/);
  assert.match(t, /wardrobe: charcoal wool coat/);
});

test('unrecognised keys are not dropped — they are labelised into readable prose', () => {
  const t = styleLockToText({ styleRegister: 'anime', logoPlacement: 'left chest', eye_color: 'amber' });
  assert.match(t, /anime style/);
  assert.match(t, /logo placement: left chest/);
  assert.match(t, /eye color: amber/);
});

test('styleDirective uses the locked directive with the composed prose when given an object', () => {
  const out = styleDirective({ styleRegister: 'flat-cartoon', wardrobe: 'red hoodie' }, {
    locked: (lock) => `LOCKED(${lock})`,
    generic: 'GENERIC',
  });
  assert.match(out, /^LOCKED\(/);
  assert.match(out, /flat-cartoon style/);
  assert.match(out, /wardrobe: red hoodie/);
});

test('styleDirective falls back to the generic directive for an empty object', () => {
  const out = styleDirective({}, { locked: (lock) => `LOCKED(${lock})`, generic: 'GENERIC' });
  assert.equal(out, 'GENERIC');
});
