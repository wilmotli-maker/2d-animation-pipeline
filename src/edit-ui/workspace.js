// src/edit-ui/workspace.js
// On-disk layout for one opened video in the edit-ui workspace:
//
//   <workspace>/<id>/
//     source.<ext>  meta.json  session.json
//     keyframes/                 working keyframes (generated/uploaded while editing)
//     derived/                   depends only on the source; computed once, reused
//       waveform.json  audio.wav  transcript.json
//     runs/vNNN/                 one per whole-video generate; never overwritten
//       manifest.json            what went in, settings, status, output
//       prompt.txt
//       keyframes/edited/fNNNN.<ext>
//       (later: speechref.mp4, keyframes/auto/, annotations/, output.mp4)
//
// The manifest is the record of a run: every input file with its role, the
// generator and settings, timestamps, status and output — enough to inspect or
// re-run it without the session.
import path from 'node:path';
import { readdir, readFile, writeFile, mkdir, rename, copyFile, stat } from 'node:fs/promises';
import { extractAudio as defaultExtractAudio } from '../speechclip.js';
import { getTranscriber } from '../transcribe.js';

export const MANIFEST_VERSION = 1;
const RUN_RE = /^v(\d{3,})$/;

export function videoDirs(workspace, id) {
  const dir = path.join(workspace, id);
  return { dir, derived: path.join(dir, 'derived'), runs: path.join(dir, 'runs'), keyframes: path.join(dir, 'keyframes') };
}

const rel = (workspace, abs) => path.relative(workspace, abs).split(path.sep).join('/');
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export async function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, file);
}

// ---- derived ---------------------------------------------------------------

// derived/audio.wav (16 kHz mono). Returns its path, or null when the source has
// no audio. Cached: an existing file is reused.
export async function ensureAudio(workspace, meta, { hasAudio, extractAudio = defaultExtractAudio } = {}) {
  if (!hasAudio) return null;
  const { dir, derived } = videoDirs(workspace, meta.id);
  const out = path.join(derived, 'audio.wav');
  if (!(await exists(out))) {
    await mkdir(derived, { recursive: true });
    const tmp = path.join(derived, `.audio.${process.pid}.wav`);
    await extractAudio(path.join(dir, meta.file), tmp);
    await rename(tmp, out);
  }
  return out;
}

// derived/transcript.json via the pipeline transcriber (local whisper.cpp).
// Returns { text, engine, createdAt } or null when there is no audio. Cached.
export async function ensureTranscript(workspace, meta, { hasAudio, transcriber, extractAudio, engine = 'whisper' } = {}) {
  const { derived } = videoDirs(workspace, meta.id);
  const file = path.join(derived, 'transcript.json');
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { /* compute */ }
  const audio = await ensureAudio(workspace, meta, { hasAudio, extractAudio });
  if (!audio) return null;
  const { text } = await (transcriber || getTranscriber(engine)).transcribe(audio);
  const out = { text, engine, audio: 'audio.wav', createdAt: new Date().toISOString() };
  await writeJsonAtomic(file, out);
  return out;
}

// ---- runs ------------------------------------------------------------------

export async function listRuns(workspace, id) {
  const { runs } = videoDirs(workspace, id);
  let names = [];
  try { names = (await readdir(runs)).filter((n) => RUN_RE.test(n)).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(JSON.parse(await readFile(path.join(runs, n, 'manifest.json'), 'utf8'))); } catch { /* partial run dir */ }
  }
  return out;
}

