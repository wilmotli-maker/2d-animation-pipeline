#!/usr/bin/env node
// Centered-trim targeted-edit workflow (MuAPI). For a talking shot whose full length dilutes the
// key pose, trim a short window centered on the shot's middle so the key pose sits exactly at the
// window's midpoint, trim the speech-ref to match, re-quote the trimmed words, and run the 3kfA
// layout (first / key pose / last). Reuses the pose still + speech-ref prepared by
// scaffold-muapi-batch.js (<shot>/muapi/pose.png, speech-ref.mp4) and the source in sources/.
//
//   node scaffold-muapi-trim.js [--win 4] [--shot <name>]
// Preps per shot: <shot>/muapi/trim<win>s/{trim.mp4,speech-ref-trim.mp4,first.png,last.png,
// prompt-3kfA.md}. Prints the muapi-seedance.js command. NO credits (generation is separate).

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(C.REPO_ROOT, 'bin', 'pipeline.js');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const WIN = Number(arg('win', 4));
const ONLY = arg('shot', null);

// open-mouthed key poses read best on talking shots (a closed-mouth pose briefly settles the
// lip-sync at the keyframe). poseDesc describes BODY + expression; the prompt scopes the mouth out.
const SHOTS = [
  { shot: 'monster-3-v003', char: 'monster', poseDesc: 'standing tall and defiant with one clawed fist raised' },
  { shot: 'art-1-v010', char: 'art', poseDesc: 'raising one hand with the index finger pointing up to emphasize a point' },
  { shot: 'art-8-v002', char: 'art', poseDesc: 'shocked, both hands raised, eyes wide' },
  { shot: 'ai-7-v002', char: 'ai', poseDesc: 'nonplussed and unimpressed, a flat deadpan brow, arms at the sides' },
];

function run(bin, args) {
  return new Promise((res, rej) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    c.on('error', rej);
    c.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`${bin} ${args.slice(0, 3).join(' ')} exit ${code}\n${(err || out).slice(-300)}`))));
  });
}
const ff = (a) => run('ffmpeg', ['-v', 'error', '-y', ...a]);
const probeDur = async (f) => Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).trim());

// Targeted-edit prompt: @-tag roles, every keyframe pinned to a second, key pose scoped to
// BODY + EYES so the mouth keeps lip-syncing to @Video1 the whole clip (see the skill for why).
function prompt({ char, line, D, poseDesc }) {
  const mid = (D / 2).toFixed(1), end = D.toFixed(1);
  return [
    `Flat cartoon children's-book illustration, a single continuous fully-animated talking performance. ${C.DESIGN[char]}. The character stays turned three-quarter-left throughout, matching the reference images.`,
    `@Video1 is the speech/lip-sync source. The character speaks directly to camera, saying, "${line}" Full lip-sync is REQUIRED for the ENTIRE ${end} seconds: the mouth moves continuously to match the spoken words at the exact instants they are heard in @Video1's audio, from the first frame to the last, and NEVER stops, holds, or freezes — not even while the body reaches the keyframe pose. Take ONLY the audio and speech timing from @Video1; take body pose, framing and overall appearance from the still reference images @Image1, @Image2, @Image3.`,
    `Full-body WIDE shot in a portrait 3:4 frame: the entire figure from the top of the head down through the torso, hips, knees and both feet is visible at all times, with a generous margin of empty mid-gray background on all sides. Never crop or push in past the knees; the character does not drift toward the camera. Locked camera, even mid-gray seamless background.`,
    `The clip is exactly ${end} seconds long. The still reference images are keyframes pinned to SPECIFIC times — pass smoothly THROUGH each at its timestamp with continuous motion and no held freezes: @Image1 at 0.0s; @Image2 at ${mid}s — at this instant the BODY reaches the pose (${poseDesc}). This keyframe sets the BODY and EYES only; the MOUTH ignores the reference image's mouth and keeps lip-syncing to @Video1 without pause; @Image3 at ${end}s.`,
    `Bold clean dark outlines of constant weight, flat color fills, minimal shading, no gradients, no photorealism, no 3D.`,
  ].join('\n\n');
}

async function main() {
  const shots = SHOTS.filter((s) => !ONLY || s.shot === ONLY);
  const cmds = [];
  for (const sh of shots) {
    const base = path.join(C.EVAL_ROOT, sh.shot, 'muapi');
    const src = path.join(C.EVAL_ROOT, 'sources', `${sh.shot}.mp4`);
    const sr = path.join(base, 'speech-ref.mp4');
    const pose = path.join(base, 'pose.png');
    const D = await probeDur(src);
    const start = (D / 2 - WIN / 2);
    const dir = path.join(base, `trim${WIN}s`);
    await mkdir(dir, { recursive: true });

    // centered trim (frame-accurate re-encode) + matching speech-ref trim
    const trim = path.join(dir, 'trim.mp4');
    const srTrim = path.join(dir, 'speech-ref-trim.mp4');
    await ff(['-ss', start.toFixed(3), '-i', src, '-t', String(WIN), '-an', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', trim]);
    await ff(['-ss', start.toFixed(3), '-i', sr, '-t', String(WIN), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', srTrim]);
    const first = path.join(dir, 'first.png'), last = path.join(dir, 'last.png');
    await ff(['-ss', '0', '-i', trim, '-frames:v', '1', first]);
    await ff(['-sseof', '-0.1', '-i', trim, '-frames:v', '1', last]);

    // re-quote the trimmed words (local whisper, no credits)
    const wav = path.join(dir, 'speech-trim.wav');
    await ff(['-i', srTrim, '-vn', '-ac', '1', '-ar', '16000', wav]);
    await run('node', [PIPELINE, 'voice', 'transcribe', '--audio', wav, '--force']);
    const line = (await readFile(path.join(dir, 'speech-trim.txt'), 'utf8')).trim();

    const pf = path.join(dir, 'prompt-3kfA.md');
    await writeFile(pf, prompt({ char: sh.char, line, D: WIN, poseDesc: sh.poseDesc }) + '\n');

    const rel = (p) => path.relative(C.REPO_ROOT, p);
    const cmd = `node scripts/eval/video-editing/keyframe-edit-eval/muapi-seedance.js --prompt-file ${rel(pf)} --image ${rel(first)} --image ${rel(pose)} --image ${rel(last)} --video ${rel(srTrim)} --resolution 480p --aspect-ratio 3:4 --duration ${WIN} --generate-audio true --out ${rel(path.join(dir, 'out-3kfA'))}`;
    cmds.push(cmd);
    console.log(`prepped ${sh.shot} trim${WIN}s (window ${start.toFixed(2)}–${(start + WIN).toFixed(2)}s, pose @ ${(WIN / 2).toFixed(1)}s) | words: "${line.slice(0, 60)}${line.length > 60 ? '…' : ''}"`);
  }
  console.log(`\nrun:\n${cmds.join('\n')}`);
}
main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
