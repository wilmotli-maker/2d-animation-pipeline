#!/usr/bin/env node
// Stage-2 lip-sync via a DEDICATED audio-driven lip-sync model on fal (default: LatentSync,
// which inpaints only the mouth region to match the audio and claims anime/stylized support).
// This is the alternative to Seedance `video_edit`, whose mouth motion is not phoneme-accurate.
//
//   FAL_KEY=... node fal-lipsync.js --video <silent.mp4> --audio <speech.wav> [--out <dir>]
//                                   [--model latentsync] [--dry-run]
//   (or --video-url / --audio-url for hosted inputs)
//
// Minimal fal queue client, same shape as ../wan-vace.js.

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..', '..', '..');
// pick up FAL_KEY from repo-root .env (shell env still wins)
if (!process.env.FAL_KEY && existsSync(path.join(REPO_ROOT, '.env'))) {
  for (const line of (await readFile(path.join(REPO_ROOT, '.env'), 'utf8')).split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const BASE = process.env.FAL_QUEUE_BASE || 'https://queue.fal.run';
const MODELS = {
  latentsync: 'fal-ai/latentsync',          // ByteDance LatentSync (audio-conditioned latent diffusion)
  'sync-lipsync': 'fal-ai/sync-lipsync',     // sync.so (Wav2Lip descendant)
  musetalk: 'fal-ai/musetalk',
};
const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) out[k] = true; else { out[k] = n; i++; } }
    else out._.push(a);
  }
  return out;
}
const headers = (key) => ({ Authorization: `Key ${key}`, 'Content-Type': 'application/json' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function toDataUri(filePath) {
  const buf = await readFile(filePath);
  const b64mb = (buf.length * 4 / 3) / (1024 * 1024);
  if (b64mb > 8) console.warn(`warning: ${filePath} ~${b64mb.toFixed(1)}MB as data URI; fal caps request size. Use --*-url for large inputs.`);
  const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}
function rawInput(args, urlKey, pathKey, label) {
  if (args[urlKey] && args[urlKey] !== true) return { kind: 'url', value: String(args[urlKey]) };
  if (args[pathKey] && args[pathKey] !== true) return { kind: 'path', value: String(args[pathKey]) };
  console.error(`error: pass --${pathKey} <path> or --${urlKey} <https url> for the ${label}`); process.exit(2);
}
async function resolveUri(inp) { return inp.kind === 'url' ? inp.value : toDataUri(inp.value); }

async function poll(key, statusUrl, { intervalMs = 5000, maxMs = 15 * 60 * 1000 } = {}) {
  const start = Date.now(); let last = '';
  while (Date.now() - start < maxMs) {
    const res = await fetch(statusUrl, { headers: headers(key) });
    const text = await res.text();
    if (!res.ok) { console.warn(`poll HTTP ${res.status}: ${text.slice(0, 200)}`); await sleep(intervalMs); continue; }
    const task = JSON.parse(text);
    if (task.status !== last) { process.stdout.write(`\n  ${task.status}`); last = task.status; } else process.stdout.write('.');
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'ERROR'].includes(task.status)) return task;
    await sleep(intervalMs);
  }
  return { status: 'FAILED', error: 'client timed out' };
}
async function download(url, dest) { const r = await fetch(url); if (!r.ok) throw new Error(`download HTTP ${r.status}`); await writeFile(dest, Buffer.from(await r.arrayBuffer())); }

async function submit(args) {
  const model = args.model && args.model !== true ? String(args.model) : 'latentsync';
  const endpoint = MODELS[model];
  if (!endpoint) { console.error(`error: --model ${model} unknown. Known: ${Object.keys(MODELS).join(', ')}`); process.exit(2); }
  const video = rawInput(args, 'video-url', 'video', 'video');
  const audio = rawInput(args, 'audio-url', 'audio', 'audio');
  const outDir = args.out && args.out !== true ? String(args.out) : path.join('evaluation', 'keyframe-edit-fal-lipsync', `run-${Date.now()}`);
  await mkdir(outDir, { recursive: true });

  const body = { video_url: await resolveUri(video), audio_url: await resolveUri(audio) };
  if (args.seed && args.seed !== true) body.seed = Number(args.seed);
  await writeFile(path.join(outDir, 'request.json'),
    JSON.stringify({ model, endpoint, video_url: video.value, audio_url: audio.value, seed: body.seed }, null, 2) + '\n');

  if (args['dry-run']) { console.log(`[dry-run] POST ${BASE}/${endpoint} (video=${video.value}, audio=${audio.value}) -> ${outDir}`); return; }

  const key = process.env.FAL_KEY;
  if (!key) { console.error('error: FAL_KEY is not set (checked shell env and repo .env).'); process.exit(2); }
  console.log(`submitting ${model} lip-sync job…`);
  const res = await fetch(`${BASE}/${endpoint}`, { method: 'POST', headers: headers(key), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) { console.error(`submit failed (HTTP ${res.status}): ${text}`); process.exit(1); }
  const queued = JSON.parse(text);
  const id = queued.request_id;
  if (!id) { console.error(`submit returned no request_id: ${text}`); process.exit(1); }
  const statusUrl = queued.status_url || `${BASE}/${endpoint}/requests/${id}/status`;
  const responseUrl = queued.response_url || `${BASE}/${endpoint}/requests/${id}`;
  console.log(`request id: ${id} — polling…`);

  const task = await poll(key, statusUrl);
  let result = task;
  if (task.status === 'COMPLETED') { const r = await fetch(responseUrl, { headers: headers(key) }); result = await r.json(); }
  await writeFile(path.join(outDir, 'task.json'), JSON.stringify(result, null, 2) + '\n');
  if (task.status !== 'COMPLETED') { console.error(`\ntask ${task.status}: ${JSON.stringify(task.error || task.logs || 'no detail')}`); process.exit(1); }

  const url = result?.video?.url || (Array.isArray(result?.videos) ? result.videos[0]?.url : null);
  if (!url) { console.error(`COMPLETED but no output url:\n${JSON.stringify(result, null, 2)}`); process.exit(1); }
  const outPath = path.join(outDir, 'output.mp4');
  await download(url, outPath);
  console.log(`\ndone. output -> ${outPath}`);
}

const args = parseArgs(process.argv.slice(2));
if (args._[0] === 'submit' || args.video || args['video-url']) {
  submit(args).catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
} else {
  console.log('usage: FAL_KEY=... node fal-lipsync.js --video <silent.mp4> --audio <speech.wav> [--out <dir>] [--model latentsync|sync-lipsync|musetalk] [--dry-run]');
  process.exit(args._[0] ? 2 : 0);
}
