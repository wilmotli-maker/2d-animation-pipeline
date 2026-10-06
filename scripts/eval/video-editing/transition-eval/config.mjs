// Shared config for the shot-to-shot transition eval. 16 pairs x 3 variations.
// A transition clip holds shot1's last frame (A), morphs A->B over ~1s, holds shot2's first
// frame (B). Keyframes [A,A,B,B] at fractions [0, .375, .625, 1] of a 4s clip (kf2->kf3 = 1s).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, CANDIDATES, DESIGN } from '../keyframe-edit-eval/config.mjs';

export { REPO_ROOT, CANDIDATES, DESIGN };
const here = path.dirname(fileURLToPath(import.meta.url));
export const EVAL_ROOT = path.join(REPO_ROOT, 'evaluation', 'video-editing-eval', 'transition-pairs');
export const SCRATCH = path.join(EVAL_ROOT, 'scratch');
export const VARIATIONS = 6;
export const KF_TIMES = [0, 0.375, 0.625, 1]; // gap kf2->kf3 = 0.25*4s = 1s
export const charOf = (shot) => shot.startsWith('ai') ? 'ai' : shot.startsWith('art') ? 'art' : 'monster';

export const PAIRS = [
  ['ai-13-v003', 'ai-5-v005'], ['ai-2-v003', 'ai-8-v006'], ['ai-12-v006', 'ai-4-v006'],
  ['ai-1-v003', 'ai-13-v003'], ['ai-6-v002', 'ai-9-v002'], ['ai-8-v006', 'ai-2-v003'],
  ['art-11-v002', 'art-5-v003'], ['art-3-v002', 'art-7-v002'], ['art-12-v002', 'art-4-v002'],
  ['art-7-v002', 'art-2-v015'], ['art-10-v002', 'art-9-v003'], ['art-4-v002', 'art-12-v002'],
  ['monster-1-v006', 'monster-4-v002'], ['monster-3-v001', 'monster-2-v006'],
  ['monster-4-v002', 'monster-1-v006'], ['monster-2-v006', 'monster-3-v001'],
];

export const pairId = (a, b) => `${a}__to__${b}`;
export const caseDir = (a, b) => path.join(EVAL_ROOT, pairId(a, b));

export function cases() {
  const out = [];
  for (const [a, b] of PAIRS) for (let v = 1; v <= VARIATIONS; v++) {
    out.push({ id: `${pairId(a, b)}__v${v}`, a, b, variation: v, char: charOf(a) });
  }
  return out;
}

export function buildPrompt(char) {
  return [
    `Flat cartoon children's-book illustration, one continuous fully-animated silent performance (no dialogue, no cuts). ${DESIGN[char]}. The character stays turned three-quarter-left, on an even mid-gray seamless background.`,
    `Full-body WIDE 3:4 shot: the whole figure from head to both feet stays in frame with generous margins; locked camera, no push-in.`,
    `The 4 attached reference images are keyframes. Keyframes 1 and 2 (at 0% and 37% of the timeline) are the SAME starting pose — hold it steady and alive. Then over the next second the character makes ONE smooth, natural, continuous move into the ending pose of keyframes 3 and 4 (at 62% and 100%) — hold that pose to the end. Keyframe 1/2 match reference images 1/2; keyframe 3/4 match reference images 3/4. No snapping, no extra poses, no cuts.`,
    `Bold clean dark outlines of constant weight, flat color fills, minimal shading, no gradients, no photorealism, no 3D. No audio, no dialogue, no text, no sound.`,
  ].join('\n\n');
}
