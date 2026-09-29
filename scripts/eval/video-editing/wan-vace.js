#!/usr/bin/env node
// THROWAWAY SPIKE — not wired into the pipeline. Minimal fal.ai client for
// Wan VACE masked video-to-video (MV2V) inpainting, used to evaluate whether a
// source-video + mask-video + prompt contract gives tighter spatial/temporal
// control than Aleph's prompt-only redraw. Mirrors aleph.js so results file
// beside it on the same eval suite. See README.md.
//
// Usage:
//   FAL_KEY=... node wan-vace.js submit \
//     --video path/to/draft.mp4 \
//     --mask  path/to/mask.mp4 \
//     --prompt "the character's eyes are bright blue" \
//     [--model wan-vace-14b] [--out <dir>] [--seed 123] [--dry-run]
//
//   # hosted inputs (skip the data-URI size cap):
//   FAL_KEY=... node wan-vace.js submit --video-url https://… --mask-url https://… --prompt "…"
//
// On success, writes <out>/output.mp4 plus request.json and task.json.
//
// API detail caveats (confirm against https://fal.ai/models/fal-ai/wan-vace-14b/inpainting/api):
//   - MODEL: `wan-vace-14b` (Wan 2.1 VACE) or `wan-22-vace-fun-a14b` (Wan 2.2 Fun).
//     Both expose an /inpainting path with the same core inputs.
//   - INPUTS: prompt, video_url, mask_video_url. Mask is a video where WHITE =
//     "regenerate this pixel" and BLACK = "keep the source pixel". make-mask.js
//     produces masks in that convention.
//   - fal accepts base64 data URIs for file inputs, but caps request size. Keep
//     the test clip SHORT + LOW-RES, or host it and use --video-url/--mask-url.
//   - PRICING is per output second by resolution (~$0.04 480p .. $0.08 720p),
//     NOT per-credit like Aleph — cheap enough to iterate.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadEnv } from '../../../src/env.js';

// Pick up FAL_KEY from the repo-root .env (shell env still wins).
loadEnv();

const BASE = process.env.FAL_QUEUE_BASE || 'https://queue.fal.run';

// fal's Wan VACE endpoints generate a FIXED 81-frame budget; frames_per_second
// only sets the container rate, and there is no num_frames input. Feeding a
// longer clip makes fal take ~the first 81 frames and stretch them across the
// output — the result runs slow, lags progressively, and silently drops the
// tail. So we pre-resample any over-length local input to 16fps (81 frames ≈
// 5.06s) BEFORE upload, keeping the source's full duration. See memory
// wan-fal-timeline-truncation.
const FRAME_BUDGET = 81;
const RESAMPLE_FPS = 16;

// Model slug -> fal endpoint path (both use the /inpainting sub-route).
const MODELS = {
  'wan-vace-14b': 'fal-ai/wan-vace-14b/inpainting',
  'wan-22-vace-fun-a14b': 'fal-ai/wan-22-vace-fun-a14b/inpainting',
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else { out._.push(a); }
  }
  return out;
}

function requireKey() {
  const key = process.env.FAL_KEY;
  if (!key) {
    console.error('error: FAL_KEY is not set. Export it or prefix the command.');
    process.exit(2);
  }
  return key;
}

