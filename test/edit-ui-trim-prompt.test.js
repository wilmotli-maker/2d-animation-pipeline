// test/edit-ui-trim-prompt.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrimPrompt } from '../src/edit-ui/trim-prompt.js';

// The edit prompt is now rebuilt in the SHOT-AUTHOR structure (Style & Mood / Dynamic
// Description / Static Description / Total runtime / Audio), reusing the shot-generation
// components, instead of the old five-paragraph "edit" format. It composes everything from
// the inputs (style lock + frames + pose); it never reads the source shot's own prompt.

test('keyframe prompt pins first, each pose at its offset, and last, scoping mouth to lip-sync', () => {
  const p = buildTrimPrompt({ dialogue: 'Hello there', clipDuration: 4, poses: [{ offset: 2 }], gesture: 'raise a fist' });
  assert.match(p, /@Video1/);
  assert.match(p, /"Hello there"/);
  assert.match(p, /@Image1 at 0\.0s/);
  assert.match(p, /@Image2 at 2\.0s/);
  assert.match(p, /@Image3 at 4\.0s/);
  assert.match(p, /BODY and EYES only/i);       // mouth keeps lip-syncing through the keyframe
  assert.match(p, /raise a fist/);              // injected-pose description folded in
});

test('text-pose prompt describes a mid-clip gesture peaking at its offset, not a middle keyframe', () => {
  const p = buildTrimPrompt({ dialogue: 'Hi', clipDuration: 4, poses: [], gesture: 'looks surprised, both hands raised', gestureOffset: 2 });
  assert.match(p, /STARTS exactly on the attached first reference frame/i);  // start/end pinned (framing)
  assert.match(p, /ENDS exactly on the attached last reference frame/i);
  assert.match(p, /@Image1/);
  assert.match(p, /@Image2/);
  assert.match(p, /peaking at about 2\.0s/);
  assert.match(p, /distinct new gesture not present in @Image1 or @Image2/);
  assert.match(p, /eases/i);
  assert.match(p, /looks surprised, both hands raised/);
  assert.doesNotMatch(p, /@Image3/);            // only two stills in text-pose
});

test('reuses the shot-generation speech + animation components (no repeats, never-freeze, fully animated)', () => {
  const p = buildTrimPrompt({ dialogue: 'One two three', clipDuration: 4, poses: [], gesture: 'waves', gestureOffset: 2 });
  assert.match(p, /speaking each word once/i);                 // anti-repeat guard (shot-author)
  assert.match(p, /no repeats/i);
  assert.match(p, /NEVER hold the mouth static or freeze it/i);// mouth never freezes, even near the face
  assert.match(p, /keep lip-syncing even while/i);
  assert.match(p, /FULLY animated/i);                          // no pose-to-pose snapping
  assert.match(p, /no abrupt snaps/i);
});

test('reuses the shot-author three-part structure with an audio rule and a runtime line', () => {
  const p = buildTrimPrompt({ dialogue: 'x', clipDuration: 4, poses: [], gesture: 'waves', gestureOffset: 2 });
  assert.match(p, /Style & Mood:/);
  assert.match(p, /Dynamic Description:/);
  assert.match(p, /Static Description:/);
  assert.match(p, /Total runtime: 4\.0s/);
  assert.match(p, /ONLY the exact voice from the attached speech reference/i);
  assert.match(p, /NO music/i);
});

test('the framing paragraph keeps the full figure, locks the camera, and uses a 3:4 frame', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], gesture: 'waves' });
  assert.match(p, /3:4/);
  assert.match(p, /COMPLETE FULL BODY/i);
  assert.match(p, /locked frame/i);
  assert.match(p, /BOTH feet/);                        // enumerated full figure
  assert.match(p, /NEVER crop/i);
});

test('a style lock carries the character design into the Static Description', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], gesture: 'waves', styleLock: 'a red cartoon dragon with a pale belly' });
  assert.match(p, /a red cartoon dragon with a pale belly/);
});

test('fixes the stray turnaround-frame clause — no single-turnaround or named-png anchor', () => {
  const p = buildTrimPrompt({ dialogue: 'hi', clipDuration: 4, poses: [], gesture: 'waves', gestureOffset: 2, styleLock: 'a robot (00-ai-3qfront.png is the ref)' });
  // The builder must not reintroduce the shot-author single-turnaround phrasing.
  assert.doesNotMatch(p, /turnaround/i);
  assert.doesNotMatch(p, /opening first frame of the shot/i);
  assert.doesNotMatch(p, /single design\/rendering anchor/i);
});

test('no props guard is present (edits often inject empty-handed gestures)', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], gesture: 'shrugs', gestureOffset: 2 });
  assert.match(p, /no prop ever appears|hands.*empty|nothing is held/i);
});
