// test/edit-ui-trim-prompt.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrimPrompt } from '../src/edit-ui/trim-prompt.js';

test('keyframe prompt pins first, each pose at its offset, and last, scoping mouth to lip-sync', () => {
  const p = buildTrimPrompt({ dialogue: 'Hello there', clipDuration: 4, poses: [{ offset: 2 }], gesture: 'raise a fist' });
  assert.match(p, /@Video1/);
  assert.match(p, /"Hello there"/);
  assert.match(p, /@Image1 at 0\.0s/);
  assert.match(p, /@Image2 at 2\.0s/);
  assert.match(p, /@Image3 at 4\.0s/);
  assert.match(p, /BODY and EYES only/i);       // mouth keeps lip-syncing
  assert.match(p, /raise a fist/);              // injected-pose description folded in
});

test('text-pose prompt describes a mid-clip gesture peaking at its offset, not a middle keyframe', () => {
  const p = buildTrimPrompt({ dialogue: 'Hi', clipDuration: 4, poses: [], gesture: 'looks surprised, both hands raised', gestureOffset: 2 });
  assert.match(p, /STARTS on the first reference frame at 0\.0s/);
  assert.match(p, /ENDS on the last reference frame at 4\.0s/);
  assert.match(p, /peaking at about 2\.0s/);
  assert.match(p, /distinct new gesture not present in the start or end frames/);
  assert.match(p, /eases back/);
  assert.match(p, /looks surprised, both hands raised/);
  assert.doesNotMatch(p, /@Image3/);            // only two stills in text-pose
});

test('the framing paragraph preserves the source shot composition and locks the camera', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], gesture: 'waves' });
  assert.match(p, /existing framing/i);
  assert.match(p, /locked camera/i);
  assert.match(p, /Do not crop, zoom, pan/i);
});

test('a style lock is folded into the opening paragraph when provided', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], gesture: 'waves', styleLock: 'a red cartoon dragon with a pale belly' });
  assert.match(p, /a red cartoon dragon with a pale belly/);
});

test('without a style lock the prompt still preserves appearance from the reference frames', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], gesture: 'waves' });
  assert.match(p, /reference frames/i);
  assert.match(p, /Match the exact art style of the reference frames/i);  // render-style preservation
});

test('empty dialogue still produces a valid prompt without an empty quote clause', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], gesture: 'waves' });
  assert.doesNotMatch(p, /saying, ""/);
});
