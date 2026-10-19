#!/usr/bin/env node
// Direct fal.ai Seedance 2.5 reference-to-video client — parallels muapi-seedance.js but hits fal
// natively (bytedance/seedance-2.5/reference-to-video). fal has no moderation on this recipe and
// image/audio references are free (video refs are billed). Local files are uploaded to fal storage.
//
//   FAL_KEY=... node fal-seedance.js --prompt-file <p.md> --image a.png --image b.png \
//     --video speech-ref.mp4 [--resolution 480p] [--aspect-ratio 3:4] [--duration 4] \
//     [--generate-audio true] [--draft] [--out <dir>] [--dry-run]
//
// Reference role/order is expressed in the prompt (fal addresses references by position, like the
// @Image1/@Video1 tags MuAPI uses). Schema: image_urls/video_urls/audio_urls, duration is a STRING.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..', '..', '..');
if (existsSync(path.join(REPO_ROOT, '.env'))) {
  for (const line of readFileSync(path.join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const FAL_INITIATE = 'https://rest.alpha.fal.ai/storage/upload/initiate';
const QUEUE = 'https://queue.fal.run/bytedance/seedance-2.5/reference-to-video';
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
async function falUpload(file, key) {
  const ct = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const init = await fetch(FAL_INITIATE, { method: 'POST', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content_type: ct, file_name: path.basename(file) }) });
  if (!init.ok) throw new Error(`fal initiate ${init.status}: ${(await init.text()).slice(0, 200)}`);
  const { file_url, upload_url } = JSON.parse(await init.text());
  const put = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': ct }, body: await readFile(file) });
  if (!put.ok) throw new Error(`fal PUT ${put.status}`);
  return file_url;
}
const toUrl = (ref, key) => (/^https?:\/\//.test(ref) ? Promise.resolve(ref) : falUpload(ref, key));
const val = (v, d) => (v !== undefined && v !== true ? String(v) : d);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const FAL = process.env.FAL_KEY;
  if (!FAL) { console.error('error: FAL_KEY not set'); process.exit(2); }
  const promptFile = args['prompt-file'];
  if (!promptFile) { console.error('error: --prompt-file required'); process.exit(2); }
  const prompt = (await readFile(promptFile, 'utf8')).trim();
  const resolution = val(args.resolution, '480p');
  const aspect = val(args['aspect-ratio'], '3:4');
  const duration = val(args.duration, '4');                      // fal duration is a STRING enum
  const genAudio = args['generate-audio'] === undefined ? true : String(args['generate-audio']) === 'true';
  const draft = args.draft === true || String(args.draft) === 'true';
  const outDir = val(args.out, path.join('evaluation', 'keyframe-edit-fal', `run-${Date.now()}`));
  await mkdir(outDir, { recursive: true });

  console.log('uploading inputs to fal storage…');
  const image_urls = []; for (const r of args.image) image_urls.push(await toUrl(r, FAL));
  const video_urls = []; for (const r of args.video) video_urls.push(await toUrl(r, FAL));
  const audio_urls = []; for (const r of args.audio) audio_urls.push(await toUrl(r, FAL));
  const body = { prompt, resolution, aspect_ratio: aspect, duration, generate_audio: genAudio, task: 'reference', draft };
  if (image_urls.length) body.image_urls = image_urls;
  if (video_urls.length) body.video_urls = video_urls;
  if (audio_urls.length) body.audio_urls = audio_urls;
  await writeFile(path.join(outDir, 'request.json'), JSON.stringify(body, null, 2) + '\n');
  console.log(`fal seedance-2.5 ref2vid | imgs ${image_urls.length} vids ${video_urls.length} auds ${audio_urls.length} | ${resolution} ${aspect} ${duration}s audio=${genAudio} draft=${draft}`);
  if (args['dry-run']) { console.log('[dry-run] not submitting; body in request.json'); return; }

  const sub = await fetch(QUEUE, { method: 'POST', headers: { Authorization: `Key ${FAL}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const subText = await sub.text();
  if (!sub.ok) { console.error(`submit failed (HTTP ${sub.status}): ${subText.slice(0, 400)}`); process.exit(1); }
  const subJ = JSON.parse(subText);
  const reqId = subJ.request_id;
  // Use the URLs fal returns (constructing them by hand 405s); fall back to the documented shape.
  const statusUrl = subJ.status_url || `${QUEUE}/requests/${reqId}/status`;
  const responseUrl = subJ.response_url || `${QUEUE}/requests/${reqId}`;
  if (!reqId) { console.error(`no request_id: ${subText}`); process.exit(1); }
  console.log(`request_id: ${reqId} — polling…`);

  const start = Date.now(); let last = '';
  while (Date.now() - start < 15 * 60 * 1000) {
    await sleep(5000);
    const st = await fetch(statusUrl, { headers: { Authorization: `Key ${FAL}` } });
    const stText = await st.text();
    if (!stText) { process.stdout.write('·'); continue; }
    const stj = JSON.parse(stText);
    if (stj.status !== last) { process.stdout.write(`\n  ${stj.status}`); last = stj.status; } else process.stdout.write('.');
    if (stj.status === 'COMPLETED') {
      const rr = await fetch(responseUrl, { headers: { Authorization: `Key ${FAL}` } });
      const j = JSON.parse(await rr.text());
      await writeFile(path.join(outDir, 'result.json'), JSON.stringify(j, null, 2) + '\n');
      const url = j.video?.url || j.outputs?.[0]?.url || j.output?.video?.url || (Array.isArray(j.outputs) ? j.outputs[0] : null);
      if (!url) { console.error(`completed but no output url; see result.json`); process.exit(1); }
      const outPath = path.join(outDir, 'output.mp4');
      const dl = await fetch(url); await writeFile(outPath, Buffer.from(await dl.arrayBuffer()));
      console.log(`\ndone. output -> ${outPath}`);
      return;
    }
    if (['FAILED', 'ERROR', 'CANCELLED'].includes(stj.status)) { console.error(`\n${stj.status}: ${JSON.stringify(stj).slice(0, 400)}`); process.exit(1); }
  }
  console.error('\nclient timed out'); process.exit(1);
}
main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
