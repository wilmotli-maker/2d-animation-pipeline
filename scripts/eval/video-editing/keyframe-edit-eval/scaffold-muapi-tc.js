#!/usr/bin/env node
// Time-constrained prompt variants for the 4 MuAPI keyframe-edit tests. Reuses the frames + pose
// stills already prepared by scaffold-muapi-batch.js (<shot>/muapi/refs/*.png + pose.png). Emits 3
// prompt layouts per shot, each giving every keyframe a SPECIFIC timestamp in seconds (and asking
// the model to hold the key pose exactly at its time):
//   - 5kf : @Image1..5 at 0, 0.25D, 0.5D(pose), 0.75D, D
//   - 3kfA: first / key pose / last      -> @Image1..3 at 0, 0.5D(pose), D      (imgs 00,pose,04)
//   - 3kfB: second / key pose / fourth   -> @Image1..3 at 0.25D, 0.5D(pose), 0.75D (imgs 01,pose,03)
//
//   node scaffold-muapi-tc.js
// Prints the 12 muapi-seedance.js commands (4 shots x 3 layouts). NO credits.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const SHOTS = [
  { shot: 'monster-3-v003', char: 'monster',
    line: 'You know, instead of fighting, maybe we should team up and fight the real enemy.',
    poseDesc: 'standing tall and defiant with one clawed fist raised' },
  { shot: 'art-1-v010', char: 'art',
    line: 'Whoa! Is that an Elite Graphite Pro and a Claire Fontaine 1951 cloth bound?',
    poseDesc: 'raising one hand with the index finger pointing up to emphasize a point, mouth open' },
  { shot: 'art-8-v002', char: 'art',
    line: 'Ooh, are you trying to have a nuanced discussion about AI? How am I supposed to virtue signal with that?',
    poseDesc: 'shocked, both hands raised, eyes wide, mouth open' },
  { shot: 'ai-7-v002', char: 'ai',
    line: "Mine was going to be a cyber dragon, but I accidentally pieced my Starbucks order into the prompt, and now he's an overly cheerful barista.",
    poseDesc: 'nonplussed and unimpressed, a flat deadpan expression, arms at the sides' },
];

function probe(f) {
  return new Promise((res) => {
    const c = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => res(Number(o.trim())));
  });
}
const s = (n) => (Math.round(n * 10) / 10).toFixed(1);

// Build a time-constrained prompt. kfs = [{tag,time,pose?}] already ordered.
function prompt({ char, line, D, kfs }) {
  const tagList = kfs.map((k) => k.tag).join(', ');
  const kfLines = kfs.map((k) => k.pose
    ? `${k.tag} at ${s(k.time)}s — here the character is ${k.pose} (hold this pose exactly at ${s(k.time)}s)`
    : `${k.tag} at ${s(k.time)}s`).join('; ');
  return [
    `Flat cartoon children's-book illustration, a single continuous fully-animated talking performance. ${C.DESIGN[char]}. The character stays turned three-quarter-left throughout, matching the reference images.`,
    `@Video1 is the speech/lip-sync source. The character speaks directly to camera, saying, "${line}" Full lip-sync is REQUIRED and tightly time-aligned to @Video1: the mouth opens and closes to match the spoken words at the exact instants they are heard in @Video1's audio, then closes cleanly and holds still once the line ends. Take ONLY the audio and speech timing from @Video1; take all visual appearance, pose and framing from the still reference images ${tagList}.`,
    `Full-body WIDE shot in a portrait 3:4 frame: the entire figure from the top of the head down through the torso, hips, knees and both feet is visible at all times, with a generous margin of empty mid-gray background on all sides. Never crop or push in past the knees; the character does not drift toward the camera. Locked camera, even mid-gray seamless background.`,
    `The clip is exactly ${s(D)} seconds long. The still reference images are keyframes pinned to SPECIFIC times — reach each one precisely at its stated timestamp and move continuously between them with no held freezes: ${kfLines}.`,
    `Bold clean dark outlines of constant weight, flat color fills, minimal shading, no gradients, no photorealism, no 3D.`,
  ].join('\n\n');
}

const rel = (p) => path.relative(C.REPO_ROOT, p);

async function main() {
  const cmds = [];
  for (const sh of SHOTS) {
    const dir = path.join(C.EVAL_ROOT, sh.shot, 'muapi');
    const refs = (n) => path.join(dir, 'refs', `${n}.png`);
    const pose = path.join(dir, 'pose.png');
    const speech = path.join(dir, 'speech-ref.mp4');
    const D = await probe(path.join(C.EVAL_ROOT, 'sources', `${sh.shot}.mp4`));

    const layouts = {
      '5kf': {
        imgs: [refs('00'), refs('01'), pose, refs('03'), refs('04')],
        kfs: [
          { tag: '@Image1', time: 0 }, { tag: '@Image2', time: 0.25 * D },
          { tag: '@Image3', time: 0.5 * D, pose: sh.poseDesc },
          { tag: '@Image4', time: 0.75 * D }, { tag: '@Image5', time: D },
        ],
      },
      '3kfA': {
        imgs: [refs('00'), pose, refs('04')],
        kfs: [
          { tag: '@Image1', time: 0 },
          { tag: '@Image2', time: 0.5 * D, pose: sh.poseDesc },
          { tag: '@Image3', time: D },
        ],
      },
      '3kfB': {
        imgs: [refs('01'), pose, refs('03')],
        kfs: [
          { tag: '@Image1', time: 0.25 * D },
          { tag: '@Image2', time: 0.5 * D, pose: sh.poseDesc },
          { tag: '@Image3', time: 0.75 * D },
        ],
      },
    };

    for (const [name, L] of Object.entries(layouts)) {
      const pf = path.join(dir, `prompt-tc-${name}.md`);
      await writeFile(pf, prompt({ char: sh.char, line: sh.line, D, kfs: L.kfs }) + '\n');
      const cmd = ['node', 'scripts/eval/video-editing/keyframe-edit-eval/muapi-seedance.js',
        '--prompt-file', rel(pf),
        ...L.imgs.flatMap((i) => ['--image', rel(i)]),
        '--video', rel(speech),
        '--resolution', '480p', '--aspect-ratio', '3:4', '--duration', String(Math.round(D)),
        '--generate-audio', 'true', '--out', rel(path.join(dir, `out-tc-${name}`))].join(' ');
      cmds.push({ shot: sh.shot, layout: name, dur: Math.round(D), cmd });
    }
    console.log(`prepped ${sh.shot} (D=${s(D)}s): 5kf, 3kfA, 3kfB`);
  }
  const totalS = cmds.reduce((a, c) => a + c.dur, 0);
  console.log(`\n${cmds.length} TC runs. ${totalS}s -> ~$${(totalS * 0.205).toFixed(2)} (empirical) / ~$${(totalS * 0.17).toFixed(2)} (floor)`);
  for (const c of cmds) console.log(`\n# ${c.shot} ${c.layout} (${c.dur}s)\n${c.cmd}`);
}
main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
