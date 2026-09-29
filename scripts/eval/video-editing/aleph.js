#!/usr/bin/env node
// THROWAWAY SPIKE — not wired into the pipeline. Minimal Runway API client for
// Aleph video-to-video, used to evaluate how close Aleph stays to a source draft
// when asked for a localized edit. See README.md.
//
// Usage:
//   RUNWAY_API_KEY=... node aleph.js submit \
//     --video path/to/draft.mp4 \
//     --prompt "change the wall color to deep green, leave everything else unchanged" \
//     [--model aleph2] [--ratio 832:1104] [--seed 123] [--out <dir>] [--dry-run]
//
// On success, writes <out>/output.mp4 plus request.json and task.json.
//
// API detail caveats (confirm against https://docs.dev.runwayml.com/ before a big run):
//   - MODEL id: Aleph 2.0 is `aleph2`; the deprecated Gen-4 Aleph was `gen4_aleph`.
//   - RATIO must be one of Runway's allowed pixel ratios (see RATIOS below).
//   - videoUri here is sent as a base64 data URI. Runway caps request size, so
//     keep the test clip SHORT and LOW-RES (a 5s draft is ideal). For a bigger
//     clip, host it and pass an https URL via --video-url instead.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from '../../../src/env.js';

// Pick up RUNWAY_API_KEY from the repo-root .env (shell env still wins).
loadEnv();

const BASE = process.env.RUNWAY_API_BASE || 'https://api.dev.runwayml.com/v1';
const VERSION = process.env.RUNWAY_API_VERSION || '2024-11-06';

// Runway's allowed output ratios (pixels). 832:1104 ~= 3:4 portrait, which is
// this pipeline's default aspect. 720:1280 = 9:16, 1280:720 = 16:9.
const RATIOS = new Set([
  '1280:720', '720:1280', '1104:832', '960:960',
  '832:1104', '1584:672', '848:480', '640:480',
]);

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
  const key = process.env.RUNWAY_API_KEY;
  if (!key) {
    console.error('error: RUNWAY_API_KEY is not set. Export it or prefix the command.');
    process.exit(2);
  }
  return key;
}

function headers(key) {
  return {
    Authorization: `Bearer ${key}`,
    'X-Runway-Version': VERSION,
    'Content-Type': 'application/json',
  };
}

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

async function toDataUri(filePath) {
  const buf = await readFile(filePath);
  const mb = buf.length / (1024 * 1024);
  const b64mb = (buf.length * 4 / 3) / (1024 * 1024);
  if (b64mb > 5) {
    console.warn(`warning: ${filePath} is ${b64mb.toFixed(1)}MB as a data URI; Runway caps data URIs ` +
      `at 5MB. Use a shorter/lower-res clip or --video-url.`);
  }
  const mime = MIME[path.extname(filePath).toLowerCase()] ||
    { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(filePath).toLowerCase()] ||
    'video/mp4';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submit(args) {
  const model = args.model && args.model !== true ? args.model : 'aleph2';
  const ratio = args.ratio && args.ratio !== true ? args.ratio : '832:1104';
  if (!RATIOS.has(ratio)) {
    console.error(`error: --ratio ${ratio} is not one of Runway's allowed ratios:\n  ${[...RATIOS].join(', ')}`);
    process.exit(2);
  }
  const prompt = args.prompt && args.prompt !== true ? String(args.prompt) : null;
  if (!prompt) { console.error('error: --prompt is required'); process.exit(2); }

  let videoUri;
  if (args['video-url'] && args['video-url'] !== true) {
    videoUri = String(args['video-url']);
  } else if (args.video && args.video !== true) {
    videoUri = await toDataUri(String(args.video));
  } else {
    console.error('error: pass --video <path> or --video-url <https url>');
    process.exit(2);
  }

  const body = { model, promptText: prompt, videoUri, ratio };
  if (args.seed && args.seed !== true) body.seed = Number(args.seed);

  // --keyframes <json>: [{"path":"kf.png","seconds":1.2}, ...] (max 5). Aleph 2.0 native
  // timed guidance images; `seconds` is relative to the submitted video.
  if (args.keyframes && args.keyframes !== true) {
    const list = JSON.parse(await readFile(String(args.keyframes), 'utf8'));
    if (!Array.isArray(list) || !list.length || list.length > 5) {
      console.error('error: --keyframes must be a JSON array of 1-5 {path, seconds}');
      process.exit(2);
    }
    body.keyframes = [];
    for (const k of list) body.keyframes.push({ uri: await toDataUri(k.path), seconds: k.seconds });
  }

  const outDir = args.out && args.out !== true
    ? String(args.out)
    : path.join('evaluation', 'aleph-stability', `run-${Date.now()}`);
  await mkdir(outDir, { recursive: true });

  // request.json omits the (huge) data URI so it stays readable.
  await writeFile(path.join(outDir, 'request.json'),
    JSON.stringify({
      ...body,
      videoUri: videoUri.slice(0, 64) + '…(elided)',
      ...(body.keyframes && { keyframes: body.keyframes.map((k) => ({ ...k, uri: k.uri.slice(0, 48) + '…(elided)' })) }),
    }, null, 2) + '\n');

  if (args['dry-run']) {
    console.log(`[dry-run] POST ${BASE}/video_to_video  model=${model} ratio=${ratio}`);
    console.log(`[dry-run] prompt: ${prompt}`);
    console.log(`[dry-run] would write output to ${outDir}`);
    return;
  }

  const key = requireKey();
  console.log(`submitting aleph job (model=${model}, ratio=${ratio})…`);
  const res = await fetch(`${BASE}/video_to_video`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`submit failed (HTTP ${res.status}): ${text}`);
    process.exit(1);
  }
  const job = JSON.parse(text);
  const id = job.id;
  if (!id) { console.error(`submit returned no task id: ${text}`); process.exit(1); }
  console.log(`task id: ${id} — polling…`);

  const task = await poll(key, id);
  await writeFile(path.join(outDir, 'task.json'), JSON.stringify(task, null, 2) + '\n');

  if (task.status !== 'SUCCEEDED') {
    console.error(`task ${task.status}: ${task.failure || task.failureCode || 'no detail'}`);
    process.exit(1);
  }
  const url = Array.isArray(task.output) ? task.output[0] : task.output;
  if (!url) { console.error('task SUCCEEDED but no output url'); process.exit(1); }

  const outPath = path.join(outDir, 'output.mp4');
  await download(url, outPath);
  console.log(`\ndone. output -> ${outPath}`);
  console.log(`next: node analyze.js --src "${args.video || args['video-url']}" --out "${outPath}" --dir "${outDir}"`);
}

async function poll(key, id, { intervalMs = 5000, maxMs = 15 * 60 * 1000 } = {}) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < maxMs) {
    const res = await fetch(`${BASE}/tasks/${id}`, { headers: headers(key) });
    const text = await res.text();
    if (!res.ok) {
      // Transient read errors shouldn't kill a running job; log and retry.
      console.warn(`poll HTTP ${res.status}: ${text.slice(0, 200)}`);
      await sleep(intervalMs);
      continue;
    }
    const task = JSON.parse(text);
    if (task.status !== last) { process.stdout.write(`\n  ${task.status}`); last = task.status; }
    else { process.stdout.write('.'); }
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await sleep(intervalMs);
  }
  return { status: 'FAILED', failure: 'client timed out waiting for completion' };
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
  console.log(`usage: node aleph.js submit --video <path> --prompt "…" [--model aleph2] [--ratio 832:1104] [--seed N] [--out <dir>] [--dry-run]`);
  process.exit(cmd ? 2 : 0);
}
