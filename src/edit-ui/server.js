// src/edit-ui/server.js
// Local-only server for the targeted-edit UI (`pipeline edit-ui`). Separate from
// the studio: one video at a time, spatial/temporal annotations, prompts, and
// keyframe / whole-video generation requests. Generation goes through a pluggable
// `generator` (see generator.js); the default is a stub until the pipeline side
// is decided. Same local-only + same-origin guards as the studio server.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolveWithin, sendFile } from '../studio/media.js';
import { realWithin } from '../studio/contain.js';
import { createStubGenerator, probeVideo } from './generator.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_BODY = 1024 * 1024; // sessions carry stroke point lists
const VIDEO_RE = /\.(mp4|m4v|mov|webm)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__']);
export const SESSION_DIR = path.join('.pipeline', 'edit-sessions');

function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return null; } }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => (size > MAX_BODY
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

// Session files are keyed by the video's project-relative path, flattened.
export function sessionKey(rel) {
  return rel.split(/[\\/]/).join('__').replace(/[^\w.-]/g, '_');
}

// Video files under the project, skipping dot-dirs (incl. .pipeline) and deps.
export async function listVideos(root, { maxDepth = 8, limit = 1000 } = {}) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > maxDepth || out.length >= limit) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs, depth + 1);
      else if (e.isFile() && VIDEO_RE.test(e.name)) out.push(path.relative(root, abs).split(path.sep).join('/'));
      if (out.length >= limit) return;
    }
  }
  await walk(root, 0);
  return out;
}

// Resolve a client-supplied video path to its real path inside the project, or null.
async function resolveVideo(root, rel) {
  if (!rel || !VIDEO_RE.test(rel)) return null;
  const abs = resolveWithin(root, rel);
  return abs && realWithin(root, abs);
}

async function handle(ctx, req, res) {
  const { root, generator } = ctx;
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
  if (get && p.startsWith('/media/')) {
    const abs = resolveWithin(root, safeDecode(p.slice('/media/'.length)));
    const real = abs && await realWithin(root, abs);
    return real ? sendFile(req, res, real, { noFollow: true }) : sendJson(res, 404, { error: 'not found' });
  }

  if (get && p === '/api/videos') return sendJson(res, 200, { videos: await listVideos(root), initial: ctx.initialVideo || null });

  if (get && p === '/api/probe') {
    const real = await resolveVideo(root, url.searchParams.get('video'));
    if (!real) return sendJson(res, 404, { error: 'not found' });
    return sendJson(res, 200, await probeVideo(real));
  }

  if (p === '/api/session') {
    const rel = url.searchParams.get('video');
    if (!(await resolveVideo(root, rel))) return sendJson(res, 404, { error: 'unknown video' });
    const file = path.join(root, SESSION_DIR, `${sessionKey(rel)}.json`);
    if (get) {
      try { return sendJson(res, 200, JSON.parse(await readFile(file, 'utf8'))); } catch (err) {
        if (err.code === 'ENOENT') return sendJson(res, 200, { video: rel, version: 1 });
        return sendJson(res, 500, { error: err.message });
      }
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'expected object' });
      const dir = await realWithin(root, path.dirname(file), { forWrite: true });
      if (!dir) return sendJson(res, 400, { error: 'invalid session dir' });
      await mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
      await writeFile(tmp, JSON.stringify({ ...body, video: rel, savedAt: new Date().toISOString() }, null, 2));
      await rename(tmp, path.join(dir, path.basename(file)));
      return sendJson(res, 200, { ok: true });
    }
  }

  // Generation: POST {kind: 'keyframe'|'video', video, ...request} -> {jobId}.
  if (req.method === 'POST' && p === '/api/generate') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    if (!body || (body.kind !== 'keyframe' && body.kind !== 'video')) return sendJson(res, 400, { error: 'kind must be keyframe or video' });
    const real = await resolveVideo(root, body.video);
    if (!real) return sendJson(res, 404, { error: 'unknown video' });
    if (body.kind === 'keyframe' && !(Number.isFinite(body.time) && body.time >= 0)) {
      return sendJson(res, 400, { error: 'keyframe needs a time' });
    }
    const outDir = await realWithin(root, path.join(root, SESSION_DIR, sessionKey(body.video)), { forWrite: true });
    if (!outDir) return sendJson(res, 400, { error: 'invalid output dir' });
    const id = `${body.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const job = { id, kind: body.kind, status: 'running', createdAt: new Date().toISOString() };
    ctx.jobs.set(id, job);
    generator.run({ root, videoPath: real, outDir, jobId: id, request: body })
      .then((result) => Object.assign(job, { status: 'done', ...result }))
      .catch((err) => Object.assign(job, { status: 'error', error: err.message }));
    return sendJson(res, 202, { jobId: id });
  }

  if (get && p.startsWith('/api/jobs/')) {
    const job = ctx.jobs.get(p.slice('/api/jobs/'.length));
    return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'unknown job' });
  }

  return sendJson(res, 404, { error: 'not found' });
}

export function createEditServer({ root, generator = createStubGenerator(), initialVideo = null }) {
  const ctx = { root, generator, initialVideo, jobs: new Map() };
  return http.createServer((req, res) => {
    handle(ctx, req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.destroy(err);
    });
  });
}

export function startEditUi({ root, port = 4880, host = '127.0.0.1', generator, initialVideo }) {
  const server = createEditServer({ root, generator, initialVideo });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ server, url: `http://${host}:${server.address().port}/` });
    });
  });
}