function headers(key) {
  return { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
}

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

async function toDataUri(filePath) {
  const buf = await readFile(filePath);
  const b64mb = (buf.length * 4 / 3) / (1024 * 1024);
  if (b64mb > 8) {
    console.warn(`warning: ${filePath} is ~${b64mb.toFixed(1)}MB as a data URI. ` +
      `fal caps request size — use a shorter/lower-res clip or --video-url/--mask-url.`);
  }
  const mime = MIME[path.extname(filePath).toLowerCase()] || 'video/mp4';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runProc(bin, procArgs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, procArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${err.slice(0, 200)}`))));
  });
}

// Frame count + integer fps of a local video (null if ffprobe is unavailable).
async function probeVideo(file) {
  try {
    // Keep keys so we don't depend on ffprobe's field output order.
    const out = await runProc('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_frames,avg_frame_rate', '-of', 'default=noprint_wrappers=1', file]);
    const get = (k) => (out.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim();
    const m = String(get('avg_frame_rate')).match(/^(\d+)\/(\d+)$/);
    const fps = m && Number(m[2]) ? Math.round(Number(m[1]) / Number(m[2])) : null;
    const frames = Number(get('nb_frames')) || null;
    return { frames, fps };
  } catch { return null; }
}

async function resampleTo(src, dest, fps) {
  await runProc('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vf', `fps=${fps}`,
    '-an', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', dest]);
}

// Enforce the 81-frame budget on a LOCAL video+mask pair: if the video exceeds
// the budget, resample BOTH to RESAMPLE_FPS (keeping them frame-matched) into
// outDir and return the new paths. URLs pass through untouched (can't inspect).
async function preflightBudget(videoPath, maskPath, outDir, noResample) {
  const info = await probeVideo(videoPath);
  if (!info || !info.frames) {
    console.warn('warning: could not probe input frame count (ffprobe missing?). ' +
      `Skipping budget check — if the clip exceeds ${FRAME_BUDGET} frames, fal will truncate+stretch it.`);
    return { videoPath, maskPath, resampled: false };
  }
  if (info.frames <= FRAME_BUDGET) return { videoPath, maskPath, resampled: false };
  if (noResample) {
    console.error(`error: input has ${info.frames} frames (> ${FRAME_BUDGET} budget) and --no-resample is set. ` +
      `fal would truncate+stretch it. Pre-resample to ${RESAMPLE_FPS}fps or drop --no-resample.`);
    process.exit(2);
  }
  console.warn(`note: input is ${info.frames} frames @ ${info.fps ?? '?'}fps (> ${FRAME_BUDGET}-frame budget). ` +
    `Resampling video + mask to ${RESAMPLE_FPS}fps so fal doesn't truncate+stretch the timeline.`);
  const rv = path.join(outDir, 'input-video-16fps.mp4');
  const rm = path.join(outDir, 'input-mask-16fps.mp4');
  await resampleTo(videoPath, rv, RESAMPLE_FPS);
  await resampleTo(maskPath, rm, RESAMPLE_FPS);
  const after = await probeVideo(rv);
  if (after && after.frames > FRAME_BUDGET) {
    console.error(`error: still ${after.frames} frames after resampling to ${RESAMPLE_FPS}fps ` +
      `(clip longer than ~${(FRAME_BUDGET / RESAMPLE_FPS).toFixed(1)}s). Shorten the clip.`);
    process.exit(2);
  }
  return { videoPath: rv, maskPath: rm, resampled: true };
}

// Returns { kind: 'url'|'path', value }. --*-url wins over --* path.
function rawInput(args, urlKey, pathKey, label) {
  if (args[urlKey] && args[urlKey] !== true) return { kind: 'url', value: String(args[urlKey]) };
  if (args[pathKey] && args[pathKey] !== true) return { kind: 'path', value: String(args[pathKey]) };
  console.error(`error: pass --${pathKey} <path> or --${urlKey} <https url> for the ${label}`);
  process.exit(2);
}

async function submit(args) {
  const model = args.model && args.model !== true ? String(args.model) : 'wan-vace-14b';
  const endpoint = MODELS[model];
  if (!endpoint) {
    console.error(`error: --model ${model} unknown. Known: ${Object.keys(MODELS).join(', ')}`);
    process.exit(2);
  }
  const prompt = args.prompt && args.prompt !== true ? String(args.prompt) : null;
  if (!prompt) { console.error('error: --prompt is required'); process.exit(2); }

  const videoIn = rawInput(args, 'video-url', 'video', 'source video');
  const maskIn = rawInput(args, 'mask-url', 'mask', 'mask video');

  const outDir = args.out && args.out !== true
    ? String(args.out)
    : path.join('evaluation', 'wan-vace-spike', `run-${Date.now()}`);
  await mkdir(outDir, { recursive: true });

  // Budget preflight: only when BOTH inputs are local files (a resample must
  // keep video+mask frame-matched, which we can't do to a remote URL).
  let videoSrc = videoIn.value, maskSrc = maskIn.value, resampled = false;
  if (videoIn.kind === 'path' && maskIn.kind === 'path') {
    ({ videoPath: videoSrc, maskPath: maskSrc, resampled } =
      await preflightBudget(videoIn.value, maskIn.value, outDir, !!args['no-resample']));
  } else if (videoIn.kind === 'url' || maskIn.kind === 'url') {
    console.warn(`note: input is a URL — skipping the ${FRAME_BUDGET}-frame budget check. ` +
      `Ensure the clip is <= ${FRAME_BUDGET} frames (~${(FRAME_BUDGET / RESAMPLE_FPS).toFixed(1)}s @${RESAMPLE_FPS}fps) or fal will truncate+stretch it.`);
  }
  const videoUri = videoIn.kind === 'url' ? videoSrc : await toDataUri(videoSrc);
  const maskUri = maskIn.kind === 'url' ? maskSrc : await toDataUri(maskSrc);

  const body = { prompt, video_url: videoUri, mask_video_url: maskUri };
  if (args.seed && args.seed !== true) body.seed = Number(args.seed);
  // Optional negative prompt to fight VACE's tendency to add motion/detail.
  if (args.negative && args.negative !== true) body.negative_prompt = String(args.negative);
  // --fps: fal `frames_per_second` (5-30, default 16) — the output container rate.
  // With the 81-frame budget, duration = 81/fps, so fps also sets how much wall
  // time the output spans. If we resampled the inputs to RESAMPLE_FPS above, the
  // output MUST use that same fps or the timeline desyncs again — so it wins over
  // a conflicting --fps.
  let fps = args.fps && args.fps !== true ? Number(args.fps) : null;
  if (resampled) {
    if (fps && fps !== RESAMPLE_FPS) {
      console.warn(`note: inputs were resampled to ${RESAMPLE_FPS}fps; overriding --fps ${fps} with ${RESAMPLE_FPS} to keep the timeline aligned.`);
    }
    fps = RESAMPLE_FPS;
  }
  if (fps) body.frames_per_second = fps;
  // --resolution: fal enum auto|240p|360p|480p|580p|720p (default auto ≈ source).
  if (args.resolution && args.resolution !== true) body.resolution = String(args.resolution);

  // request.json elides the (huge) data URIs so it stays readable.
  const elide = (u) => (typeof u === 'string' && u.startsWith('data:') ? u.slice(0, 48) + '…(elided)' : u);
  await writeFile(path.join(outDir, 'request.json'),
    JSON.stringify({ model, endpoint, ...body, video_url: elide(videoUri), mask_video_url: elide(maskUri) }, null, 2) + '\n');

  if (args['dry-run']) {
    console.log(`[dry-run] POST ${BASE}/${endpoint}  model=${model}`);
    console.log(`[dry-run] prompt: ${prompt}`);
    console.log(`[dry-run] would write output to ${outDir}`);
    return;
  }

  const key = requireKey();
  console.log(`submitting wan-vace job (model=${model})…`);
  const res = await fetch(`${BASE}/${endpoint}`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`submit failed (HTTP ${res.status}): ${text}`); process.exit(1); }
  const queued = JSON.parse(text);
  const id = queued.request_id;
  const statusUrl = queued.status_url || `${BASE}/${endpoint}/requests/${id}/status`;
  const responseUrl = queued.response_url || `${BASE}/${endpoint}/requests/${id}`;
  if (!id) { console.error(`submit returned no request_id: ${text}`); process.exit(1); }
  console.log(`request id: ${id} — polling…`);

  const task = await poll(key, statusUrl);
  let result = task;
  if (task.status === 'COMPLETED') {
    const r = await fetch(responseUrl, { headers: headers(key) });
    result = await r.json();
  }
  await writeFile(path.join(outDir, 'task.json'), JSON.stringify(result, null, 2) + '\n');

  if (task.status !== 'COMPLETED') {
    console.error(`task ${task.status}: ${JSON.stringify(task.error || task.logs || 'no detail')}`);
    process.exit(1);
  }
  const url = result?.video?.url || (Array.isArray(result?.videos) ? result.videos[0]?.url : null);
  if (!url) { console.error(`task COMPLETED but no output url:\n${JSON.stringify(result, null, 2)}`); process.exit(1); }

  const outPath = path.join(outDir, 'output.mp4');
  await download(url, outPath);
  console.log(`\ndone. output -> ${outPath}`);
  console.log(`next: node analyze.js --src "${args.video || args['video-url']}" --out "${outPath}" --dir "${outDir}"`);
}

async function poll(key, statusUrl, { intervalMs = 5000, maxMs = 15 * 60 * 1000 } = {}) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < maxMs) {
    const res = await fetch(statusUrl, { headers: headers(key) });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`poll HTTP ${res.status}: ${text.slice(0, 200)}`);
      await sleep(intervalMs);
      continue;
    }
    const task = JSON.parse(text);
    if (task.status !== last) { process.stdout.write(`\n  ${task.status}`); last = task.status; }
    else { process.stdout.write('.'); }
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'ERROR'].includes(task.status)) return task;
    await sleep(intervalMs);
  }
  return { status: 'FAILED', error: 'client timed out waiting for completion' };
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === 'submit') {
  submit(args).catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
} else {
  console.log(`usage: node wan-vace.js submit --video <path> --mask <path> --prompt "…" ` +
    `[--model wan-vace-14b|wan-22-vace-fun-a14b] [--fps 16] [--resolution auto|480p|580p|720p] ` +
    `[--no-resample] [--seed N] [--negative "…"] [--out <dir>] [--dry-run]`);
  process.exit(cmd ? 2 : 0);
}
