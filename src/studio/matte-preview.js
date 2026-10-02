// src/studio/matte-preview.js
// Composites a matte (alpha .mov/.webm) over a standard background into a
// browser-playable H.264 mp4, cached under .pipeline/studio/previews/. The UI
// shows only these composites, never the raw ProRes/VP9-alpha file.
import { spawn } from 'node:child_process';
import { mkdir, stat, rename, rm, utimes } from 'node:fs/promises';
import path from 'node:path';

// Solid colors as ffmpeg hex; `checker` is generated with geq.
export const PREVIEW_BGS = {
  checker: null, white: '0xFFFFFF', black: '0x000000', gray: '0x808080', green: '0x00B140',
};
const PREVIEW_DIR = path.join('.pipeline', 'studio', 'previews');

export function previewRelPath(srcRel, bg) {
  return path.join(PREVIEW_DIR, `${srcRel}.${bg}.mp4`);
}

// The background is derived from the matte stream itself ([b]), so it always
// matches the matte's size/fps/duration with no ffprobe step.
export function buildPreviewArgs(input, output, bg) {
  if (!Object.hasOwn(PREVIEW_BGS, bg)) throw new Error(`matte preview: unknown bg "${bg}"`);
  const bgChain = bg === 'checker'
    ? "format=gray,geq=lum='if(mod(floor(X/16)+floor(Y/16),2),204,255)',format=yuv420p"
    : `format=yuv420p,drawbox=x=0:y=0:w=iw:h=ih:color=${PREVIEW_BGS[bg]}:t=fill`;
  const graph = `[0:v]format=rgba,split[fg][b];[b]${bgChain}[bg];`
    + '[bg][fg]overlay=format=auto,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[out]';
  // ffmpeg's native VP9 decoder drops alpha; libvpx keeps it.
  const decoder = /\.webm$/i.test(input) ? ['-c:v', 'libvpx-vp9'] : [];
  return ['-y', '-v', 'error', ...decoder, '-i', input, '-filter_complex', graph,
    '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-movflags', '+faststart', output];
}

export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let err = '';
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg not found on PATH' : e.message)));
    child.on('close', (code) => (code === 0 ? resolve()
      : reject(new Error(`ffmpeg exit ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

function mediaUrl(rel) { return '/media/' + rel.split(path.sep).map(encodeURIComponent).join('/'); }
async function mtime(p) { try { return (await stat(p)).mtimeMs; } catch { return null; } }

export function createPreviewer({ root, run = runFfmpeg, concurrency = 2 }) {
  const inflight = new Set();   // preview rel paths queued or rendering
  const failed = new Map();     // preview rel -> { srcM, message }; sticky until the source changes
  const jobs = new Set();       // running job promises (for drain())
  const queue = [];
  let active = 0;

  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active++;
      const p = job().finally(() => { active--; jobs.delete(p); pump(); });
      jobs.add(p);
    }
  }

  // Never waits for a render: returns the current state and queues work if needed.
  async function request(srcRel, bg) {
    if (!Object.hasOwn(PREVIEW_BGS, bg)) throw new Error(`matte preview: unknown bg "${bg}"`);
    const src = path.join(root, srcRel);
    const srcM = await mtime(src);
    if (srcM == null) return { state: 'error', error: 'source not found' };
    const rel = previewRelPath(srcRel, bg);
    const out = path.join(root, rel);
    const outM = await mtime(out);
    // A finished preview is stamped with the source mtime it was rendered from
    // (below), so ANY source mtime change (newer, older via `cp -p`, or a rewrite
    // mid-render) makes it stale. (round(outM): utimes' float seconds can land a
    // hair under the whole ms we stamped.) Comparing against "now" would call a composite
    // of the old matte ready forever.
    if (outM != null && Math.round(outM) === Math.trunc(srcM)) return { state: 'ready', url: mediaUrl(rel) };
    if (inflight.has(rel)) return { state: 'pending' };
    const f = failed.get(rel);
    if (f && f.srcM === srcM) return { state: 'error', error: f.message };
    failed.delete(rel);
    inflight.add(rel);
    queue.push(async () => {
      const tmp = `${out}.tmp.mp4`;
      try {
        await mkdir(path.dirname(out), { recursive: true });
        await run(buildPreviewArgs(src, tmp, bg));
        await rename(tmp, out);
        await utimes(out, new Date(), new Date(Math.trunc(srcM)));
      } catch (err) {
        failed.set(rel, { srcM, message: err.message });
        await rm(tmp, { force: true });
      } finally {
        inflight.delete(rel);
      }
    });
    pump();
    return { state: 'pending' };
  }

  // Test helper: resolves once the queue is empty and nothing is running.
  async function drain() {
    while (jobs.size || queue.length) await Promise.all([...jobs]);
  }

  return { request, drain };
}
