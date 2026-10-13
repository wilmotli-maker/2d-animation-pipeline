// src/edit-ui/splice-run.js
// Map a run's phase-1 edit windows onto spliceClip: de-pad each window's generated clip, pick the
// seam from the pad, and splice right-to-left into the source so each splice leaves the frames that
// windows further left depend on untouched. Produces one full-length runs/vNNN/spliced.mp4.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { updateRun } from './workspace.js';

function defaultFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}: ${err.slice(-300)}`))));
  });
}
const t3 = (n) => Number(n).toFixed(3);

export function createSpliceRunner(deps = {}) {
  return async function spliceRun(workspace, meta, manifest) {
    const ffmpeg = deps.ffmpeg || defaultFfmpeg;
    const ffprobe = deps.ffprobe;
    const splice = deps.splice || (async (o) => { const { spliceClip } = await import('./splice.js'); return spliceClip(o, { ffmpeg, ffprobe }); });
    const fps = (manifest.source && manifest.source.fps) || 24;
    const duration = (manifest.source && manifest.source.duration) || 0;
    const runDir = path.join(workspace, meta.id, 'runs', manifest.run);
    const abs = (rel) => path.resolve(workspace, rel);
    const source = path.join(workspace, meta.id, meta.file);

    const usable = (manifest.windows || []).filter((w) => w.status === 'done' && w.output);
    if (!usable.length) throw new Error('no usable edit window to splice');
    const sorted = [...usable].sort((a, b) => b.sourceSpan[0] - a.sourceSpan[0]); // right-to-left

    let working = source;
    const outWindows = [];
    for (const w of sorted) {
      const wDir = path.join(runDir, 'windows', w.name);
      // de-pad: trim [pad.start, clipDuration - pad.end] at the source fps so frame counts line up.
      const depadded = path.join(wDir, 'splice-src.mp4');
      const dur = w.clipDuration - w.pad.start - w.pad.end;
      await ffmpeg(['-ss', t3(w.pad.start), '-t', t3(dur), '-i', abs(w.output), '-r', String(fps), '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-y', depadded]);

      const wholeClip = (w.pad.start > 0 && w.pad.end > 0) || (w.sourceSpan[0] <= 0 && w.sourceSpan[1] >= duration);
      const target = sorted.length === 1 ? path.join(runDir, 'spliced.mp4') : path.join(wDir, 'spliced-step.mp4');
      if (wholeClip) {
        await ffmpeg(['-i', depadded, '-c', 'copy', '-y', target]);
        outWindows.push({ name: w.name, seam: 'whole', report: null });
        working = target;
        continue;
      }
      const seam = w.pad.start > 0 ? 'head' : w.pad.end > 0 ? 'tail' : 'mid';
      const edit = (w.editCenters && w.editCenters.length) ? w.editCenters[0] : (w.sourceSpan[0] + w.sourceSpan[1]) / 2;
      const report = await splice({ orig: working, gen: depadded, out: target, edit, seam, fps, align: 'trs' });
      outWindows.push({ name: w.name, seam, report });
      working = target;
    }

    const finalOut = path.join(runDir, 'spliced.mp4');
    if (working !== finalOut) await ffmpeg(['-i', working, '-c', 'copy', '-y', finalOut]);
    const rel = path.relative(workspace, finalOut).split(path.sep).join('/');
    await updateRun(runDir, { spliced: { output: rel, windows: outWindows, at: new Date().toISOString() } });
    return { output: rel, windows: outWindows };
  };
}
