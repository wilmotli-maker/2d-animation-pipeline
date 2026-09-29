#!/usr/bin/env node
// SPIKE (a): masked WAN VACE conditioning done RIGHT, then composited.
//
// The thesis from the discussion: current v2v models "re-solve" the whole frame,
// so scoped edits leak into regions that should be untouched. VACE takes a mask,
// but two things ruin it in practice (both learned the hard way — see memories
// wan-fal-timeline-truncation and keyframe-v2v-spike):
//
//   1. TIMELINE. fal's Wan VACE emits a FIXED 81-frame budget. Feeding a clip of
//      any other length makes fal truncate+stretch the timeline, so EVERY region
//      (even "kept" black-mask ones) drifts and the result is unreadable. Fixed-
//      16fps resampling only helps clips that are exactly ~5.06s; a shorter clip
//      still gets padded to 81 frames and runs slow. So here we resample the
//      source to EXACTLY 81 frames at fps = round(81/duration), and tell fal to
//      emit at that same fps. Input and output are then frame-for-frame aligned.
//
//   2. PRESERVATION. Even with aligned timing, VACE does NOT frame-lock the
//      black-mask (kept) region — it reconstructs those pixels too, just softly.
//      So for bit-accurate preservation we DON'T trust VACE outside the mask at
//      all: we composite the VACE output INTO the frame-matched source using the
//      mask as an alpha (white = take VACE, black = take source, feather = blend).
//      Kept regions become pixel-identical to the source by construction; we only
//      ever keep VACE's work inside the edit region.
//
// This is the reliability path: instead of hoping the model leaves things alone,
// we constrain it to. What we're actually measuring is whether VACE, given a tight
// mask + aligned timeline, produces a GOOD edit INSIDE the mask — the preservation
// outside is guaranteed by the composite, not by the model.
//
// Flow:  src --resample-->  src81 (81f) --make-mask--> mask81
//        wan-vace(src81, mask81, prompt) --> vace.mp4 (81f, same timeline)
//        alphamerge(vace over src81, alpha=mask81) --> composite.mp4
//        analyze composite vs src81  AND  raw vace vs src81 (to show the delta)
//
// Usage:
//   node mask-composite-spike.js prep  --src <clip.mp4> [--out <dir>]
//        --box cx,cy,w,h | --ellipse cx,cy,rx,ry  [--feather px] [--window s,e]
//        builds src81.mp4 + mask81.mp4 in the work dir (no credits).
//   node mask-composite-spike.js run   [--out <dir>] --prompt "..." [--negative "..."]
//        [--model wan-vace-14b|wan-22-vace-fun-a14b] [--resolution auto|480p|580p|720p]
//        [--seed N] [--go]           without --go: dry run, spends nothing.
//   node mask-composite-spike.js composite [--out <dir>]   # re-run just the merge
//   node mask-composite-spike.js report    [--out <dir>]   # analyze composite + raw
//
// Work dir defaults to evaluation/video-editing-eval/mask-composite-spike/ (gitignored).

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? true); };
const has = (n) => argv.includes(`--${n}`);

const FRAME_BUDGET = 81; // fal Wan VACE hard budget — see memory wan-fal-timeline-truncation.

const workDir = () => {
  const o = arg('out');
  return o && o !== true ? path.resolve(o) : path.join(repoRoot, 'evaluation', 'video-editing-eval', 'mask-composite-spike');
};
const P = (f) => path.join(workDir(), f);
const cfgPath = () => P('spike.json');
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
const loadCfg = async () => JSON.parse(await readFile(cfgPath(), 'utf8'));

