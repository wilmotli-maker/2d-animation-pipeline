// src/edit-ui/generator.js
// Generation backend for the edit UI. A generator is `{ name, run(job) }` where
// run({ root, videoPath, outDir, jobId, request }) resolves to
// `{ output: <project-relative path>, stub?: boolean, note?: string }`.
//
// `request` is what the UI sends:
//   keyframe: { kind, video, time, frame, prompts[], annotations[], marks[] }
//   video:    { kind, video, prompts[], annotations[], marks[], keyframes[] }
// prompts carry their linked annotation/mark ids; annotations carry normalized
// [0..1] stroke points; marks are { kind: 'frame'|'range', start, end } seconds.
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

// { fps, duration, width, height, frames } — fps falls back to 24 if unknown.
export async function probeVideo(abs) {
  try {
    const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', abs]);
    const j = JSON.parse(out);
    const s = (j.streams && j.streams[0]) || {};
    const [n, d] = String(s.r_frame_rate || '24/1').split('/').map(Number);
    const fps = n && d ? n / d : 24;
    const duration = Number(j.format && j.format.duration) || null;
    const frames = Number(s.nb_frames) || (duration ? Math.round(duration * fps) : null);
    return { fps, duration, width: s.width || null, height: s.height || null, frames };
  } catch (err) {
    return { fps: 24, duration: null, width: null, height: null, frames: null, error: err.message };
  }
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
