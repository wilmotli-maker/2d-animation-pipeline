#!/usr/bin/env node
// SPIKE (b): TokenFlow — attention / feature-injection consistent video editing.
//
// The thesis from the discussion: rather than masking the model into leaving
// things alone (spike a), attention-injection methods keep STRUCTURE by design.
// TokenFlow edits every frame with a text-to-image diffusion model but propagates
// the same diffusion FEATURES across frames (nearest-neighbour token fusion), so
// layout and motion are inherited from the source while appearance follows the
// prompt. It targets exactly our two weak spots: temporal flicker, and edits that
// redraw the whole subject. It's an APPEARANCE editor (recolor, restyle, material,
// "make it X") — it will NOT add/remove objects or change geometry; for those,
// spike a's masking is the right tool. So point this at the `global` category
// (flat-shaded, red→turquoise, bg swaps) and appearance-style prompts.
//
// Hosting: TokenFlow is a research repo (SD-based, needs a GPU), so we drive a
// hosted copy on Replicate rather than standing up CUDA locally. This mirrors how
// wan-vace.js uses fal — submit → poll → download → analyze.js.
//
// !!! API CAVEATS — confirm on the model page before spending, these change:
//   - Set --version to a Replicate model VERSION HASH you've verified, or export
//     TOKENFLOW_VERSION. There is no single canonical TokenFlow on Replicate; pick
//     one and record its input schema. Search: https://replicate.com/search?query=tokenflow
//   - Input FIELD NAMES below (video/prompt/negative_prompt/pnp_attn_t/pnp_f_t/
//     n_frames/batch_size) are TokenFlow's usual knobs but the specific model may
//     rename them. --dry-run prints the exact body so you can eyeball it first.
//   - pnp_attn_t / pnp_f_t are the plug-and-play injection thresholds (0..1): higher
//     = more of the source structure preserved, less prompt adherence. The paper's
//     defaults are ~0.5 / 0.8. Sweep these — they are the whole point of the spike.
//   - TokenFlow processes a fixed n_frames window; long clips are subsampled. Keep
//     the test clip short (a few seconds) as with the other adapters.
//
// Usage:
//   REPLICATE_API_TOKEN=... node tokenflow-spike.js submit \
//     --video <clip.mp4>            (local; uploaded to Replicate's file store) \
//     --prompt "a turquoise clay dragon" [--negative "…"] \
//     --version <hash> [--attn 0.5] [--feat 0.8] [--frames 40] [--batch 8] \
//     [--out <dir>] [--seed N] [--dry-run]
//   # or skip the upload with a hosted input:
//   ... --video-url https://…/clip.mp4
//
//   node tokenflow-spike.js report --src <clip.mp4> --out <dir>   # analyze vs source

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../../../src/env.js';