function exec(bin, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    if (capture) { c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d)); }
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} exit ${code}\n${out.slice(-800)}`))));
  });
}
const ff = (args, o) => exec('ffmpeg', ['-v', 'error', '-y', ...args], o);

async function probe(file) {
  const o = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames:format=duration', '-of', 'default=noprint_wrappers=1', file], { capture: true });
  const get = (k) => (o.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim();
  return { w: Number(get('width')), h: Number(get('height')), frames: Number(get('nb_frames')) || null, dur: Number(get('duration')) || null };
}
async function frameCount(file) {
  const p = await probe(file);
  if (p.frames) return p.frames;
  // nb_frames is often absent in re-encoded files; count frames explicitly.
  const o = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-of', 'default=nokey=1:noprint_wrappers=1', file],
    { capture: true }).catch(() => '');
  return Number(String(o).trim()) || null;
}

// Resample `src` to EXACTLY 81 frames spanning its full duration. Returns the fps
// fal must emit at so the output timeline matches (duration ≈ 81/fps ≈ source).
async function resampleTo81(src, dest) {
  const { dur } = await probe(src);
  if (!dur) throw new Error(`could not probe duration of ${src}`);
  const fps = Math.min(30, Math.max(5, Math.round(FRAME_BUDGET / dur)));
  // fps filter gives ~81 frames; tpad clones the tail if we came up short; then cap at 81.
  await ff(['-i', src, '-vf', `fps=${fps},tpad=stop_mode=clone:stop_duration=2`,
    '-frames:v', String(FRAME_BUDGET), '-an', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', dest]);
  const got = await frameCount(dest);
  if (got !== FRAME_BUDGET) {
    console.warn(`warning: ${path.basename(dest)} has ${got} frames, expected ${FRAME_BUDGET}. ` +
      `Timeline may drift; widen source or check ffmpeg.`);
  }
  return { fps, dur };
}

async function prep() {
  const src = arg('src');
  if (!src || src === true) { console.error('usage: prep --src <clip.mp4> [--box .. | --ellipse ..] [--feather px] [--window s,e] [--out dir]'); process.exit(2); }
  const srcAbs = path.resolve(src);
  if (!(await exists(srcAbs))) { console.error(`source not found: ${srcAbs}`); process.exit(2); }
  await mkdir(workDir(), { recursive: true });

  console.log('resampling source to exactly 81 frames (fal Wan VACE budget)…');
  const { fps, dur } = await resampleTo81(srcAbs, P('src81.mp4'));
  console.log(`  src81.mp4: ${FRAME_BUDGET} frames @ ${fps}fps (source ${dur?.toFixed(2)}s) — fal must emit at ${fps}fps.`);

  // Build the mask FROM src81 so it is frame-matched (make-mask.js filters the source itself).
  const mkArgs = ['--src', P('src81.mp4'), '--out', P('mask81.mp4')];
  const region = { kind: null };
  if (arg('box') && arg('box') !== true) { mkArgs.push('--box', String(arg('box'))); region.kind = 'box'; region.box = String(arg('box')); }
  else if (arg('ellipse') && arg('ellipse') !== true) { mkArgs.push('--ellipse', String(arg('ellipse'))); region.kind = 'ellipse'; region.ellipse = String(arg('ellipse')); }
  else { region.kind = 'full-frame'; }
  const feather = arg('feather', region.kind === 'full-frame' ? undefined : '8');
  if (feather !== undefined) mkArgs.push('--feather', String(feather));
  const win = arg('window');
  if (win && win !== true) { mkArgs.push('--window', String(win)); region.window = String(win); }
  console.log(`building mask (${region.kind}${region.window ? ` gated ${region.window}s` : ''})…`);
  await exec('node', [path.join(here, 'make-mask.js'), ...mkArgs]);

  const cfg = { src: path.relative(repoRoot, srcAbs), fps, dur, region, feather: feather ?? null };
  await writeFile(cfgPath(), JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\nprepped. next: node mask-composite-spike.js run --out "${path.relative(repoRoot, workDir())}" --prompt "…" [--go]`);
}

