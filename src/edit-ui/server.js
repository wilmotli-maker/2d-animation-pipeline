// src/edit-ui/server.js
// Local-only server for the targeted-edit UI (`pipeline edit-ui`). Standalone —
// not tied to a project: the user opens a video (upload from the page, or a path
// on the command line), which is imported into a workspace dir keyed by content
// hash, so reopening the same file resumes its session. Per video:
//   <workspace>/<id>/source.<ext>   meta.json   session.json   waveform.json
//   <workspace>/<id>/keyframes/…    jobs/…      (generator outputs)
// Generation goes through a pluggable `generator` (see generator.js).
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { resolveWithin, sendFile } from '../studio/media.js';
import { realWithin } from '../studio/contain.js';
import { createStubGenerator, probeVideo, audioPeaks } from './generator.js';
import { videoDirs, writeJsonAtomic, ensureTranscript, createRun, updateRun, listRuns } from './workspace.js';
import { spawn } from 'node:child_process';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_JSON = 1024 * 1024; // sessions carry stroke point lists
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ID_RE = /^[0-9a-f]{16}$/;

export const DEFAULT_WORKSPACE = path.join(os.homedir(), '.pipeline', 'edit-ui');

function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return null; } }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= MAX_JSON) chunks.push(c); });
    req.on('end', () => (size > MAX_JSON
      ? reject(Object.assign(new Error('body too large'), { status: 413 }))
      : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

async function readJsonBody(req, res) {
  // application/json forces a CORS preflight that this server never answers.
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
    sendJson(res, 415, { error: 'expected application/json' });
    return undefined;
  }
  try { return JSON.parse(await readBody(req)); } catch (err) {
    sendJson(res, err.status || 400, { error: err.message }, err.status === 413 ? { Connection: 'close' } : {});
    return undefined;
  }
}

// Binary uploads: octet-stream + a custom X-Filename header (both force a preflight).
function uploadName(req) {
  if (!/^application\/octet-stream\b/.test(req.headers['content-type'] || '')) return null;
  const name = safeDecode(req.headers['x-filename'] || '');
  return name ? path.basename(name) : null;
}

// Stream `src` into the workspace, hashing as it goes. The id is the content
// hash, so the same file always maps to the same workspace dir (and session).
export async function importVideo(workspace, src, name) {
  const ext = path.extname(name).toLowerCase();
  if (!VIDEO_EXT.has(ext)) throw Object.assign(new Error(`unsupported video type "${ext}"`), { status: 400 });
  await mkdir(workspace, { recursive: true });
  const tmp = path.join(workspace, `.import-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const hash = crypto.createHash('sha256');
  src.on('data', (c) => hash.update(c));
  try { await pipeline(src, createWriteStream(tmp)); } catch (err) { await rm(tmp, { force: true }); throw err; }
  const id = hash.digest('hex').slice(0, 16);
  const dir = path.join(workspace, id);
  const file = `source${ext}`;
  await mkdir(dir, { recursive: true });
  try { await stat(path.join(dir, file)); await rm(tmp, { force: true }); } catch { await rename(tmp, path.join(dir, file)); }
  const meta = { id, name, file, openedAt: new Date().toISOString() };
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

export function importVideoFile(workspace, abs) {
  return importVideo(workspace, createReadStream(abs), path.basename(abs));
}

async function readMeta(workspace, id) {
  if (!ID_RE.test(id || '')) return null;
  try { return JSON.parse(await readFile(path.join(workspace, id, 'meta.json'), 'utf8')); } catch { return null; }
}

export async function listRecent(workspace, limit = 20) {
  let ids = [];
  try { ids = (await readdir(workspace)).filter((d) => ID_RE.test(d)); } catch { return []; }
  const metas = (await Promise.all(ids.map((id) => readMeta(workspace, id)))).filter(Boolean);
  return metas.sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, limit);
}

// Whole-video generate: gather derived inputs (transcription failing is a
// warning, not an error), freeze everything into runs/vNNN, run the generator
// there, and record the outcome in the manifest.
async function runVideoJob(ctx, meta, videoPath, jobId, request, job) {
  const { workspace, generator } = ctx;
  const probe = await probeVideo(videoPath);
  const warnings = []; const derived = {};
  if (probe.hasAudio) {
    try {
      derived.transcript = await ensureTranscript(workspace, meta, { hasAudio: true, ...ctx.derivers });
      derived.audio = path.join(videoDirs(workspace, meta.id).derived, 'audio.wav');
    } catch (err) { warnings.push(`transcription unavailable: ${err.message}`); }
  }
  const { error: _e, ...probeMeta } = probe;
  const run = await createRun(workspace, meta, { request, probe: probeMeta, generator: generator.name, derived, warnings });
  job.run = run.name;
  try {
    const result = await generator.run({
      root: workspace, videoPath, outDir: path.join(workspace, meta.id), runDir: run.dir, run: run.manifest, jobId, request,
    });
    await updateRun(run.dir, { status: 'done', finishedAt: new Date().toISOString(), output: result.output || null, stub: !!result.stub, note: result.note || null });
    return { ...result, run: run.name };
  } catch (err) {
    await updateRun(run.dir, { status: 'error', finishedAt: new Date().toISOString(), error: err.message });
    throw err;
  }
}

function defaultReveal(target) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['explorer', [target]] : ['xdg-open', [target]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function handle(ctx, req, res) {
  const { workspace, generator } = ctx;
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return sendJson(res, 403, { error: 'forbidden host' });
  const pathOnly = (req.url || '').split('?')[0];
  const topLevelNav = (req.method === 'GET' || req.method === 'HEAD') && pathOnly === '/'
    && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
  const site = req.headers['sec-fetch-site'];
  if (!topLevelNav && site && site !== 'same-origin' && site !== 'none') {
    return sendJson(res, 403, { error: 'cross-site request' });
  }
  if (!topLevelNav && req.headers.origin) {
    let originHost = null;
    try { originHost = new URL(req.headers.origin).host; } catch { /* malformed -> reject */ }
    if (originHost !== req.headers.host) return sendJson(res, 403, { error: 'cross-origin request' });
  }

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const get = req.method === 'GET' || req.method === 'HEAD';

  if (get && p === '/') return sendFile(req, res, path.join(WEB, 'index.html'));
  if (get && p.startsWith('/static/')) {
    const abs = resolveWithin(WEB, safeDecode(p.slice('/static/'.length)));
    return abs ? sendFile(req, res, abs) : sendJson(res, 404, { error: 'not found' });
  }
  // Workspace files: /files/<id>/<path>
  if (get && p.startsWith('/files/')) {
    const rel = safeDecode(p.slice('/files/'.length));
    const abs = rel && ID_RE.test(rel.split('/')[0]) ? resolveWithin(workspace, rel) : null;
    const real = abs && await realWithin(workspace, abs);
    return real ? sendFile(req, res, real, { noFollow: true }) : sendJson(res, 404, { error: 'not found' });
  }

  if (get && p === '/api/recent') return sendJson(res, 200, { recent: await listRecent(workspace), initial: ctx.initialId || null });

  if (req.method === 'POST' && p === '/api/open') {
    const name = uploadName(req);
    if (!name) return sendJson(res, 400, { error: 'expected application/octet-stream with X-Filename' });
    try { return sendJson(res, 200, await importVideo(workspace, req, name)); } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  // Everything below is per-video.
  const id = url.searchParams.get('id');
  const meta = p.startsWith('/api/') && p !== '/api/jobs' && !p.startsWith('/api/jobs/') ? await readMeta(workspace, id) : null;
  const dir = meta && path.join(workspace, meta.id);
  const source = meta && path.join(dir, meta.file);

  if (get && p === '/api/video') {
    if (!meta) return sendJson(res, 404, { error: 'unknown video' });
    return sendJson(res, 200, { ...meta, src: `/files/${meta.id}/${meta.file}`, ...(await probeVideo(source)) });
  }

  if (get && p === '/api/waveform') {
    if (!meta) return sendJson(res, 404, { error: 'unknown video' });
    const { derived } = videoDirs(workspace, meta.id);
    const cache = path.join(derived, 'waveform.json');
    try { return sendJson(res, 200, JSON.parse(await readFile(cache, 'utf8'))); } catch { /* compute */ }
    const out = { peaks: await audioPeaks(source).catch(() => null) };
    await mkdir(derived, { recursive: true });
    await writeFile(cache, JSON.stringify(out));
    return sendJson(res, 200, out);
  }

  // Full-clip transcript (derived/transcript.json), computed on first request.
  if (get && p === '/api/transcript') {
    if (!meta) return sendJson(res, 404, { error: 'unknown video' });
    const { hasAudio } = await probeVideo(source);
    try {
      return sendJson(res, 200, { transcript: await ensureTranscript(workspace, meta, { hasAudio, ...ctx.derivers }) });
    } catch (err) { return sendJson(res, 502, { error: err.message }); }
  }

  if (get && p === '/api/runs') {
    if (!meta) return sendJson(res, 404, { error: 'unknown video' });
    return sendJson(res, 200, { runs: await listRuns(workspace, meta.id) });
  }

  // Show a run's folder (or the video's workspace folder) in Finder.
  if (req.method === 'POST' && p === '/api/reveal') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const m = await readMeta(workspace, body && body.id);
    if (!m) return sendJson(res, 404, { error: 'unknown video' });
    const base = videoDirs(workspace, m.id);
    const target = body.run ? resolveWithin(base.runs, String(body.run)) : base.dir;
    if (!target || !(await realWithin(base.dir, target))) return sendJson(res, 404, { error: 'unknown run' });
    ctx.reveal(target);
    return sendJson(res, 200, { ok: true, path: target });
  }

  if (p === '/api/session') {
    if (!meta) return sendJson(res, 404, { error: 'unknown video' });
    const file = path.join(dir, 'session.json');
    if (get) {
      try { return sendJson(res, 200, JSON.parse(await readFile(file, 'utf8'))); } catch (err) {
        if (err.code === 'ENOENT') return sendJson(res, 200, { version: 2 });
        return sendJson(res, 500, { error: err.message });
      }
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'expected object' });
      await writeJsonAtomic(file, { ...body, savedAt: new Date().toISOString() });
      return sendJson(res, 200, { ok: true });
    }
  }

  // Upload a predefined keyframe image: octet-stream body, X-Filename header.
  if (req.method === 'POST' && p === '/api/keyframe-upload') {
    if (!meta) return sendJson(res, 404, { error: 'unknown video' });
    const name = uploadName(req);
    const ext = name && path.extname(name).toLowerCase();
    if (!name || !IMAGE_EXT.has(ext)) return sendJson(res, 400, { error: 'expected a png/jpg/webp upload' });
    const kfDir = path.join(dir, 'keyframes');
    await mkdir(kfDir, { recursive: true });
    const file = `upload-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}${ext}`;
    await pipeline(req, createWriteStream(path.join(kfDir, file)));
    return sendJson(res, 200, { output: `${meta.id}/keyframes/${file}` });
  }

  // Generation: POST {kind: 'keyframe'|'video', id, ...request} -> {jobId}.
  if (req.method === 'POST' && p === '/api/generate') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const m = await readMeta(workspace, body && body.id);
    if (!m) return sendJson(res, 404, { error: 'unknown video' });
    if (body.kind !== 'keyframe' && body.kind !== 'video') return sendJson(res, 400, { error: 'kind must be keyframe or video' });
    if (body.kind === 'keyframe' && !(Number.isFinite(body.time) && body.time >= 0)) {
      return sendJson(res, 400, { error: 'keyframe needs a time' });
    }
    const jobId = `${body.kind}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    const job = { id: jobId, kind: body.kind, status: 'running', createdAt: new Date().toISOString() };
    ctx.jobs.set(jobId, job);
    const videoPath = path.join(workspace, m.id, m.file);
    const work = body.kind === 'video'
      ? runVideoJob(ctx, m, videoPath, jobId, body, job)
      : generator.run({ root: workspace, videoPath, outDir: path.join(workspace, m.id), jobId, request: body });
    work.then((result) => Object.assign(job, { status: 'done', ...result }))
      .catch((err) => Object.assign(job, { status: 'error', error: err.message }));
    return sendJson(res, 202, { jobId });
  }

  if (get && p.startsWith('/api/jobs/')) {
    const job = ctx.jobs.get(p.slice('/api/jobs/'.length));
    return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'unknown job' });
  }

  return sendJson(res, 404, { error: 'not found' });
}

// `derivers`: optional { transcriber, extractAudio } overrides (tests).
// `reveal(path)`: opens a folder in the OS file browser.
export function createEditServer({ workspace = DEFAULT_WORKSPACE, generator = createStubGenerator(), initialId = null,
  derivers = {}, reveal = defaultReveal }) {
  const ctx = { workspace, generator, initialId, derivers, reveal, jobs: new Map() };
  return http.createServer((req, res) => {
    handle(ctx, req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.destroy(err);
    });
  });
}

// `video`: optional path to open at startup (imported into the workspace).
export async function startEditUi({ workspace = DEFAULT_WORKSPACE, port = 4880, host = '127.0.0.1', generator, video, derivers, reveal }) {
  const initialId = video ? (await importVideoFile(workspace, path.resolve(video))).id : null;
  const server = createEditServer({ workspace, generator, initialId, derivers, reveal });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ server, url: `http://${host}:${server.address().port}/`, initialId });
    });
  });
}
