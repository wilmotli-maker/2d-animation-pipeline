#!/usr/bin/env node
// Direct MuAPI (muapi.ai) Seedance 2.5 client — bypasses higgsfield so the keyframe-edit +
// speech-ref combo (which HF blocks as nsfw) can run. Omni Reference by default; --spicy uses
// the relaxed-moderation route. Local files are uploaded to fal storage (public URLs) because
// MuAPI takes URLs only.
//
//   MUAPI_KEY=... FAL_KEY=... node muapi-seedance.js \
//     --prompt-file <p.md> --image a.png --image b.png ... --video speech-ref.mp4 \
//     [--route omni-reference] [--spicy] [--resolution 480p] \
//     [--aspect-ratio 3:4] [--duration 4] [--generate-audio true] [--out <dir>] [--dry-run]
//
// Reference role/order is expressed with @Image1../@Video1 tags IN THE PROMPT (MuAPI sends
// images_list/videos_list as separate arrays; there is no cross-array ordering).

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..', '..', '..');
// load .env (shell env wins)
if (existsSync(path.join(REPO_ROOT, '.env'))) {
  for (const line of readFileSync(path.join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const MUAPI_BASE = 'https://api.muapi.ai/api/v1';
const FAL_INITIATE = 'https://rest.alpha.fal.ai/storage/upload/initiate';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { _: [], image: [], video: [], audio: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2); const n = argv[i + 1];
      const v = (n === undefined || n.startsWith('--')) ? true : (i++, n);
      if (k === 'image' || k === 'video' || k === 'audio') out[k].push(v); else out[k] = v;
    } else out._.push(a);
  }
  return out;
}

// upload a local file to fal storage, return its public URL
async function falUpload(file, key) {
  const ct = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const init = await fetch(FAL_INITIATE, { method: 'POST', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content_type: ct, file_name: path.basename(file) }) });
  if (!init.ok) throw new Error(`fal initiate ${init.status}: ${(await init.text()).slice(0, 200)}`);
  const { file_url, upload_url } = JSON.parse(await init.text());
  const put = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': ct }, body: await readFile(file) });
  if (!put.ok) throw new Error(`fal PUT ${put.status}`);
  return file_url;
}
// pass through http(s) URLs; upload local paths
async function toUrl(ref, key) { return /^https?:\/\//.test(ref) ? ref : falUpload(ref, key); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const MUAPI = process.env.MUAPI_KEY, FAL = process.env.FAL_KEY;
  const promptFile = args['prompt-file'];
  if (!promptFile) { console.error('error: --prompt-file required'); process.exit(2); }
  const prompt = (await readFile(promptFile, 'utf8')).trim();

  const routeBase = (args.route && args.route !== true) ? String(args.route) : 'omni-reference';
  const spicy = args.spicy === true || args.spicy === 'true';
  const res = (args.resolution && args.resolution !== true) ? String(args.resolution) : '480p';
  const suffix = res === '720p' ? '' : `-${res}`;             // 720p is the unsuffixed route
  const route = `seedance-2.5-${spicy ? 'spicy-' : ''}${routeBase}${suffix}`;
  const aspect = (args['aspect-ratio'] && args['aspect-ratio'] !== true) ? String(args['aspect-ratio']) : '3:4';
  const duration = Number((args.duration && args.duration !== true) ? args.duration : 4);
  const genAudio = args['generate-audio'] === undefined ? true : String(args['generate-audio']) === 'true';
  const outDir = (args.out && args.out !== true) ? String(args.out) : path.join('evaluation', 'keyframe-edit-muapi', `run-${Date.now()}`);
  await mkdir(outDir, { recursive: true });

  if (!MUAPI) { console.error('error: MUAPI_KEY not set'); process.exit(2); }
  if (args.image.length && !FAL && args.image.some((r) => !/^https?:/.test(r))) { console.error('error: FAL_KEY needed to upload local files'); process.exit(2); }

  console.log(`uploading inputs to fal storage…`);
  const images_list = []; for (const r of args.image) images_list.push(await toUrl(r, FAL));
  const videos_list = []; for (const r of args.video) videos_list.push(await toUrl(r, FAL));
  const audios_list = []; for (const r of args.audio) audios_list.push(await toUrl(r, FAL));

  const body = { prompt, aspect_ratio: aspect, duration, generate_audio: genAudio };
  if (images_list.length) body.images_list = images_list;
  if (videos_list.length) body.videos_list = videos_list;
  if (audios_list.length) body.audios_list = audios_list;

  await writeFile(path.join(outDir, 'request.json'), JSON.stringify({ route, ...body }, null, 2) + '\n');
  console.log(`route: ${route}  | imgs ${images_list.length} vids ${videos_list.length} auds ${audios_list.length} | ${aspect} ${duration}s audio=${genAudio}`);
  if (args['dry-run']) { console.log('[dry-run] not submitting. URLs + body in request.json'); return; }

  const sub = await fetch(`${MUAPI_BASE}/${route}`, { method: 'POST', headers: { 'x-api-key': MUAPI, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const subText = await sub.text();
  if (!sub.ok) { console.error(`submit failed (HTTP ${sub.status}): ${subText}`); process.exit(1); }
  const reqId = JSON.parse(subText).request_id;
  if (!reqId) { console.error(`no request_id: ${subText}`); process.exit(1); }
  console.log(`request_id: ${reqId} — polling…`);

  const start = Date.now(); let last = '';
  while (Date.now() - start < 15 * 60 * 1000) {
    await sleep(5000);
    const pr = await fetch(`${MUAPI_BASE}/predictions/${reqId}/result`, { headers: { 'x-api-key': MUAPI } });
    const pt = await pr.text();
    if (!pr.ok) { console.warn(`poll HTTP ${pr.status}: ${pt.slice(0, 150)}`); continue; }
    const j = JSON.parse(pt);
    if (j.status !== last) { process.stdout.write(`\n  ${j.status}`); last = j.status; } else process.stdout.write('.');
    if (j.status === 'completed' || j.status === 'failed' || j.status === 'error') {
      await writeFile(path.join(outDir, 'result.json'), JSON.stringify(j, null, 2) + '\n');
      if (j.status !== 'completed') { console.error(`\n${j.status}: ${JSON.stringify(j.error || j).slice(0, 400)}`); process.exit(1); }
      const url = j.outputs?.[0] || j.output?.video?.url || j.video?.url || (Array.isArray(j.outputs) ? j.outputs[0] : null) || j.result?.video_url || j.video_url;
      if (!url) { console.error(`completed but no output url. result.json has the full body:\n${JSON.stringify(j, null, 2).slice(0, 800)}`); process.exit(1); }
      const outPath = path.join(outDir, 'output.mp4');
      const dl = await fetch(url); await writeFile(outPath, Buffer.from(await dl.arrayBuffer()));
      console.log(`\ndone. output -> ${outPath}`);
      return;
    }
  }
  console.error('\nclient timed out'); process.exit(1);
}
main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
