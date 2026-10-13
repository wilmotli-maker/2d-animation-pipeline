// src/edit-ui/trim-prompt.js
// Compose the targeted-edit prompt for one window: @-tag roles, full-clip lip-sync to
// @Video1, each still pinned to a timestamp (edited keyframes scope BODY+EYES so the mouth
// keeps lip-syncing), the trimmed dialogue quoted, and the UI's authored prompt folded in.
// Generalized from scaffold-muapi-trim.js (no hardcoded character design strings).
const s1 = (n) => Number(n).toFixed(1);

export function buildTrimPrompt({ dialogue = '', clipDuration, poses = [], userPrompt = '' } = {}) {
  const end = s1(clipDuration);
  const n = poses.length + 2;                       // first + poses + last
  const lastTag = `@Image${n}`;
  const imageTags = Array.from({ length: n }, (_, i) => `@Image${i + 1}`).join(', ');

  const lines = [];
  lines.push('Flat cartoon children’s-book illustration, a single continuous fully-animated talking performance. The character keeps the same framing and appearance as the reference images throughout.');

  const speech = ['@Video1 is the speech/lip-sync source.'];
  if (dialogue.trim()) speech.push(`The character speaks directly to camera, saying, "${dialogue.trim()}"`);
  speech.push(`Full lip-sync is REQUIRED for the ENTIRE ${end} seconds: the mouth moves continuously to match @Video1’s audio from the first frame to the last and NEVER holds or freezes. Take ONLY audio and speech timing from @Video1; take body pose, framing and appearance from the still reference images ${imageTags}.`);
  lines.push(speech.join(' '));

  const pins = ['@Image1 at 0.0s'];
  poses.forEach((p, i) => pins.push(`@Image${i + 2} at ${s1(p.offset)}s — at this instant the BODY reaches the keyframe pose; this keyframe sets the BODY and EYES only, the MOUTH ignores the reference image’s mouth and keeps lip-syncing to @Video1`));
  pins.push(`${lastTag} at ${end}s`);
  lines.push(`The clip is exactly ${end} seconds long. The still reference images are keyframes pinned to SPECIFIC times — pass smoothly THROUGH each at its timestamp with continuous motion and no held freezes: ${pins.join('; ')}.`);

  if (userPrompt.trim()) lines.push(userPrompt.trim());
  lines.push('Bold clean dark outlines of constant weight, flat color fills, minimal shading, no gradients, no photorealism, no 3D.');
  return lines.join('\n\n');
}
