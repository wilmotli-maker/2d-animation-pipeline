// Shared config for the keyframe-edit eval. Single source of truth for shots, pose
// assignments, character design locks, and pose descriptions. Consumed by scaffold.js
// and splice.js. No credits are spent by importing this.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..', '..');
export const CANDIDATES = '/Users/wilmotli/Projects/Seedance Animation/ArtAI/episodes/2/shots/candidates';
export const DOWNLOADS = '/Users/wilmotli/Downloads';
export const EVAL_ROOT = path.join(REPO_ROOT, 'evaluation', 'video-editing-eval', 'keyframe-edit');
export const SCRATCH = path.join(EVAL_ROOT, 'scratch'); // pipeline project root for generation

export const VARIANTS = ['kf5', 'nu'];
export const POSITIONS = ['first', 'middle', 'last'];
export const posSeam = (pos) => (pos === 'first' ? 'head' : pos === 'last' ? 'tail' : 'mid');

// Keyframe timing per (variant, position), as fractions of the clip [0..1], plus which
// index carries the injected pose. nu = non-uniform: a tight cluster at the 10kf spacing
// (g = 1/9) placed at the edit, so the pose is anchored densely instead of diluted.
const G = 1 / 9;
export function keyframeSpec(variant, position) {
  if (variant === 'kf5') {
    const times = [0, 0.25, 0.5, 0.75, 1];
    const editIndex = position === 'first' ? 0 : position === 'last' ? 4 : 2;
    return { times, editIndex };
  }
  // nu
  if (position === 'first') return { times: [0, G], editIndex: 0 };
  if (position === 'last') return { times: [1 - G, 1], editIndex: 1 };
  return { times: [0.5 - G, 0.5, 0.5 + G], editIndex: 1 }; // middle
}
export const caseDir = (evalRoot, shot, variant, pos) => path.join(evalRoot, shot, variant, pos);

export const CHAR_PREFIX = { ai: 'ai-2', art: 'art-1', monster: 'monster-1' };
export const CHAR_REVISION = { ai: 'revision2-three-quarters', art: 'revision1', monster: 'revision1' };

export function poseFile(char, name) {
  const pfx = CHAR_PREFIX[char];
  const rev = path.join(DOWNLOADS, char, CHAR_REVISION[char], `${pfx}-${name}.png`);
  const root = path.join(DOWNLOADS, char, `${pfx}-${name}.png`);
  return existsSync(rev) ? rev : root;
}

// char design-lock lines used in the visual-only prompt
export const DESIGN = {
  ai: 'a small purple-and-red tin robot: boxy hexagonal head, two thin antennae with round tips, big round glowing yellow eyes, segmented red spring-coil arms and legs, a purple boxy torso with a small control panel, oversized simple hands',
  art: 'a lanky young artist with bright scarlet spiky hair, chunky dark rectangular glasses with clear lenses, a lavender long-sleeve shirt with sleeves rolled to the forearm, a cobalt-blue paint-splattered bib apron with a pencil and brushes in the pocket, dark maroon-brown trousers and navy slip-on shoes',
  monster: 'a friendly cartoon red dragon: rounded snout with big eyes, a pale pink segmented belly, olive-green spines running down the back and long tail, short arms with simple clawed hands, standing upright',
};

// short natural-language descriptions of each injected pose (visual only)
export const POSE_DESC = {
  // ai
  depressed: 'slumped and dejected, shoulders down, arms hanging limp, a sad downcast face',
  angry: 'angry with both hands planted on the hips, glaring hard, leaning in',
  dismissive: 'waving one hand dismissively off to the side while looking away',
  confident: 'standing tall and confident, hands on hips, a self-assured grin',
  angrypoint: 'furious and jabbing a sharp accusing point outward to the side',
  embarrassed2: 'embarrassed, one hand raised sheepishly to the side of the head, awkward smile',
  shocked: 'shocked, both hands flying up, mouth open wide in alarm',
  happy2: 'elated, both arms thrown up in the air in celebration, beaming',
  sad2: 'sad and frowning, arms hanging down, gaze lowered',
  // art
  sad: 'sad and downcast, arms limp at the sides, a dejected frown',
  holierthanthou: 'smug and holier-than-thou, one hand pressed to the chest, chin raised',
  thinking: 'thoughtful, one hand raised to the chin, considering',
  fistsraised: 'excited, both fists raised triumphantly overhead, mouth open cheering',
  skepticalidle: 'skeptical, arms folded across the chest, one eyebrow up',
  bragging: 'bragging, chest puffed out with a smug self-satisfied gesture',
  armsraised: 'exclaiming with both arms flung up and open, mouth wide',
  uppity: 'uppity and superior, chin lifted, one finger raised to make a point',
  // monster
  annoyed: 'annoyed, eyes half-lidded, arms hanging, an unimpressed expression',
  firebreath: 'head thrown back with mouth open wide in a dramatic roar',
  enjoying: 'clearly enjoying himself, smiling, one arm gesturing out warmly',
  upset: 'upset and angry, arms flung out to the sides, scowling',
  agreeing: 'agreeing enthusiastically, one fist raised, a big grin',
};

