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
    `Say exactly and only this line, speaking each word once — no repeats, no doubled or echoed syllables, no stutter, and no re-articulating the final word; after the last word the mouth closes cleanly and holds still.`,
    `Full lip-sync is required for the entire ${end} seconds: drive the mouth continuously so it opens and closes on every syllable and matches each spoken word, and NEVER hold the mouth static or freeze it — keep lip-syncing even while the body reaches the new pose or the hands move up near the face.`,
    `Take the voice and its exact timing ONLY from @Video1; take appearance, body and framing from the still reference frames.`,
  );
  return parts.join(' ');
}

// Fully-animated, no pose-to-pose snapping (the edit's gesture must flow, not pop in/out).
const animationBlock =
  'The whole clip is ONE continuous, FULLY animated take with constant natural in-between motion, ' +
  'NOT limited or pose-to-pose — the body eases smoothly between beats with no held static poses and no abrupt snaps.';

// Generic full-body framing block (character-neutral: the shot-author version names a specific
// character's parts; this one enumerates head→feet so any subject stays fully in frame).
const framingBlock =
  'Portrait 3:4 vertical frame, WIDE full-length shot. Frame the character in COMPLETE FULL BODY — ' +
  'the entire figure from the top of the head down through the torso, hips, knees and BOTH feet is ' +
  'fully visible at all times, with a clear gap of background beneath the feet and above the head. ' +
  'Pull the camera back far enough for a generous buffer on all four sides. NEVER crop, cut off, or ' +
  'push in so that the knees, legs, feet, waist or head leave the frame — no waist-up, no medium ' +
  'shot, no knee-up framing at any moment. The character does not step or drift toward the camera; ' +
  'the wide full-length framing is held for the entire clip. Minimal camera movement, locked frame. ' +
  'Even mid-gray seamless background matching the reference frames.';

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
    `@Image${i + 2} at ${s1(p.offset)}s — at this instant the BODY reaches the keyframe pose (${act}); this keyframe sets the BODY and EYES only, the MOUTH ignores the reference image's mouth and keeps lip-syncing to @Video1 without pause`));
  pins.push(`@Image${n} at ${end}s`);
  return `The attached reference frames are keyframes pinned to specific times — pass smoothly THROUGH each at its timestamp with continuous motion and no held freezes: ${pins.join('; ')}.`;
}

export function buildTrimPrompt({ dialogue = '', clipDuration, poses = [], gesture = '', gestureOffset, styleLock = '' } = {}) {
  const end = s1(clipDuration);

  const styleMood = 'Style & Mood: a single continuous, fully-animated talking performance edited from an existing shot — preserve the source shot’s established look, register and staging.';

  const dynamic = 'Dynamic Description: ' + [
    speechBlock(dialogue, end),
    animationBlock,
    editBlock({ poses, gesture, gestureOffset, end }),
    'Keep the hands/claws empty — nothing is held, picked up, or conjured, and no prop ever appears in frame.',
  ].join(' ');

  // Static: carry the exact design from the attached reference frames (NOT a single turnaround still
  // — an edit has a first AND a last frame), fold in the caller's style lock, then the framing block.
  const design = styleLock.trim()
    ? `The character carries its exact design, line weight, coloring, proportions and art style from the attached reference frames: ${styleLock.trim()}`
    : 'The character carries its exact design, line weight, coloring, proportions and art style from the attached reference frames — match them precisely and do not redesign or re-style.';
  const stat = `Static Description: ${design} ${framingBlock} Total runtime: ${end}s. ${audioBlock}`;

  return [styleMood, dynamic, stat].join('\n\n');
}
