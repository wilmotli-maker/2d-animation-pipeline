// src/edit-ui/trim-prompt.js
// Compose the targeted-edit prompt for one window by REBUILDING a shot-author-style prompt from
// its components, rather than the old bespoke "edit" five-paragraph format. A targeted edit is just
// a regular shot generation whose only differences are: (a) two or more reference frames — a first
// and a last, optionally a middle pose keyframe — and (b) an injected pose (a text gesture, or a
// pose keyframe) in the middle. So the prompt reuses the shot-generation components — the speech /
// no-repeat / lip-sync guard, the fully-animated / no-snap rule, the full-body framing block, and
// the audio rule — and carries the character design from the caller-supplied `styleLock` (the
// element's style lock). It never reads the source shot's own prompt, so it works even when that
// prompt is unavailable. See templates/skills/targeted-edit-author/SKILL.md.
import { styleDirective } from '../prompt-style.js';

const s1 = (n) => Number(n).toFixed(1);

// --- Reusable shot-generation components (shared language, parameterised by duration) -----------

// Speech + lip-sync: exact words, each once (no repeats/doubles/stutter), and a mouth that never
// freezes — not even while the body reaches the injected pose or the hands pass near the face.
function speechBlock(dialogue, end) {
  const parts = ['The attached speech reference (@Video1) is the voice and timing source.'];
  if (dialogue.trim()) parts.push(`The character speaks directly to camera, saying, "${dialogue.trim()}"`);
  parts.push(
    `Say exactly and only this line, speaking each word once — no repeats, no doubled or echoed syllables, no stutter, and no re-articulating the final word.`,
    `Drive full lip-sync on every spoken syllable so the mouth opens and closes on each word and matches the voice in @Video1, and do not let the mouth go slack or freeze WHILE a word is being spoken — keep lip-syncing even while the body reaches the new pose or the hands move up near the face.`,
    `The spoken line may end before the ${end}-second clip does; after the last word the mouth closes cleanly and stays closed and still through any remaining silence — do NOT invent, add, mouth, loop, repeat, or continue any words to fill the rest of the clip.`,
    `Take the voice and its exact timing ONLY from @Video1; take appearance, body and framing from the still reference frames.`,
  );
  return parts.join(' ');
}

// Fully-animated, no pose-to-pose snapping, and expressive rather than a dead linear tween. Kept
// terse on purpose: over-long prompts can degrade quality, so this names the goal (lively hand-drawn
// performance) and the failure mode (stiff, even, mechanical in-betweening) in one line, leaving the
// specific dynamics to the model. (Future: could be driven by a per-character MOTION style lock.)
const animationBlock =
  'The whole clip is ONE continuous, fully-animated take — no held static poses and no snaps. Animate ' +
  'it with the life of hand-drawn character performance: expressive, naturally-timed motion, not stiff, ' +
  'even, mechanical in-betweening.';

// Framing block — DERIVED, not fixed. An edit must match its source shot, so the aspect ratio,
// shot size and viewpoint all come from the reference frames (or an explicit caller hint), never a
// baked-in "3:4 full-body". `aspect` (e.g. '16:9', '3:4') states the ratio when known; `framing` is
// an optional shot-size hint ('full-length', 'waist-up', 'close-up on the face', …) — when it reads
// as full-length the enumerated head→feet anti-crop language is added, otherwise it is quoted as-is.
function framingBlock(aspect = '', framing = '') {
  const asp = aspect ? `Keep a ${aspect} frame.` : 'Keep the same aspect ratio as the reference frames.';
  const parts = [
    `${asp} Hold the exact framing of the reference frames for the whole clip — the same shot size, crop, subject scale and position, camera angle and background — with the camera locked: no zoom, push-in, pan, tilt or re-crop, even as the body moves.`,
  ];
  if (/full|length|\bbody\b|head.?to.?feet|wide/i.test(framing)) {
    parts.push('Keep the entire figure, from the top of the head through both feet, inside the frame at all times, with a margin on every side.');
  } else if (framing.trim()) {
    parts.push(`Framing: ${framing.trim()}.`);
  }
  return parts.join(' ');
}

