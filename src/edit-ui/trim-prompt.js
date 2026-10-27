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

// Fully-animated, no pose-to-pose snapping (the edit's gesture must flow, not pop in/out).
// Fully-animated, no pose-to-pose snapping — and expressive, principled motion rather than a dead
// linear tween. We point at the PRINCIPLES of character animation broadly and name the failure mode
// (uniform, machine-smooth, straight-line interpolation) instead of scripting a specific arc, so the
// model supplies the dynamics that fit each gesture. Character-agnostic: the styleLock carries specifics.
// (Future: this could itself be driven by a per-character MOTION style lock, parallel to the render styleLock.)
const animationBlock =
  'The whole clip is ONE continuous, FULLY animated take — never limited or pose-to-pose, with no held ' +
  'static poses and no abrupt snaps. The motion has the life and craft of hand-animated character ' +
  'performance, not a computed in-between: the body moves with weight, intent and expression, applying ' +
  'the principles of good character animation broadly — varied timing and spacing, easing rather than ' +
  'constant speed, a sense of anticipation and follow-through, overlapping and secondary motion in the ' +
  'lighter, looser parts. It must NOT travel at a uniform, even, mechanically smooth rate or slide in a ' +
  'straight, linear path from one pose to the next — that dead, evenly-tweened interpolation is exactly ' +
  'what to avoid; the pacing should breathe and vary, with the gesture reading as a deliberate, expressive action.';

// Framing block — DERIVED, not fixed. An edit must match its source shot, so the aspect ratio,
// shot size and viewpoint all come from the reference frames (or an explicit caller hint), never a
// baked-in "3:4 full-body". `aspect` (e.g. '16:9', '3:4') states the ratio when known; `framing` is
// an optional shot-size hint ('full-length', 'waist-up', 'close-up on the face', …) — when it reads
// as full-length the enumerated head→feet anti-crop language is added, otherwise it is quoted as-is.
function framingBlock(aspect = '', framing = '') {
  const asp = aspect ? `Keep a ${aspect} frame` : 'Keep the same aspect ratio as the reference frames';
  const parts = [
    `${asp}. Reproduce the EXACT framing shown in the reference frames and hold it locked for the whole clip — the same shot size and crop, the same subject scale and position, the same camera angle, orientation and viewpoint, the same headroom and side margins, and the same background. The camera is locked: it does not zoom, push in, pan, tilt or drift, and the subject does not move toward or away from the camera or change its facing. Whatever the reference frames show — full-length, three-quarter, medium or close — keep exactly that; never tighten, widen, re-crop, or change the angle. The framing never follows the action: as the body moves — arms rising, hands reaching, the pose changing — the camera does NOT push in, zoom, re-center, or re-crop toward the moving hands or the gesture, and every part of the figure the reference frames include stays fully inside the frame for the entire clip, at the same scale and position and with the same margins.`,
  ];
  if (/full|length|\bbody\b|head.?to.?feet|wide/i.test(framing)) {
    parts.push('The reference frames show the COMPLETE FULL BODY — the entire figure from the top of the head down through the torso, hips, knees and BOTH feet stays fully inside the frame at all times, with a clear margin of background on every side; NEVER crop, cut off, or push in past the knees, legs, feet or head.');
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
  poses.forEach((p, i) => pins.push(
    `@Image${i + 2} at ${s1(p.offset)}s — at this instant the BODY matches this reference frame EXACTLY (${act}): the same pose with the same configuration of every limb, reproduced exactly as shown — the same arms, hands and body parts on the same sides in the same positions — never mirrored, swapped, simplified, lowered, or replaced with a different version of the gesture; this keyframe sets the BODY and EYES only, while the MOUTH ignores the reference image's mouth and keeps lip-syncing to @Video1 without pause`));
  pins.push(`@Image${n} at ${end}s`);
  return `The attached reference frames are keyframes pinned to specific times — move expressively through each at its timestamp with continuous motion and no held freezes: ${pins.join('; ')}. Apply the expressive, principled motion to the TRANSITIONS between these keyframes — their timing, spacing and in-between path — while reproducing each pinned keyframe pose exactly at its timestamp; the expressiveness shapes how the body travels between poses, it never alters, embellishes, or deviates from the keyframe poses themselves.`;
}

export function buildTrimPrompt({ dialogue = '', clipDuration, poses = [], gesture = '', gestureOffset, styleLock = '', aspect = '', framing = '' } = {}) {
  const end = s1(clipDuration);

  const styleMood = 'Style & Mood: a single continuous, fully-animated talking performance edited from an existing shot — preserve the source shot’s established look, register and staging.';

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
  const design = styleLock.trim()
    ? `The character carries its exact design, line weight, coloring, proportions, art style and orientation from ${refs}: ${styleLock.trim()}`
    : `The character carries its exact design, line weight, coloring, proportions, art style and orientation from ${refs} — match them precisely and do not redesign, re-style, or re-orient.`;
  const stat = `Static Description: ${design} ${framingBlock(aspect, framing)} Total runtime: ${end}s. ${audioBlock}`;

  return [styleMood, dynamic, stat].join('\n\n');
}
