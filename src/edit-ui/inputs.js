// src/edit-ui/inputs.js
// Per-run generator inputs, written into runs/vNNN/ after createRun():
//   speechref.mp4              blank mid-gray video carrying the clip's speech (speechclip.js)
//   keyframes/auto/fNNNN.png   evenly sampled source frames
//   annotations/fNNNN.png      source frame with the scribbles drawn on it
//   annotations/fNNNN-strokes.png   the scribbles alone, transparent
// Each piece is best-effort: a failure becomes a manifest warning so one missing
// input doesn't throw away the run. All media tools are injectable for tests.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { makeBlankSpeechVideo } from '../speechclip.js';
import { updateRun } from './workspace.js';

export const MAX_AUTO_KEYFRAMES = 12;
const ASPECTS = ['3:4', '16:9', '9:16', '1:1', '4:3']; // what makeBlankSpeechVideo supports
const pad = (f) => String(f).padStart(4, '0');

// n frame indices spread evenly over [0, total-1], first and last included.
export function sampleFrameIndices(total, n) {
  if (!(total > 0) || !(n > 0)) return [];
  const count = Math.min(Math.floor(n), total);
  if (count === 1) return [0];
  return [...new Set(Array.from({ length: count }, (_, i) => Math.round((i * (total - 1)) / (count - 1))))];
}

// The supported speech-ref aspect closest to the source's shape.
export function nearestAspect(width, height) {
  if (!width || !height) return '16:9';
  const target = Math.log(width / height);
  const dist = (a) => { const [w, h] = a.split(':').map(Number); return Math.abs(Math.log(w / h) - target); };
  return ASPECTS.reduce((best, a) => (dist(a) < dist(best) ? a : best));
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))));
  });
}

export async function extractFrame(videoPath, time, outPath) {
  await mkdir(path.dirname(outPath), { recursive: true });
  await runFfmpeg(['-ss', String(time), '-i', videoPath, '-frames:v', '1', outPath]);
  return outPath;
}

const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c)) ? c : '#ff4d6d');

// Strokes use the UI's normalized [0..1] points and a pen width measured against
// a 1000px-wide canvas; scale both to the real frame.
export function strokesSvg(strokes, width, height) {
  const paths = strokes.map((s) => {
    const pts = (s.pts || []).map(([x, y]) => [x * width, y * height]);
    if (!pts.length) return '';
    if (pts.length === 1) pts.push([pts[0][0] + 0.1, pts[0][1]]);
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${safeColor(s.color)}" stroke-width="${((Number(s.width) || 5) * (width / 1000)).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${paths}</svg>`;
}

export async function renderAnnotationImages(framePng, strokes, outBase) {
  const { width, height } = await sharp(framePng).metadata();
  const svg = Buffer.from(strokesSvg(strokes, width, height));
  const withFrame = `${outBase}.png`; const only = `${outBase}-strokes.png`;
  await sharp(framePng).composite([{ input: svg }]).png().toFile(withFrame);
  await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: svg }]).png().toFile(only);
  return { withFrame, only };
}

// Build the run's extra inputs and fold them into its manifest.
//   request: the UI body ({ annotations, keyframes, autoKeyframes, fps })
//   derived: { audio } from the workspace (path to 16 kHz wav, or undefined)
export async function prepareRunInputs(workspace, run, { videoPath, probe = {}, request, derived = {}, tools = {} }) {
  const { speechRef = makeBlankSpeechVideo, frame = extractFrame, annotate = renderAnnotationImages } = tools;
  const fps = request.fps || probe.fps || 24;
  const total = probe.frames || (probe.duration ? Math.round(probe.duration * fps) : 0);
  const rel = (abs) => path.relative(workspace, abs).split(path.sep).join('/');
  const inputs = []; const warnings = []; const autoKeyframes = []; const annotationImages = [];
  const manifest = {};

  // Speech reference: the whole clip's audio today. `window` is recorded so a
  // generator that edits only part of the clip can narrow it later.
  if (derived.audio) {
    manifest.window = { start: 0, end: probe.duration ?? (total ? total / fps : null) };
    const out = path.join(run.dir, 'speechref.mp4');
    try {
      await speechRef(derived.audio, out, { aspect: nearestAspect(probe.width, probe.height), fps: Math.round(fps) || 24 });
      inputs.push({ role: 'speechref', path: rel(out), window: manifest.window });
    } catch (err) { warnings.push(`speech reference unavailable: ${err.message}`); }
  }

  // Auto keyframes, skipping frames that already have an edited keyframe.
  const wanted = Math.max(0, Math.min(MAX_AUTO_KEYFRAMES, Math.floor(Number(request.autoKeyframes) || 0)));
  const edited = new Set((request.keyframes || []).map((k) => k.frame));
  for (const f of sampleFrameIndices(total, wanted)) {
    if (edited.has(f)) continue;
    const out = path.join(run.dir, 'keyframes', 'auto', `f${pad(f)}.png`);
    try {
      await frame(videoPath, (f + 0.5) / fps, out);
      const entry = { role: 'keyframe', kind: 'auto', frame: f, time: (f + 0.5) / fps, path: rel(out) };
      inputs.push(entry); autoKeyframes.push(entry);
    } catch (err) { warnings.push(`auto keyframe f${f} failed: ${err.message}`); }
  }

  // Edited keyframes: user-provided reference images (generated or uploaded in the UI), pinned at
  // their frame. The generator places each as an extra reference at its time within the window (see
  // trim-generator + trim-prompt), so the subject reaches that pose at the right moment in the clip.
  for (const k of (request.keyframes || [])) {
    if (!k || typeof k.image !== 'string' || !k.image || k.image.includes('..') || !Number.isInteger(k.frame)) continue;
    inputs.push({ role: 'keyframe', kind: 'edited', frame: k.frame, time: (typeof k.time === 'number' ? k.time : (k.frame + 0.5) / fps), path: k.image });
  }

  // Annotated frames: one image pair per frame, all scribbles on that frame together.
  const byFrame = new Map();
  for (const a of request.annotations || []) {
    if (!Array.isArray(a.strokes) || !a.strokes.length || !Number.isInteger(a.frame)) continue;
    byFrame.set(a.frame, [...(byFrame.get(a.frame) || []), ...a.strokes]);
  }
  for (const [f, strokes] of [...byFrame].sort((a, b) => a[0] - b[0])) {
    const base = path.join(run.dir, 'annotations', `f${pad(f)}`);
    try {
      const src = `${base}.src.png`;
      await frame(videoPath, (f + 0.5) / fps, src);
      const { withFrame, only } = await annotate(src, strokes, base);
      await rm(src, { force: true });
      for (const [kind, file] of [['frame', withFrame], ['strokes', only]]) {
        const entry = { role: 'annotation', kind, frame: f, path: rel(file) };
        inputs.push(entry); annotationImages.push(entry);
      }
    } catch (err) { warnings.push(`annotation image f${f} failed: ${err.message}`); }
  }

  const current = JSON.parse(await readFile(path.join(run.dir, 'manifest.json'), 'utf8'));
  return updateRun(run.dir, {
    ...manifest, autoKeyframes, annotationImages,
    inputs: [...current.inputs, ...inputs],
    warnings: [...current.warnings, ...warnings],
  });
}
