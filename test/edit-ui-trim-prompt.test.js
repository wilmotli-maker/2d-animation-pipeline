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
  assert.match(p, /freeze WHILE a word is being spoken/i);     // never-freeze scoped to speech, not the whole clip
  assert.match(p, /keep lip-syncing even while/i);
  assert.match(p, /FULLY animated/i);                          // no pose-to-pose snapping
  assert.match(p, /no abrupt snaps/i);
});

test('the animation block invokes animation principles broadly and rejects uniform mechanical tweening', () => {
  // The fix for stiff keyframe lerps: don't script a specific arc (anticipation→overshoot→settle),
  // point at the PRINCIPLES generally and name the failure mode (even, linear, machine-smooth motion)
  // so the model supplies expressive dynamics per shot. Character-agnostic — the styleLock carries specifics.
  const p = buildTrimPrompt({ dialogue: 'hi', clipDuration: 4, poses: [], gesture: 'waves', gestureOffset: 2 });
  assert.match(p, /principles of good character animation/i);
  assert.match(p, /anticipation and follow-through/i);
  assert.match(p, /overlapping and secondary motion/i);
  assert.match(p, /uniform, even, mechanically smooth rate/i);   // names the lerp as the thing to avoid
  assert.match(p, /straight, linear path/i);
  assert.doesNotMatch(p, /eases smoothly between beats/i);       // the old contradictory phrasing is gone
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
  assert.match(p, /Reproduce the EXACT framing shown in the reference frames/i);
  assert.match(p, /orientation and viewpoint/i);                     // viewpoint-agnostic, from frames
  assert.doesNotMatch(p, /3:4/);                                     // no fixed aspect
  assert.doesNotMatch(p, /COMPLETE FULL BODY/i);                     // no fixed shot size
  assert.doesNotMatch(p, /three-quarter-front/i);                    // no assumed viewpoint
});

test('explicit aspect + full-length framing hint state the ratio and the head→feet anti-crop language', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], gesture: 'waves', aspect: '3:4', framing: 'full-length' });
  assert.match(p, /Keep a 3:4 frame/);
  assert.match(p, /COMPLETE FULL BODY/i);
  assert.match(p, /BOTH feet/);
  assert.match(p, /NEVER crop/i);
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
