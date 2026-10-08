// src/edit-ui/generator.js
// Generation backend for the edit UI. A generator is `{ name, run(job) }` where
// run({ root, videoPath, outDir, jobId, request }) resolves to
// `{ output: <workspace-relative path>, stub?: boolean, note?: string }`.
// `root` is the edit-ui workspace; `outDir` is this video's dir inside it.
//
// `request` is what the UI sends:
//   keyframe: { kind, id, time, frame, fps, mark, prompts[], annotations[] }
//   video:    { kind, id, fps, marks[], prompts[], annotations[], keyframes[] }
// marks are { id, kind: 'frame'|'range', start, end } in frames; prompts carry
// `markId` (null = whole video); annotations carry `markId`, `frame` and
// normalized [0..1] stroke points; keyframes are { frame, time, image, markId }.
//
// The stub records every request as JSON and returns a placeholder (the source
// frame for a keyframe, the source clip for a video) so the UI loop is usable
// before a real pipeline route is wired in.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
  });
}

// { fps, duration, width, height, frames, hasAudio } — fps falls back to 24 if unknown.
export async function probeVideo(abs) {
  try {
    const out = await run('ffprobe', ['-v', 'error',
      '-show_entries', 'stream=codec_type,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', abs]);
    const j = JSON.parse(out);
    const streams = j.streams || [];
    const s = streams.find((x) => x.codec_type === 'video') || {};
    const [n, d] = String(s.r_frame_rate || '24/1').split('/').map(Number);
    const fps = n && d ? n / d : 24;
    const duration = Number(j.format && j.format.duration) || null;
    const frames = Number(s.nb_frames) || (duration ? Math.round(duration * fps) : null);
    const hasAudio = streams.some((x) => x.codec_type === 'audio');
    return { fps, duration, width: s.width || null, height: s.height || null, frames, hasAudio };
  } catch (err) {
    return { fps: 24, duration: null, width: null, height: null, frames: null, hasAudio: false, error: err.message };
  }
}

// Peak envelope of the first audio track: `buckets` values in [0, 1], or null
// if there is no audio. Decodes mono 8 kHz s16le through ffmpeg.
export function audioPeaks(abs, buckets = 2000) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', abs, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return /matches no streams|does not contain any stream/i.test(err) ? resolve(null) : reject(new Error(err.slice(-400)));
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 2);
      if (!n) return resolve(null);
      const count = Math.min(buckets, n);
      const peaks = new Array(count).fill(0);
      for (let i = 0; i < n; i++) {
        const b = Math.min(count - 1, Math.floor((i / n) * count));
        const v = Math.abs(buf.readInt16LE(i * 2)) / 32768;
        if (v > peaks[b]) peaks[b] = v;
      }
      const max = Math.max(...peaks) || 1;
      resolve(peaks.map((v) => +(v / max).toFixed(3)));
    });
  });
}

export function createStubGenerator() {
  return {
    name: 'stub',
    async run({ root, videoPath, outDir, jobId, request }) {
      const jobsDir = path.join(outDir, 'jobs');
      await mkdir(jobsDir, { recursive: true });
      await writeFile(path.join(jobsDir, `${jobId}.json`), JSON.stringify(request, null, 2));
      const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');
      if (request.kind === 'keyframe') {
        const kfDir = path.join(outDir, 'keyframes');
        await mkdir(kfDir, { recursive: true });
        const out = path.join(kfDir, `${jobId}.png`);
        await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(request.time), '-i', videoPath, '-frames:v', '1', out]);
        return { output: rel(out), stub: true, note: 'stub generator: source frame placeholder' };
      }
      return { output: rel(videoPath), stub: true, note: 'stub generator: source clip placeholder' };
    },
  };
}
