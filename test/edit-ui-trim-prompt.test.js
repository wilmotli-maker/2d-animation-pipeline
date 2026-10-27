// test/edit-ui-trim-prompt.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrimPrompt } from '../src/edit-ui/trim-prompt.js';

// The edit prompt is now rebuilt in the SHOT-AUTHOR structure (Style & Mood / Dynamic
// Description / Static Description / Total runtime / Audio), reusing the shot-generation
// components, instead of the old five-paragraph "edit" format. It composes everything from
// the inputs (style lock + frames + pose); it never reads the source shot's own prompt.

test('keyframe prompt pins first, each pose at its offset, and last, with the gesture folded in', () => {
  const p = buildTrimPrompt({ dialogue: 'Hello there', clipDuration: 4, poses: [{ offset: 2 }], gesture: 'raise a fist' });
  assert.match(p, /@Video1/);
  assert.match(p, /"Hello there"/);
  assert.match(p, /@Image1 at 0\.0s/);
  assert.match(p, /@Image2 at 2\.0s/);
  assert.match(p, /@Image3 at 4\.0s/);
  assert.match(p, /raise a fist/);              // injected-pose description folded into the pin
  assert.doesNotMatch(p, /BODY and EYES only/i); // no mouth carve-out on the pin; lip-sync is held by the speech block
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
  assert.match(p, /freeze WHILE a word is being spoken/i);     // never-freeze scoped to speech, not the whole clip
  assert.match(p, /keep lip-syncing even while/i);
  assert.match(p, /fully-animated take/i);                     // one continuous animated take
  assert.match(p, /no held static poses and no snaps/i);       // no pose-to-pose snapping
});

test('the animation block is concise: names lively hand-drawn performance and rejects mechanical tweening', () => {
  // Deliberately terse — over-long prompts can degrade quality. Name the goal (lively hand-drawn
  // performance) and the failure mode (stiff, even, mechanical in-betweening) in one line, leaving the
  // specific dynamics to the model. Character-agnostic — the styleLock carries the specifics.
  const p = buildTrimPrompt({ dialogue: 'hi', clipDuration: 4, poses: [], gesture: 'waves', gestureOffset: 2 });
  assert.match(p, /one continuous, fully-animated take/i);
  assert.match(p, /life of hand-drawn character performance/i);
  assert.match(p, /not stiff, even, mechanical in-betweening/i);  // names the lerp as the thing to avoid
  assert.doesNotMatch(p, /principles of good character animation/i); // the old long paragraph is gone
});

test('closes the mouth through trailing silence and invents no words to fill the clip', () => {
  // A tail/short-line edit: the spoken line ends before the clip does. The prompt must NOT demand
  // lip-sync "for the entire N seconds" (which made the model invent trailing words); it must say the
  // mouth closes after the last word and stays shut through the remaining silence.
  const p = buildTrimPrompt({ dialogue: 'One two three', clipDuration: 4, poses: [], gesture: 'waves', gestureOffset: 2 });
  assert.match(p, /after the last word the mouth closes cleanly and stays closed and still through any remaining silence/i);
  assert.match(p, /do NOT invent, add, mouth, loop, repeat, or continue any words/i);
  assert.doesNotMatch(p, /for the entire 4\.0 seconds/i);      // the old blanket demand is gone
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

test('framing is DERIVED from the reference frames by default — no baked-in aspect or shot size', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], gesture: 'waves' });
  assert.match(p, /same aspect ratio as the reference frames/i);     // not a hardcoded 3:4
  assert.match(p, /Hold the exact framing of the reference frames/i);
  assert.match(p, /camera locked/i);                                 // locked camera, derived from the frames
  assert.doesNotMatch(p, /3:4/);                                     // no fixed aspect
  assert.doesNotMatch(p, /entire figure/i);                          // no fixed full-body shot size
  assert.doesNotMatch(p, /three-quarter/i);                          // no assumed viewpoint
});

test('explicit aspect + full-length framing hint state the ratio and the head→feet anti-crop language', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], gesture: 'waves', aspect: '3:4', framing: 'full-length' });
  assert.match(p, /Keep a 3:4 frame/);
  assert.match(p, /entire figure, from the top of the head through both feet/i);
  assert.match(p, /inside the frame at all times/i);
});

test('a non-portrait aspect and a non-full-body framing hint pass through (not forced to 3:4 full-body)', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], gesture: 'waves', aspect: '16:9', framing: 'waist-up medium shot' });
  assert.match(p, /Keep a 16:9 frame/);
  assert.match(p, /Framing: waist-up medium shot/);
  assert.doesNotMatch(p, /COMPLETE FULL BODY/i);       // did not force full-body
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

test('framing locks the camera against following the action (camera-locked, even as the body moves)', () => {
  // Seedance reframes TOWARD the gesture (zoom to the raised hands). The concise guard is a locked
  // camera that holds even as the body moves — generic, so it holds for tighter source crops too.
  const p = buildTrimPrompt({ dialogue: 'hi', clipDuration: 4, poses: [{ offset: 2 }], gesture: 'raises a fist', aspect: '3:4', framing: 'waist-up medium shot' });
  assert.match(p, /camera locked: no zoom, push-in, pan, tilt or re-crop, even as the body moves/i);
  assert.match(p, /Framing: waist-up medium shot/);          // the hint passes through
  assert.doesNotMatch(p, /entire figure/i);                  // not forced to full-body
});

test('a keyframe pin names the gesture and anchors the arm height + side from the image, with no mouth clause', () => {
  // Finding: a keyframe image ALONE does not reliably constrain the pose (the model mirrors it and
  // under-shoots), so the pin names the gesture and anchors the arm's height + side derived from the
  // image. It carries NO mouth language (that froze the lips) — lip-sync is held by the speech block.
  const p = buildTrimPrompt({ dialogue: 'hi', clipDuration: 4, poses: [{ offset: 2 }], gesture: 'crosses both arms' });
  assert.match(p, /the character crosses both arms/);                 // the derived gesture is folded in
  assert.match(p, /same raised-arm height and the same side as this keyframe/i);
  assert.match(p, /not the opposite arm, not a smaller bent raise/i);
  assert.doesNotMatch(p, /BODY and EYES only/i);                      // no mouth carve-out
  assert.doesNotMatch(p, /mouth ignores the reference/i);
});
