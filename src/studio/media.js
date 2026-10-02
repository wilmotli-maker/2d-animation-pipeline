// src/studio/media.js
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

export function contentType(p) { return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

// Resolve a client-supplied relative path under `base`, or null if it is empty,
// contains NUL, is absolute, or escapes `base` after normalization.
export function resolveWithin(base, rel) {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const abs = path.resolve(base, rel);
  const r = path.relative(base, abs);
  if (r === '' || r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) return null;
  return abs;
}

// Single-range "bytes=" parser. Returns {start,end}, null (serve whole file), or
// 'unsatisfiable' (416). Multi-range requests are treated as "serve whole file".
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

export async function sendFile(req, res, abs) {
  let st;
  try { st = await stat(abs); } catch { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
  const headers = { 'Content-Type': contentType(abs), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const range = parseRange(req.headers.range, st.size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
    return res.end();
  }
  if (range) {
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`,
      'Content-Length': range.end - range.start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(abs, range).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(abs).pipe(res);
}