// 8 shots
export const SHOTS = [
  { shot: 'ai-13-v003', char: 'ai', edits: { first: 'depressed', middle: 'angry', last: 'dismissive' } },
  { shot: 'ai-9-v002', char: 'ai', edits: { first: 'confident', middle: 'angrypoint', last: 'embarrassed2' } },
  { shot: 'ai-4-v013', char: 'ai', edits: { first: 'shocked', middle: 'happy2', last: 'sad2' } },
  { shot: 'art-9-v003', char: 'art', edits: { first: 'sad', middle: 'holierthanthou', last: 'thinking' } },
  { shot: 'art-7-v002', char: 'art', edits: { first: 'angry', middle: 'fistsraised', last: 'skepticalidle' } },
  { shot: 'art-5-v003', char: 'art', edits: { first: 'bragging', middle: 'armsraised', last: 'uppity' } },
  { shot: 'monster-1-v006', char: 'monster', edits: { first: 'annoyed', middle: 'firebreath', last: 'thinking' } },
  { shot: 'monster-5-v002', char: 'monster', edits: { first: 'enjoying', middle: 'upset', last: 'agreeing' } },
];
export const PILOT = 'ai-13-v003';

// enumerate the 48 cases (8 shots x 3 positions x 2 variants)
export function cases() {
  const out = [];
  for (const s of SHOTS) for (const variant of VARIANTS) for (const pos of POSITIONS) {
    const spec = keyframeSpec(variant, pos);
    out.push({
      id: `${s.shot}__${variant}__${pos}`,
      shot: s.shot, char: s.char, variant, position: pos,
      times: spec.times, index: spec.editIndex, seam: posSeam(pos),
      pose: s.edits[pos], poseFile: poseFile(s.char, s.edits[pos]),
    });
  }
  return out;
}

// build the visual-only prompt for a case; `times` are keyframe fractions [0..1], `index` the pose.
export function buildPrompt({ char, times, index, pose }) {
  const n = times.length;
  const uniform = times.every((f, i) => Math.abs(f - i / (n - 1)) < 1e-6);
  const kfLines = times.map((f, i) => {
    const at = `at ${(f * 100).toFixed(0)}% of the timeline`;
    return i === index
      ? `keyframe ${i + 1} (${at}): the character is ${POSE_DESC[pose]}`
      : `keyframe ${i + 1} (${at}): matches attached reference image ${i + 1}`;
  }).join('; ');
  const spacing = uniform ? 'evenly spaced across the runtime' : 'placed at the specific times below (not evenly spaced)';
  return [
    `Flat cartoon children's-book illustration, a single continuous fully-animated silent performance (no dialogue). ${DESIGN[char]}. The character stays turned three-quarter-left throughout, matching the attached reference images.`,
    `Full-body WIDE shot in a portrait 3:4 frame: the entire figure from the top of the head down through the torso, hips, knees and both feet is visible at all times, with a generous margin of empty mid-gray background on all sides. Never crop or push in past the knees; the character does not drift toward the camera. Locked camera, even mid-gray seamless background.`,
    `The ${n} attached reference images are keyframes of this one shot, in order, ${spacing}. Move continuously and naturally between and beyond them with no held freezes: ${kfLines}.`,
    `Bold clean dark outlines of constant weight, flat color fills, minimal shading, no gradients, no photorealism, no 3D. No audio, no dialogue, no text, no sound.`,
  ].join('\n\n');
}