loadEnv(); // pick up REPLICATE_API_TOKEN / TOKENFLOW_VERSION from repo-root .env

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const API = 'https://api.replicate.com/v1';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? d ?? true); };
const has = (n) => argv.includes(`--${n}`);
const str = (n, d) => { const v = arg(n); return v && v !== true ? String(v) : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

function requireToken() {
  const t = process.env.REPLICATE_API_TOKEN;
  if (!t) { console.error('error: REPLICATE_API_TOKEN is not set (export it or put it in .env).'); process.exit(2); }
  return t;
}
const authHeaders = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

// Upload a local file to Replicate's file store; returns a served URL usable as
// a prediction input. (Replicate needs an accessible URL or a data URI; the file
// API keeps us off data-URI size caps.)
async function uploadFile(token, file) {
  const buf = await readFile(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const fd = new FormData();
  fd.append('content', new Blob([buf], { type }), path.basename(file));
  const res = await fetch(`${API}/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const text = await res.text();
  if (!res.ok) throw new Error(`file upload failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const url = json?.urls?.get || json?.url;
  if (!url) throw new Error(`file upload returned no URL: ${text.slice(0, 300)}`);
  return url;
}

async function submit() {
  const version = str('version', process.env.TOKENFLOW_VERSION);
  if (!version) {
    console.error('error: --version <replicate-version-hash> is required (or export TOKENFLOW_VERSION).\n' +
      '       Pick a hosted TokenFlow at https://replicate.com/search?query=tokenflow and verify its input schema.');
    process.exit(2);
  }
  const prompt = str('prompt');
  if (!prompt) { console.error('error: --prompt is required'); process.exit(2); }
  const videoUrl = str('video-url');
  const videoPath = str('video');
  if (!videoUrl && !videoPath) { console.error('error: pass --video <path> or --video-url <https url>'); process.exit(2); }

  const outDir = str('out', path.join('evaluation', 'video-editing-eval', 'tokenflow-spike', `run-${Date.now()}`));
  await mkdir(path.resolve(outDir), { recursive: true });

  // TokenFlow's usual input knobs. Field NAMES may differ per hosted model — see caveats.
  const input = {
    prompt,
    negative_prompt: str('negative', 'blurry, low quality, distorted, flickering'),
    pnp_attn_t: Number(arg('attn', 0.5)), // structure-preserving attention-injection threshold
    pnp_f_t: Number(arg('feat', 0.8)),    // feature-injection threshold
    n_frames: Number(arg('frames', 40)),
    batch_size: Number(arg('batch', 8)),
  };
  if (arg('seed') && arg('seed') !== true) input.seed = Number(arg('seed'));

  const dry = has('dry-run');
  const token = dry && !process.env.REPLICATE_API_TOKEN ? null : requireToken();

  // Resolve the video input (upload local files unless dry-run).
  if (videoUrl) input.video = videoUrl;
  else if (dry) input.video = `file://${path.resolve(videoPath)} (would upload)`;
  else { console.log(`uploading ${videoPath} to Replicate…`); input.video = await uploadFile(token, path.resolve(videoPath)); }

  const body = { version, input };
  await writeFile(path.join(outDir, 'request.json'), JSON.stringify(body, null, 2) + '\n');

  if (dry) {
    console.log(`[dry-run] POST ${API}/predictions`);
    console.log(`[dry-run] body:\n${JSON.stringify(body, null, 2)}`);
    console.log(`[dry-run] would write output to ${outDir}`);
    return;
  }

  console.log('submitting TokenFlow prediction…');
  const res = await fetch(`${API}/predictions`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) { console.error(`submit failed (HTTP ${res.status}): ${text}`); process.exit(1); }
  let pred = JSON.parse(text);
  console.log(`prediction ${pred.id} — polling…`);
  pred = await poll(token, pred);
  await writeFile(path.join(outDir, 'task.json'), JSON.stringify(pred, null, 2) + '\n');

  if (pred.status !== 'succeeded') {
    console.error(`prediction ${pred.status}: ${JSON.stringify(pred.error || pred.logs?.slice?.(-400) || 'no detail')}`);
    process.exit(1);
  }
  const url = Array.isArray(pred.output) ? pred.output[pred.output.length - 1] : (typeof pred.output === 'string' ? pred.output : pred.output?.video);
  if (!url) { console.error(`succeeded but no output url:\n${JSON.stringify(pred.output, null, 2)}`); process.exit(1); }
  const outPath = path.join(outDir, 'output.mp4');
  await download(url, outPath);
  console.log(`\ndone. output -> ${outPath}`);
  const srcHint = videoPath || '<source.mp4>';
  console.log(`next: node tokenflow-spike.js report --src "${srcHint}" --out "${outDir}"`);
}

async function poll(token, pred, { intervalMs = 5000, maxMs = 20 * 60 * 1000 } = {}) {
  const start = Date.now();
  const getUrl = pred?.urls?.get || `${API}/predictions/${pred.id}`;
  let last = '';
  while (Date.now() - start < maxMs) {
    const res = await fetch(getUrl, { headers: authHeaders(token) });
    const text = await res.text();
    if (!res.ok) { console.warn(`poll HTTP ${res.status}: ${text.slice(0, 200)}`); await sleep(intervalMs); continue; }
    const p = JSON.parse(text);
    if (p.status !== last) { process.stdout.write(`\n  ${p.status}`); last = p.status; } else { process.stdout.write('.'); }
    if (['succeeded', 'failed', 'canceled'].includes(p.status)) { process.stdout.write('\n'); return p; }
    await sleep(intervalMs);
  }
  return { ...pred, status: 'failed', error: 'client timed out waiting for completion' };
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function report() {
  const src = str('src'); const outDir = str('out');
  if (!src || !outDir) { console.error('usage: report --src <clip.mp4> --out <run dir>'); process.exit(2); }
  const outFile = path.join(path.resolve(outDir), 'output.mp4');
  if (!(await exists(outFile))) { console.error(`no output.mp4 in ${outDir}`); process.exit(2); }
  console.log('=== analyze: TokenFlow vs source ===');
  await new Promise((resolve, reject) => {
    const c = spawn('node', [path.join(here, 'analyze.js'), '--src', path.resolve(src), '--out', outFile, '--dir', path.resolve(outDir)], { stdio: 'inherit' });
    c.on('error', reject); c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`analyze exit ${code}`))));
  });
  console.log('\nRead: does structure/motion hold (low flicker, layout intact) while appearance follows the prompt?');
  console.log('Sweep --attn/--feat higher for more preservation, lower for stronger edits — that trade-off IS the finding.');
}

const cmds = { submit, report };
if (!cmds[cmd]) {
  console.log('usage: tokenflow-spike.js <submit|report> [flags] — see header comment for API caveats');
  process.exit(cmd ? 2 : 0);
}
cmds[cmd]().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