// Reserve the next vNNN dir. mkdir without `recursive` fails on EEXIST, so two
// concurrent creates can't claim the same number.
async function reserveRunDir(runsDir) {
  await mkdir(runsDir, { recursive: true });
  const used = (await readdir(runsDir)).map((n) => RUN_RE.exec(n)).filter(Boolean).map((m) => Number(m[1]));
  for (let n = (used.length ? Math.max(...used) : 0) + 1; ; n++) {
    const name = `v${String(n).padStart(3, '0')}`;
    try { await mkdir(path.join(runsDir, name)); return name; } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
}

// The prompt text for a run: whole-video prompts first, then each mark's
// prompts under a frame/time header, in timeline order.
export function composePrompt({ marks = [], prompts = [], fps = 24 }) {
  const live = prompts.filter((p) => p && String(p.text || '').trim());
  const blocks = live.filter((p) => !p.markId).map((p) => p.text.trim());
  const t = (f) => (f / fps).toFixed(2);
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    const mine = live.filter((p) => p.markId === m.id).map((p) => p.text.trim());
    if (!mine.length) continue;
    const where = m.start === m.end ? `frame ${m.start} (${t(m.start)}s)` : `frames ${m.start}–${m.end} (${t(m.start)}s–${t(m.end + 1)}s)`;
    blocks.push(`[${m.label ? `${m.label}, ` : ''}${where}]\n${mine.join('\n')}`);
  }
  return blocks.join('\n\n');
}

// Create runs/vNNN with prompt.txt, copies of the chosen edited keyframes, and
// a pending manifest. `request` is the UI's video-generate body; `derived` is
// { audio, transcript } (either may be null); `warnings` are carried into the
// manifest (e.g. transcription unavailable).
export async function createRun(workspace, meta, { request, probe = {}, generator = 'stub', derived = {}, warnings = [] }) {
  const { dir, runs } = videoDirs(workspace, meta.id);
  const name = await reserveRunDir(runs);
  const runDir = path.join(runs, name);
  const fps = request.fps || probe.fps || 24;
  const inputs = [{ role: 'source', path: rel(workspace, path.join(dir, meta.file)) }];
  if (derived.audio) inputs.push({ role: 'audio', path: rel(workspace, derived.audio) });

  const promptText = composePrompt({ marks: request.marks, prompts: request.prompts, fps });
  await writeFile(path.join(runDir, 'prompt.txt'), promptText ? `${promptText}\n` : '');
  inputs.push({ role: 'prompt', path: rel(workspace, path.join(runDir, 'prompt.txt')) });

  // Freeze the edited keyframes: the working copies in keyframes/ keep changing.
  const keyframes = [];
  for (const k of request.keyframes || []) {
    const src = k && typeof k.image === 'string' ? path.join(workspace, k.image) : null;
    if (!src || rel(workspace, src).startsWith('..') || !(await exists(src))) continue;
    const out = path.join(runDir, 'keyframes', 'edited', `f${String(k.frame).padStart(4, '0')}${path.extname(src)}`);
    await mkdir(path.dirname(out), { recursive: true });
    await copyFile(src, out);
    const entry = { role: 'keyframe', kind: 'edited', frame: k.frame, time: k.time, markId: k.markId || null, path: rel(workspace, out), from: k.image };
    inputs.push(entry);
    keyframes.push(entry);
  }

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    run: name,
    kind: 'video',
    status: 'pending',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    source: { id: meta.id, name: meta.name, file: meta.file, ...probe },
    generator: { name: generator },
    settings: { fps },
    prompt: { file: 'prompt.txt', text: promptText },
    transcript: derived.transcript ? { text: derived.transcript.text, engine: derived.transcript.engine } : null,
    marks: request.marks || [],
    prompts: request.prompts || [],
    annotations: (request.annotations || []).map((a) => ({ id: a.id, markId: a.markId, frame: a.frame, strokes: a.strokes })),
    keyframes,
    inputs,
    output: null,
    error: null,
    warnings,
  };
  await writeJsonAtomic(path.join(runDir, 'manifest.json'), manifest);
  return { name, dir: runDir, manifest };
}

export async function updateRun(runDir, patch) {
  const file = path.join(runDir, 'manifest.json');
  const m = JSON.parse(await readFile(file, 'utf8'));
  Object.assign(m, patch);
  await writeJsonAtomic(file, m);
  return m;
}