async function run() {
  const cfg = await loadCfg();
  const prompt = arg('prompt');
  if (!prompt || prompt === true) { console.error('run: --prompt "…" is required'); process.exit(2); }
  if (!(await exists(P('src81.mp4'))) || !(await exists(P('mask81.mp4')))) { console.error('run prep first (missing src81.mp4/mask81.mp4)'); process.exit(2); }
  const go = has('go');
  const model = arg('model', 'wan-vace-14b');
  const vaceDir = P('vace');
  await mkdir(vaceDir, { recursive: true });

  const wanArgs = [path.join(here, 'wan-vace.js'), 'submit',
    '--video', P('src81.mp4'), '--mask', P('mask81.mp4'), '--prompt', String(prompt),
    '--model', String(model), '--out', vaceDir,
    // inputs are already exactly 81 frames — don't let wan-vace resample; pin fps
    // to the value that keeps the output timeline aligned with src81.
    '--no-resample', '--fps', String(cfg.fps)];
  if (arg('negative') && arg('negative') !== true) wanArgs.push('--negative', String(arg('negative')));
  if (arg('resolution') && arg('resolution') !== true) wanArgs.push('--resolution', String(arg('resolution')));
  if (arg('seed') && arg('seed') !== true) wanArgs.push('--seed', String(arg('seed')));
  if (!go) wanArgs.push('--dry-run');

  console.log(`${go ? 'RUN' : 'DRY RUN'}: wan-vace ${model} @ ${cfg.fps}fps, prompt="${prompt}"`);
  const r = await exec('node', wanArgs);
  await writeFile(cfgPath(), JSON.stringify({ ...cfg, prompt: String(prompt), model: String(model), lastRun: new Date().toISOString() }, null, 2) + '\n');
  if (!go) { console.log('\n(dry run: pass --go to submit and spend credits, then composite + report)'); return; }
  if (await exists(path.join(vaceDir, 'output.mp4'))) { await composite(); await report(); }
  else console.error('vace/output.mp4 not found after run — check vace/task.json');
}

// Composite the VACE output INTO the frame-matched source using the mask as alpha:
// white mask -> VACE pixels, black -> source pixels, feathered edge -> blend.
// Kept regions become pixel-identical to src81 by construction.
async function composite() {
  const src = P('src81.mp4'), vace = path.join(P('vace'), 'output.mp4'), mask = P('mask81.mp4');
  for (const f of [src, vace, mask]) if (!(await exists(f))) { console.error(`composite: missing ${f}`); process.exit(2); }
  const { w, h } = await probe(src);
  // Scale VACE + mask back to source dims (fal may return a lower --resolution),
  // attach the mask as alpha to the VACE layer, overlay it on the source.
  const fc =
    `[1:v]scale=${w}:${h}:flags=bicubic,format=yuva420p[top];` +
    `[2:v]scale=${w}:${h}:flags=bicubic,format=gray[m];` +
    `[top][m]alphamerge[topa];` +
    `[0:v][topa]overlay=shortest=1:format=auto[v]`;
  await ff(['-i', src, '-i', vace, '-i', mask, '-filter_complex', fc, '-map', '[v]',
    '-r', String((await loadCfg()).fps), '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', P('composite.mp4')]);
  console.log(`composite.mp4 written (VACE inside mask, source elsewhere).`);
}

// Analyze BOTH the raw VACE output and the composite against the frame-matched
// source. The gap between them is exactly the leakage the composite removes.
async function report() {
  const src = P('src81.mp4');
  const runAnalyze = async (outFile, dir, label) => {
    if (!(await exists(outFile))) { console.warn(`report: ${label} missing (${outFile}) — skipping`); return; }
    await mkdir(dir, { recursive: true });
    console.log(`\n=== analyze: ${label} vs src81 ===`);
    await exec('node', [path.join(here, 'analyze.js'), '--src', src, '--out', outFile, '--dir', dir]);
  };
  await runAnalyze(path.join(P('vace'), 'output.mp4'), P('analyze-raw'), 'raw VACE');
  await runAnalyze(P('composite.mp4'), P('analyze-composite'), 'composite');
  console.log(`\nCompare summary.json in ${path.relative(repoRoot, P('analyze-raw'))}/ and ${path.relative(repoRoot, P('analyze-composite'))}/.`);
  console.log('Expectation: composite shows near-perfect preservation outside the mask; the edit quality is judged INSIDE the mask (diff-heatmap.mp4).');
}

const cmds = { prep, run, composite, report };
if (!cmds[cmd]) {
  console.log('usage: mask-composite-spike.js <prep|run|composite|report> [flags] — see header comment');
  process.exit(cmd ? 2 : 0);
}
cmds[cmd]().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
