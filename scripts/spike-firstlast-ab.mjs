#!/usr/bin/env node
// Spike: Seedance 2.5 first/last-frame A/B.
//   Mode A (explicit) -> fal bytedance/seedance-2.5/image-to-video  (image_url + end_image_url; NO seed param)
//   Mode B (omni-ref) -> fal bytedance/seedance-2.5/reference-to-video (image_urls=[first,last], named @Image1/@Image2)
// One sample per mode, no shared seed (image-to-video has no seed field). 480p / 4s / no audio.
// Reuses fal.js's uploader + safe poll semantics. Persists request_id so a poll drop never resubmits
// (see the fal-poll-double-billing lesson). Idempotent: re-running resumes an existing request_id.
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { loadEnv } from '../src/env.js';
import { createFalRunner } from '../src/fal.js';

loadEnv();
const KEY = process.env.FAL_KEY;
if (!KEY) { console.error('FAL_KEY not set'); process.exit(1); }

const SHOT = '/Users/wilmotli/Projects/Seedance Animation/ArtAI/episodes/2/shots/ai12-firstlast-ab';
const first = path.join(SHOT, 'refs/first.png');
const last = path.join(SHOT, 'refs/last.png');
const auth = { Authorization: `Key ${KEY}` };
const QUEUE = (ep) => `https://queue.fal.run/bytedance/seedance-2.5/${ep}`;

const runner = createFalRunner({ falKey: KEY, resolution: '480p' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(reqUrlStatus, reqUrlResp) {
  for (let i = 0; i < 180; i++) {
    const st = await fetch(reqUrlStatus, { headers: auth });
    const sj = JSON.parse(await st.text());
    const s = String(sj.status || '').toUpperCase();
    if (s === 'COMPLETED') {
      const rr = await fetch(reqUrlResp, { headers: auth });
      return JSON.parse(await rr.text());
    }
    if (!['IN_QUEUE', 'IN_PROGRESS', 'PENDING', 'PROCESSING', 'QUEUED'].includes(s)) {
      throw new Error(`terminal status ${s}: ${JSON.stringify(sj).slice(0, 300)}`);
    }
    await sleep(5000);
  }
  throw new Error('poll timed out');
}

async function download(url, out) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  await new Promise((res, rej) => {
    const ws = createWriteStream(out);
    Readable.fromWeb(r.body).pipe(ws).on('finish', res).on('error', rej);
  });
}

// Submit once, remembering request_id in a sidecar so a re-run resumes instead of resubmitting.
async function runMode(name, ep, body, outDir) {
  mkdirSync(outDir, { recursive: true });
  const idFile = path.join(outDir, 'request.json');
  let rec = existsSync(idFile) ? JSON.parse(readFileSync(idFile, 'utf8')) : null;
  if (!rec?.request_id) {
    console.log(`[${name}] submit -> ${ep}`);
    const res = await fetch(QUEUE(ep), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const txt = await res.text();
    if (!res.ok) throw new Error(`[${name}] submit ${res.status}: ${txt.slice(0, 300)}`);
    const j = JSON.parse(txt);
    rec = { endpoint: ep, request_id: j.request_id, status_url: j.status_url, response_url: j.response_url, body };
    writeFileSync(idFile, JSON.stringify(rec, null, 2));
    console.log(`[${name}] request_id=${rec.request_id}`);
  } else {
    console.log(`[${name}] resuming request_id=${rec.request_id}`);
  }
  const statusUrl = rec.status_url || `${QUEUE(ep)}/requests/${rec.request_id}/status`;
  const respUrl = rec.response_url || `${QUEUE(ep)}/requests/${rec.request_id}`;
  const j = await poll(statusUrl, respUrl);
  const url = j?.video?.url || j?.outputs?.[0]?.url || j?.output?.video?.url || null;
  if (!url) throw new Error(`[${name}] no output url: ${JSON.stringify(j).slice(0, 300)}`);
  const out = path.join(outDir, 'output.mp4');
  await download(url, out);
  console.log(`[${name}] saved ${out}`);
  return out;
}

const firstUrl = (await runner.upload(first)).url;
const lastUrl = (await runner.upload(last)).url;
console.log('uploaded first/last frames');

const promptA = readFileSync(path.join(SHOT, 'prompt-modeA.md'), 'utf8').trim();
const promptB = readFileSync(path.join(SHOT, 'prompt-modeB.md'), 'utf8').trim();

// Mode A: explicit start/end frames. image-to-video forces aspect_ratio=auto; no seed field exists.
const bodyA = { prompt: promptA, image_url: firstUrl, end_image_url: lastUrl, resolution: '480p', duration: '4', generate_audio: false };
// Mode B: omni references, first/last named in the prompt. reference-to-video supports aspect/seed.
const bodyB = { prompt: promptB, image_urls: [firstUrl, lastUrl], resolution: '480p', duration: '4', aspect_ratio: '3:4', task: 'reference', generate_audio: false };

await runMode('A-explicit', 'image-to-video', bodyA, path.join(SHOT, 'modeA-explicit'));
await runMode('B-omniref', 'reference-to-video', bodyB, path.join(SHOT, 'modeB-omniref'));
console.log('DONE');
