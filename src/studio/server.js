// src/studio/server.js
// Local-only review server. Binds to 127.0.0.1, serves the project's media in
// place (no vendoring), and answers a small JSON API built on the review scanners.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanShots, scanImages } from '../review-scan.js';
import { REVIEW_STYLE } from '../review-render.js';
import { scanProjectTree } from './tree.js';
import { resolveWithin, sendFile } from './media.js';
import { readSelections, setSelection } from './selections.js';
import { createPreviewer, PREVIEW_BGS } from './matte-preview.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_BODY = 64 * 1024;

function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return null; } }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    // Past the cap: stop buffering but keep draining, so the 413 can actually be
    // delivered (destroying the socket mid-upload surfaces as a connection reset).
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => (size > MAX_BODY
      ? reject(Object.assign(new Error('body too large'), { status: 413 }))
      : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

async function handle({ root, previewer }, req, res) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return sendJson(res, 403, { error: 'forbidden host' });

  // Any web page can fire requests at 127.0.0.1 (<img>, fetch no-cors); refuse
  // anything the browser marks as cross-site so they can't trigger renders or reads.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return sendJson(res, 403, { error: 'cross-site request' });
  if (req.headers.origin) {
    let originHost = null;
    try { originHost = new URL(req.headers.origin).host; } catch { /* malformed -> reject */ }
    if (originHost !== req.headers.host) return sendJson(res, 403, { error: 'cross-origin request' });
  }

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const get = req.method === 'GET' || req.method === 'HEAD';

  if (get && p === '/') return sendFile(req, res, path.join(WEB, 'index.html'));
  if (get && p === '/review.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(REVIEW_STYLE);
  }
  if (get && p.startsWith('/static/')) {
    const abs = resolveWithin(WEB, safeDecode(p.slice('/static/'.length)));
    return abs ? sendFile(req, res, abs) : sendJson(res, 404, { error: 'not found' });
  }
  if (get && p.startsWith('/media/')) {
    const abs = resolveWithin(root, safeDecode(p.slice('/media/'.length)));
    return abs ? sendFile(req, res, abs) : sendJson(res, 404, { error: 'not found' });
  }

  if (get && p === '/api/tree') return sendJson(res, 200, await scanProjectTree(root));

  if (get && p === '/api/shots') {
    const ep = url.searchParams.get('episode');
    const id = url.searchParams.get('id');
    const model = await scanShots(root, ep && ep !== '_' ? { episodes: [ep] } : {});
    let shots = model.shots;
    if (ep === '_') shots = shots.filter((s) => s.episode == null);
    if (id) shots = shots.filter((s) => s.shotId === id);
    return sendJson(res, 200, { shots });
  }

  if (get && p === '/api/element') {
    const type = url.searchParams.get('type');
    const name = url.searchParams.get('name');
    const model = await scanImages(root);
    const el = model.characters.find((c) => c.type === type && c.name === name);
    return sendJson(res, 200, { type, name, sheets: el ? el.sheets : [] });
  }

  if (get && p === '/api/matte-preview') {
    const src = url.searchParams.get('src');
    const bg = url.searchParams.get('bg') || 'checker';
    // Only real matte files inside the project; the previews cache itself is off-limits.
    const norm = src && path.normalize(src);
    if (!resolveWithin(root, src) || !/(^|[\\/])alpha\.(mov|webm|mp4)$/i.test(src)
      || norm.split(/[\\/]/)[0] === '.pipeline' || !Object.hasOwn(PREVIEW_BGS, bg)) {
      return sendJson(res, 400, { error: 'invalid src or bg' });
    }
    return sendJson(res, 200, await previewer.request(norm, bg));
  }

  if (p === '/api/selections') {
    if (get) return sendJson(res, 200, await readSelections(root));
    if (req.method === 'PUT') {
      // Requiring application/json forces a CORS preflight for cross-origin
      // pages, which this server never answers, so other sites can't write here.
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
        return sendJson(res, 415, { error: 'expected application/json' });
      }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message },
          err.status === 413 ? { Connection: 'close' } : {});
      }
      try {
        return sendJson(res, 200, await setSelection(root, body && body.key, body && body.versions));
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

export function createStudioServer({ root, previewer = createPreviewer({ root }) }) {
  const ctx = { root, previewer };
  return http.createServer((req, res) => {
    handle(ctx, req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.destroy(err);
    });
  });
}

export function startStudio({ root, port = 4870, host = '127.0.0.1', previewer }) {
  const server = createStudioServer({ root, previewer });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ server, url: `http://${host}:${server.address().port}/` });
    });
  });
}
