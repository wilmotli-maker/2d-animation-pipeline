// src/edit-ui/trim-prompt.js
// Compose the targeted-edit prompt for one window, following the five-paragraph structure of
// the `targeted-edit-author` skill (style/design lock, speech+lip-sync, framing, the edit,
// render style). Unlike the shot-author flow, the edit-ui case EDITS an existing performance,
// so the style/orientation/framing/render locks are worded to PRESERVE what the reference
// frames already show (an optional `styleLock` string is folded into the opening paragraph);
// only the marked beat changes. Keyframe windows pin stills to timestamps; text-pose windows
// describe a mid-clip gesture instead of a middle keyframe.
const s1 = (n) => Number(n).toFixed(1);

export function buildTrimPrompt({ dialogue = '', clipDuration, poses = [], gesture = '', gestureOffset, styleLock = '' } = {}) {
  const end = s1(clipDuration);
  const textPose = poses.length === 0;
  const n = poses.length + 2;                       // first + poses + last
  const imageTags = Array.from({ length: n }, (_, i) => `@Image${i + 1}`).join(', ');
  const lines = [];

  // 1. Style + design / orientation lock (preservation-worded; optional style lock folded in).
  const p1 = ['A single continuous, fully-animated performance edited from an existing shot.'];
  if (styleLock.trim()) p1.push(styleLock.trim());
  p1.push('Preserve the subject’s exact appearance, costume, proportions and orientation as shown in the reference frames throughout — do not redesign or re-style them.');
  lines.push(p1.join(' '));

  // 2. Speech / lip-sync.
  const sp = ['@Video1 is the speech/lip-sync source.'];
  if (dialogue.trim()) sp.push(`The subject speaks directly to camera, saying, "${dialogue.trim()}"`);
  sp.push(`Full lip-sync is REQUIRED for the ENTIRE ${end} seconds: the mouth moves continuously to match @Video1’s audio from the first frame to the last and NEVER stops, holds, or freezes. Take ONLY the audio and speech timing from @Video1; take appearance, framing and body from the still reference frames ${imageTags}.`);
  lines.push(sp.join(' '));

  // 3. Framing — preserve the source shot. Enumerate the body and pin "at all times": an abstract
  // "keep the subject in frame" lets the model tighten the shot and crop legs/feet (measured).
  lines.push('Match the reference frames’ framing EXACTLY and hold it on every single frame: the same shot size, the same subject scale and position, the same headroom and side margins, the same locked camera and the same background. The subject must NOT move toward the camera and the camera must NOT zoom, push in, pan, or drift. If the reference frames show the full figure, the ENTIRE figure — the top of the head down through the torso, hips, knees and BOTH feet — stays fully inside the frame for the whole clip: never crop or cut off the legs or feet, and never tighten the shot.');

  // 4. The edit.
  if (textPose) {
    const mid = s1(gestureOffset != null ? gestureOffset : clipDuration / 2);
    const act = gesture.trim().replace(/[.\s]+$/, '') || 'makes a distinct new gesture';
    // Pin @Image1/@Image2 to the exact start/end instants (and reproduce their full-body framing).
    // Backends that address references by prompt tag (MuAPI, fal) otherwise treat the start/end
    // frames as loose style refs and tighten the shot — cropping legs/feet (observed on MuAPI art-1).
    lines.push(`The still reference frames are keyframes pinned to SPECIFIC times: the clip STARTS exactly on @Image1 at 0.0s and ENDS exactly on @Image2 at ${end}s — reproduce each precisely, INCLUDING its full-body framing, subject scale and position. In between, peaking at about ${mid}s, the subject ${act} — a distinct new gesture not present in @Image1 or @Image2 — then eases back to the @Image2 pose by ${end}s. Move continuously and naturally with no held freezes; the mouth keeps lip-syncing to @Video1 the whole time.`);
  } else {
    const pins = ['@Image1 at 0.0s'];
    poses.forEach((p, i) => pins.push(`@Image${i + 2} at ${s1(p.offset)}s — at this instant the BODY reaches the keyframe pose; this keyframe sets the BODY and EYES only, the MOUTH ignores the reference image’s mouth and keeps lip-syncing to @Video1`));
    pins.push(`@Image${n} at ${end}s`);
    let para = `The clip is exactly ${end} seconds long. The still reference images are keyframes pinned to SPECIFIC times — pass smoothly THROUGH each at its timestamp with continuous motion and no held freezes: ${pins.join('; ')}.`;
    if (gesture.trim()) para += ` The injected pose: ${gesture.trim()}.`;
    lines.push(para);
  }

  // 5. Render style — preserve the reference look.
  lines.push('Match the exact art style of the reference frames — the same line work, color, shading and level of detail. Do not introduce gradients, 3D, or photorealism that are not already present in the references.');
  return lines.join('\n\n');
}
