#!/usr/bin/env node
// One-off scaffold for the 4 MuAPI keyframe-edit + lip-sync tests on NEW episode-2 candidate
// shots (not in config.SHOTS). For each shot: extract kf5 keyframes, matte+register the chosen
// pose onto the shot's gray (green-screen -> pipeline chroma; already-gray pose -> colorkey +
// recomposite), inject it at the middle keyframe, build the @-tag lip-sync prompt, copy the
// source speech-ref. NO credits (generation is a separate muapi-seedance.js call).
//
//   node scaffold-muapi-batch.js [--force]
// Emits per-shot: <EVAL_ROOT>/<shot>/muapi/{refs/,pose.png,prompt.md,speech-ref.mp4} and prints
// the muapi-seedance.js command for each.

import { spawn } from 'node:child_process';
import { mkdir, writeFile, copyFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(C.REPO_ROOT, 'bin', 'pipeline.js');
const POSES = path.join(C.EVAL_ROOT, 'sources', 'poses');
const FORCE = process.argv.includes('--force');

const SHOTS = [
  { shot: 'monster-3-v003', char: 'monster', pose: 'monster-fist.png', poseBg: 'gray',
    line: 'You know, instead of fighting, maybe we should team up and fight the real enemy.',
    poseDesc: 'standing tall and defiant with one clawed fist raised' },
  { shot: 'art-1-v010', char: 'art', pose: 'art-1-exclaiming.png', poseBg: 'green',
    line: 'Whoa! Is that an Elite Graphite Pro and a Claire Fontaine 1951 cloth bound?',
    poseDesc: 'raising one hand with the index finger pointing up to emphasize a point, mouth open' },
  { shot: 'art-8-v002', char: 'art', pose: 'art-1-shocked.png', poseBg: 'green',
    line: 'Ooh, are you trying to have a nuanced discussion about AI? How am I supposed to virtue signal with that?',
    poseDesc: 'shocked, both hands raised, eyes wide, mouth open' },
  { shot: 'ai-7-v002', char: 'ai', pose: 'ai-2-nonplussed.png', poseBg: 'green',
    line: "Mine was going to be a cyber dragon, but I accidentally pieced my Starbucks order into the prompt, and now he's an overly cheerful barista.",
    poseDesc: 'nonplussed and unimpressed, a flat deadpan expression, arms at the sides' },
];

function run(bin, args) {
  return new Promise((res, rej) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    c.on('error', rej);
    c.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`${bin} ${args.slice(0, 3).join(' ')} exit ${code}\n${(err || out).slice(-400)}`))));
  });
}
const ff = (a) => run('ffmpeg', ['-v', 'error', '-y', ...a]);
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
async function probe(f, entries) { return (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'csv=p=0', f])).trim(); }
function rawBin(png) {
  return new Promise((res, rej) => {
    const c = spawn('ffmpeg', ['-v', 'error', '-i', png, '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ch = []; let err = '';
    c.stdout.on('data', (d) => ch.push(d)); c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => (code === 0 ? res(Buffer.concat(ch)) : rej(new Error(err.slice(-300)))));
  });
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function measure(buf, w, h, { isAlpha, bg }) {
  let minX = w, maxX = -1, minY = h, maxY = -1, sx = 0, n = 0;
  const colTop = new Int32Array(w).fill(-1), colBot = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let on;
    if (isAlpha) on = buf[i + 3] > 128;
    else on = Math.abs(buf[i] - bg[0]) + Math.abs(buf[i + 1] - bg[1]) + Math.abs(buf[i + 2] - bg[2]) > 60;
    if (!on) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    sx += x; n++;
    if (colTop[x] === -1) colTop[x] = y; colBot[x] = y;
  }
  if (n === 0) return null;
  const centroidX = Math.round(sx / n);
  const band = Math.round(0.08 * w);
  let bandTop = h, bandBot = -1;
  for (let x = centroidX - band; x <= centroidX + band; x++) {
    if (x < 0 || x >= w || colTop[x] === -1) continue;
    if (colTop[x] < bandTop) bandTop = colTop[x];
    if (colBot[x] > bandBot) bandBot = colBot[x];
  }
  return { centroidX, bandTop, bandBottom: bandBot };
}

// @-tag lip-sync prompt (inline so we can pass a custom poseDesc not in config.POSE_DESC)
function prompt({ char, pose, line }) {
  return [
    `Flat cartoon children's-book illustration, a single continuous fully-animated talking performance. ${C.DESIGN[char]}. The character stays turned three-quarter-left throughout, matching the reference images.`,
    `@Video1 is the speech/lip-sync source. The character speaks directly to camera, saying, "${line}" Full lip-sync is REQUIRED and tightly time-aligned to @Video1: the mouth opens and closes to match the spoken words at the exact instants they are heard in @Video1's audio, then closes cleanly and holds still once the line ends. Take ONLY the audio and speech timing from @Video1; take all visual appearance, pose and framing from the still reference images @Image1, @Image2, @Image3, @Image4, @Image5.`,
    `Full-body WIDE shot in a portrait 3:4 frame: the entire figure from the top of the head down through the torso, hips, knees and both feet is visible at all times, with a generous margin of empty mid-gray background on all sides. Never crop or push in past the knees; the character does not drift toward the camera. Locked camera, even mid-gray seamless background.`,
    `The 5 still reference images are keyframes of this one shot, in order, evenly spaced across the runtime. Move continuously and naturally between them with no held freezes: @Image1 at 0%; @Image2 at 25%; @Image3 at 50% — here the character is ${pose}; @Image4 at 75%; @Image5 at 100%.`,
    `Bold clean dark outlines of constant weight, flat color fills, minimal shading, no gradients, no photorealism, no 3D.`,
  ].join('\n\n');
}

async function main() {
  await mkdir(path.join(C.EVAL_ROOT, 'sources'), { recursive: true });
  const cmds = [];
  for (const s of SHOTS) {
    const src = path.join(C.CANDIDATES, `${s.shot}.mp4`);
    const localSrc = path.join(C.EVAL_ROOT, 'sources', `${s.shot}.mp4`);
    if (!(await exists(localSrc)) || FORCE) await copyFile(src, localSrc);
    const D = Number(await probe(localSrc, 'format=duration').catch(async () => (await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', localSrc])).trim()));
    const dur = Math.round(D);
    const dir = path.join(C.EVAL_ROOT, s.shot, 'muapi');
    const refsDir = path.join(dir, 'refs');
    await mkdir(refsDir, { recursive: true });

    // bg gray + registration target from 9 measurement frames
    const [W, H] = (await probe(localSrc, 'stream=width,height')).split(',').map(Number);
    const grab = async (frac, out) => {
      const seek = frac >= 0.999 ? ['-sseof', '-0.1'] : ['-ss', (frac * D).toFixed(3)];
      if (!(await exists(out)) || FORCE) await ff([...seek, '-i', localSrc, '-frames:v', '1', out]);
      return out;
    };
    const measDir = path.join(dir, '_measure'); await mkdir(measDir, { recursive: true });
    const measFrames = []; for (let i = 0; i < 9; i++) measFrames.push(await grab(i / 8, path.join(measDir, `${i}.png`)));
    const cbuf = await rawBin(measFrames[0]);
    const bg = [cbuf[(5 * W + 5) * 4], cbuf[(5 * W + 5) * 4 + 1], cbuf[(5 * W + 5) * 4 + 2]];
    const bgColor = '0x' + bg.map((v) => v.toString(16).padStart(2, '0')).join('');
    const ms = [];
    for (const fp of measFrames) { const b = await rawBin(fp); const m = measure(b, W, H, { isAlpha: false, bg }); if (m) ms.push(m); }
    const tgt = { centerX: median(ms.map((m) => m.centroidX)), feetY: median(ms.map((m) => m.bandBottom)), headY: median(ms.map((m) => m.bandTop)) };
    tgt.height = tgt.feetY - tgt.headY;

    // --- pose still on the shot's gray ---
    const poseSrc = path.join(POSES, s.pose);
    const poseStill = path.join(dir, 'pose.png');
    if (!(await exists(poseStill)) || FORCE) {
      if (s.poseBg === 'green') {
        // chroma matte via pipeline, then scale/register onto shot gray
        const mid = `pm-muapi-${s.shot}`;
        await rm(path.join(C.SCRATCH, 'shots', mid), { recursive: true, force: true });
        await run('node', [PIPELINE, 'shot', 'create', '--id', mid, '--description', 'pose matte', '--root', C.SCRATCH]);
        await run('node', [PIPELINE, 'shot', 'draft', '--id', mid, '--root', C.SCRATCH]);
        await run('node', [PIPELINE, 'shot', 'matte', '--id', mid, '--input', poseSrc, '--method', 'plate', '--matte', 'chroma', '--refine', 'closed-form', '--format', 'png', '--root', C.SCRATCH]);
        const cut = path.join(C.SCRATCH, 'shots', mid, 'final', 'alpha', '00001.png');
        const [pw, ph] = (await probe(cut, 'stream=width,height')).split(',').map(Number);
        const pm = measure(await rawBin(cut), pw, ph, { isAlpha: true });
        const scale = tgt.height / (pm.bandBottom - pm.bandTop);
        const x = Math.round(tgt.centerX - pm.centroidX * scale);
        const y = Math.round(tgt.feetY - pm.bandBottom * scale);
        await ff(['-f', 'lavfi', '-i', `color=${bgColor}:s=${W}x${H}`, '-i', cut, '-filter_complex',
          `[1:v]scale=iw*${scale}:ih*${scale}[p];[0:v][p]overlay=${x}:${y}:format=auto`, '-frames:v', '1', poseStill]);
        await rm(path.join(C.SCRATCH, 'shots', mid), { recursive: true, force: true });
      } else {
        // already a shot-sized gray still: colorkey its own bg gray, recomposite onto the shot gray
        const pbuf = await rawBin(poseSrc);
        const [pw] = (await probe(poseSrc, 'stream=width,height')).split(',').map(Number);
        const pbg = [pbuf[(5 * pw + 5) * 4], pbuf[(5 * pw + 5) * 4 + 1], pbuf[(5 * pw + 5) * 4 + 2]];
        const pbgHex = '0x' + pbg.map((v) => v.toString(16).padStart(2, '0')).join('');
        await ff(['-f', 'lavfi', '-i', `color=${bgColor}:s=${W}x${H}`, '-i', poseSrc, '-filter_complex',
          `[1:v]scale=${W}:${H},colorkey=${pbgHex}:0.12:0.06[p];[0:v][p]overlay=0:0:format=auto`, '-frames:v', '1', poseStill]);
      }
    }

    // --- kf5 refs, pose injected at index 2 ---
    const times = [0, 0.25, 0.5, 0.75, 1];
    const refs = [];
    for (let i = 0; i < times.length; i++) {
      if (i === 2) { refs.push(poseStill); continue; }
      refs.push(await grab(times[i], path.join(refsDir, `${String(i).padStart(2, '0')}.png`)));
    }
    await writeFile(path.join(dir, 'prompt.md'), prompt({ char: s.char, pose: s.poseDesc, line: s.line }) + '\n');

    // speech-ref
    const sr = C.speechRefSource(s.shot);
    const localSR = path.join(dir, 'speech-ref.mp4');
    if (!(await exists(localSR)) || FORCE) await copyFile(sr, localSR);

    const cmd = ['node', 'scripts/eval/video-editing/keyframe-edit-eval/muapi-seedance.js',
      '--prompt-file', path.relative(C.REPO_ROOT, path.join(dir, 'prompt.md')),
      ...refs.flatMap((r) => ['--image', path.relative(C.REPO_ROOT, r)]),
      '--video', path.relative(C.REPO_ROOT, localSR),
      '--resolution', '480p', '--aspect-ratio', '3:4', '--duration', String(dur), '--generate-audio', 'true',
      '--out', path.relative(C.REPO_ROOT, path.join(dir, 'out'))].join(' ');
    cmds.push({ shot: s.shot, dur, cmd });
    console.log(`prepared ${s.shot} (dur ${dur}s, pose ${s.pose}, gray ${bgColor}, h=${tgt.height})`);
  }
  const totalS = cmds.reduce((a, c) => a + c.dur, 0);
  console.log(`\n${cmds.length} shots prepped. total ${totalS}s -> ~$${(totalS * 0.205).toFixed(2)} (empirical) / ~$${(totalS * 0.17).toFixed(2)} (list floor)`);
  console.log('\nrun commands:');
  for (const c of cmds) console.log(c.cmd);
}
main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