// Audio rule (shot-author): only the attached speech, never music or effects.
const audioBlock =
  'Audio: use ONLY the exact voice from the attached speech reference — reproduce that recording and ' +
  'nothing else. ABSOLUTELY NO music, no sound effects, no foley, no room tone, no ambient noise, and ' +
  'no extra vocalizations at any point; any silence stays completely silent.';

// The edit itself: how the first/last frames (and any middle pose keyframes) are placed in time, and
// how the injected pose is expressed — a text gesture (two stills) or pose keyframes (three+ stills).
function editBlock({ poses, gesture, gestureOffset, end }) {
  const act = gesture.trim().replace(/[.\s]+$/, '') || 'makes a distinct new gesture';
  if (poses.length === 0) {
    const mid = s1(gestureOffset != null ? gestureOffset : Number(end) / 2);
    return `The clip STARTS exactly on the attached first reference frame (@Image1) at 0.0s and ENDS exactly on the attached last reference frame (@Image2) at ${end}s — reproduce each reference frame precisely, including its exact full-body framing, subject scale and position. In between, peaking at about ${mid}s, the character ${act} — a distinct new gesture not present in @Image1 or @Image2 — then eases naturally all the way back to the @Image2 pose and framing by ${end}s, flowing with continuous in-between motion and no snaps.`;
  }
  const n = poses.length + 2;
  const pins = ['@Image1 at 0.0s'];
  // Strong pose pin: a keyframe is a HARD constraint on the body pose — reproduce it exactly (this is
  // what reliably lands the pose across shots). The one thing kept OUT of the pin is the mouth: the
  // earlier "BODY and EYES only / mouth ignores the reference" framing told the model to treat the
  // face as a held frame and froze the lips, so instead we pin the body only and tell the mouth to
  // keep lip-syncing straight through the keyframe.
  poses.forEach((p, i) => pins.push(
    `@Image${i + 2} at ${s1(p.offset)}s — at this instant the BODY matches this reference frame EXACTLY (${act}): the same pose, the same configuration of every limb, reproduced as shown — the same arms, hands and body parts on the same sides in the same positions — never mirrored, swapped, simplified, lowered, or replaced with a different version of the gesture. The keyframe pins the BODY pose only; the MOUTH is NOT pinned and keeps lip-syncing to @Video1 straight through this keyframe, never pausing, holding, or freezing`));
  pins.push(`@Image${n} at ${end}s`);
  return `The attached reference frames are keyframes pinned in time — move through each at its timestamp with continuous motion and no held freezes: ${pins.join('; ')}. Keep the expressive motion in the TRANSITIONS between keyframes, and reproduce each pinned pose exactly at its timestamp.`;
}

export function buildTrimPrompt({ dialogue = '', clipDuration, poses = [], gesture = '', gestureOffset, styleLock = '', aspect = '', framing = '' } = {}) {
  const end = s1(clipDuration);

  const styleMood = 'Style & Mood: a single continuous, fully-animated talking-character performance; keep the look, register and staging established by the reference frames.';

  const dynamic = 'Dynamic Description: ' + [
    speechBlock(dialogue, end),
    animationBlock,
    editBlock({ poses, gesture, gestureOffset, end }),
    'Keep the hands/claws empty — nothing is held, picked up, or conjured, and no prop ever appears in frame.',
  ].join(' ');

  // Static: carry the exact design from the attached reference frames — plural: the first and last
  // frames and any middle keyframe, NOT a single turnaround still — including whatever orientation /
  // viewpoint they show (not assumed to be three-quarter). Fold in the caller's style lock, then the
  // derived framing block.
  const refs = 'the attached reference frames (the first and last frames, and any middle pose keyframe)';
  const design = styleDirective(styleLock, {
    locked: (lock) => `The character carries its exact design, line weight, coloring, proportions, art style and orientation from ${refs}: ${lock}`,
    generic: `The character carries its exact design, line weight, coloring, proportions, art style and orientation from ${refs} — match them precisely and do not redesign, re-style, or re-orient.`,
  });
  const stat = `Static Description: ${design} ${framingBlock(aspect, framing)} Total runtime: ${end}s. ${audioBlock}`;

  return [styleMood, dynamic, stat].join('\n\n');
}
