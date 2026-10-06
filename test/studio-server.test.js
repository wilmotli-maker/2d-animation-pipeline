// test/studio-server.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, chmod, symlink, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startStudio } from '../src/studio/server.js';

let outer, root, server, base;
before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), 'studio-srv-'));
  root = path.join(outer, 'proj');
  const dir = path.join(root, 'episodes', '1', 'shots', 'ai-1', 'drafts', 'v001');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'output.mp4'), '0123456789');
  await mkdir(path.join(root, 'elements', 'characters', 'mira', 'sheets', 'pose', 'wave'), { recursive: true });
  await writeFile(path.join(root, 'elements', 'characters', 'mira', 'sheets', 'pose', 'wave', 'v001.png'), 'png');
  await writeFile(path.join(outer, 'secret.txt'), 'nope');
  const cand = path.join(root, 'episodes', '1', 'shots', 'candidates');
  await mkdir(cand, { recursive: true });
  for (const f of ['x-v001.mp4', 'x-v002.mp4', 'y.mp4', 'notes.txt']) await writeFile(path.join(cand, f), 'v');
  await mkdir(path.join(cand, 'nested'), { recursive: true });
  await writeFile(path.join(cand, 'nested', 'n.mp4'), 'v');
  const deep = path.join(cand, 'a', 'b', 'c', 'd');
  await mkdir(deep, { recursive: true });
  await writeFile(path.join(deep, 'd.mp4'), 'v');
  await mkdir(path.join(cand, '.hidden'), { recursive: true });
  await writeFile(path.join(cand, '.hidden', 'h.mp4'), 'v');
  await mkdir(path.join(root, 'shots', 'assembled'), { recursive: true });
  await writeFile(path.join(root, 'shots', 'assembled', 'TEST2.mp4'), 'v');
  // Stub previewer: the endpoint's validation + passthrough is what's under test here
  // (rendering is covered by test/studio-matte-preview.test.js).
  const previewer = { request: async (src, bg) => ({ state: 'pending', src, bg }) };
  ({ server, url: base } = await startStudio({ root, port: 0, previewer }));
});
after(async () => { server.close(); await rm(outer, { recursive: true, force: true }); });

test('GET / serves the shell; /review.css serves the shared review style', async () => {
  const html = await fetch(base).then((r) => r.text());
  assert.match(html, /<!doctype html>/i);
  const css = await fetch(base + 'review.css');
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.match(await css.text(), /--accent/);
});

test('GET /static serves bundled web files (real-path checked), blocks traversal', async () => {
  const r = await fetch(base + 'static/index.html');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<!doctype html>/i);
  const mod = await fetch(base + 'static/selection-sync.js');   // imported by app.js
  assert.equal(mod.status, 200);
  assert.match(mod.headers.get('content-type'), /javascript/);
  assert.match(await mod.text(), /export function createSelectionSync/);
  const esc = await fetch(base + 'static/..%2Fserver.js');
  assert.equal(esc.status, 404);
  await esc.arrayBuffer();
});

test('GET /api/tree', async () => {
  const t = await fetch(base + 'api/tree').then((r) => r.json());
  assert.equal(t.episodes[0].shots[0].shotId, 'ai-1');
  assert.equal(t.elements[0].name, 'mira');
});

test('GET /api/shots filters by episode and id', async () => {
  const all = await fetch(base + 'api/shots?episode=1').then((r) => r.json());
  assert.equal(all.shots.length, 1);
  assert.equal(all.shots[0].versions[0].video, path.join('episodes', '1', 'shots', 'ai-1', 'drafts', 'v001', 'output.mp4'));
  const none = await fetch(base + 'api/shots?episode=_').then((r) => r.json());
  assert.equal(none.shots.length, 0);
  const one = await fetch(base + 'api/shots?episode=1&id=nope').then((r) => r.json());
  assert.equal(one.shots.length, 0);
});

test('GET /api/folder scans a working folder like `review --folder`', async () => {
  const q = (ep, p) => fetch(`${base}api/folder?episode=${encodeURIComponent(ep)}&path=${encodeURIComponent(p)}`);
  const r = await q('1', 'candidates');
  assert.equal(r.status, 200);
  const { shots } = await r.json();
  assert.deepEqual(shots.map((s) => s.shotId), ['x', 'y']);
  assert.deepEqual(shots[0].versions.map((v) => v.version), ['v001', 'v002']);
  assert.equal(shots[0].versions[0].video, path.join('episodes', '1', 'shots', 'candidates', 'x-v001.mp4'));
  const flat = await q('_', 'assembled').then((x) => x.json());
  assert.deepEqual(flat.shots.map((s) => s.shotId), ['TEST2']);
  assert.equal((await q('1', '../../..')).status, 400);         // traversal
  assert.equal((await q('1', '')).status, 400);                 // missing path
  assert.equal((await q('9', 'candidates')).status, 404);       // unknown episode
  assert.equal((await q('..', 'candidates')).status, 404);
  assert.equal((await q('1', 'ai-1')).status, 400);             // a real shot dir
  assert.equal((await q('1', 'nope')).status, 404);             // nonexistent
  // Same rules as the tree walk: only paths the tree can list.
  assert.equal((await q('1', 'ai-1/drafts/v001')).status, 400);   // inside a shot
  assert.equal((await q('1', 'ai-1/drafts')).status, 400);
  assert.equal((await q('1', 'ai-1/final')).status, 400);
  assert.equal((await q('1', 'candidates/.hidden')).status, 400); // hidden segment
  assert.equal((await q('1', 'candidates/a/b/c/d')).status, 400); // deeper than the walker goes
  assert.equal((await q('1', 'candidates/nested')).status, 200);  // listed nested folder
  assert.equal((await q('1', 'candidates/x-v001.mp4')).status, 404);   // a file, not a dir
});

test('GET /api/folder: symlinked folders resolving outside shots/ are rejected without scanning; tree skips them', async (t) => {
  const q = (ep, p) => fetch(`${base}api/folder?episode=${encodeURIComponent(ep)}&path=${encodeURIComponent(p)}`);
  const shots = path.join(root, 'episodes', '1', 'shots');
  const ext = path.join(outer, 'ext-videos');
  await mkdir(path.join(ext, 'deeper'), { recursive: true });
  await writeFile(path.join(ext, 'EXTERNAL-CLIP.mp4'), 'v');
  await writeFile(path.join(ext, 'deeper', 'EXTERNAL-DEEP.mp4'), 'v');
  if (!await trySymlink(t, ext, path.join(shots, 'export'))) return;
  await mkdir(path.join(shots, 'linkparent'), { recursive: true });
  await symlink(ext, path.join(shots, 'linkparent', 'via'));
  await symlink(ext, path.join(shots, 'viaintermediate'));
  for (const p of ['export', 'linkparent/via', 'viaintermediate/deeper']) {
    const r = await q('1', p);
    assert.ok(r.status === 400 || r.status === 404, `${p}: ${r.status}`);
    assert.doesNotMatch(await r.text(), /EXTERNAL/, p);
  }
  const tree = JSON.stringify(await fetch(base + 'api/tree').then((r) => r.json()));
  assert.doesNotMatch(tree, /export|viaintermediate|linkparent/);
});

test('GET /api/folder: only folders that directly hold videos (same rule as the tree)', async () => {
  const q = (ep, p) => fetch(`${base}api/folder?episode=${encodeURIComponent(ep)}&path=${encodeURIComponent(p)}`);
  const inner = path.join(root, 'episodes', '1', 'shots', 'wrapper', 'inner');
  await mkdir(inner, { recursive: true });
  await writeFile(path.join(inner, 'a.mp4'), 'v');
  assert.equal((await q('1', 'wrapper')).status, 400);
  assert.equal((await q('1', 'wrapper/inner')).status, 200);
});

test('GET /api/element', async () => {
  const el = await fetch(base + 'api/element?type=characters&name=mira').then((r) => r.json());
  assert.equal(el.sheets[0].sheetType, 'pose');
  const missing = await fetch(base + 'api/element?type=props&name=x').then((r) => r.json());
  assert.deepEqual(missing.sheets, []);
});

test('GET /media supports Range and blocks traversal', async () => {
  const p = 'media/episodes/1/shots/ai-1/drafts/v001/output.mp4';
  const r = await fetch(base + p, { headers: { Range: 'bytes=2-4' } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), '234');
  const esc = await fetch(base + 'media/shots%2F..%2F..%2Fsecret.txt');
  assert.equal(esc.status, 404);
});

// Symlinks can be unavailable (e.g. unprivileged Windows); skip rather than fail.
async function trySymlink(t, target, p) {
  try { await symlink(target, p); return true; } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') { t.skip('symlinks unavailable'); return false; }
    throw err;
  }
}

test('GET /media: in-root symlinks resolving outside the project -> 404, secret not served', async (t) => {
  const ext = path.join(outer, 'ext');
  await mkdir(ext, { recursive: true });
  await writeFile(path.join(ext, 'secret.txt'), 'EXTERNAL-SECRET');
  if (!await trySymlink(t, ext, path.join(root, 'escape'))) return;
  await symlink(path.join(ext, 'secret.txt'), path.join(root, 'leak.txt'));
  for (const p of ['media/escape/secret.txt', 'media/leak.txt', 'media/escape']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(await r.text(), /EXTERNAL-SECRET/);
  }
  const ranged = await fetch(base + 'media/leak.txt', { headers: { Range: 'bytes=0-3' } });
  assert.equal(ranged.status, 404);
  await ranged.arrayBuffer();
});

test('GET /media: a symlink that stays inside the project is served', async (t) => {
  const dir = path.join(root, 'episodes', '1', 'shots', 'ai-1', 'drafts', 'v002');
  await mkdir(dir, { recursive: true });
  if (!await trySymlink(t, path.join('..', 'v001', 'output.mp4'), path.join(dir, 'output.mp4'))) return;
  const r = await fetch(base + 'media/episodes/1/shots/ai-1/drafts/v002/output.mp4');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '0123456789');
});

test('/api/selections: symlinked .pipeline outside the project -> 403 for GET and PUT, outside untouched', async (t) => {
  const proj = path.join(outer, 'linked-sel');
  const ext = path.join(outer, 'linked-sel-ext');
  await mkdir(path.join(ext, 'studio'), { recursive: true });
  await mkdir(proj, { recursive: true });
  await writeFile(path.join(ext, 'studio', 'selections.json'), '{"version":1,"selected":{"SENTINEL":["v001"]}}');
  if (!await trySymlink(t, ext, path.join(proj, '.pipeline'))) return;
  const { server: s2, url: b2 } = await startStudio({ root: proj, port: 0, previewer: {} });
  try {
    const got = await fetch(b2 + 'api/selections');
    assert.equal(got.status, 403);
    assert.doesNotMatch(await got.text(), /SENTINEL/);
    const put = await fetch(b2 + 'api/selections', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'a', versions: ['v001'] }) });
    assert.equal(put.status, 403);
    await put.arrayBuffer();
    assert.deepEqual(await readdir(path.join(ext, 'studio')), ['selections.json']);
    assert.equal(await readFile(path.join(ext, 'studio', 'selections.json'), 'utf8'),
      '{"version":1,"selected":{"SENTINEL":["v001"]}}');
  } finally { s2.close(); }
});

test('GET /media: unsatisfiable range -> 416; suffix range -> 206', async () => {
  const p = 'media/episodes/1/shots/ai-1/drafts/v001/output.mp4';
  const r416 = await fetch(base + p, { headers: { Range: 'bytes=999-' } });
  assert.equal(r416.status, 416);
  assert.equal(r416.headers.get('content-range'), 'bytes */10');
  await r416.arrayBuffer();
  const suffix = await fetch(base + p, { headers: { Range: 'bytes=-3' } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), '789');
});

test('GET /media: unreadable file -> 404 and the server survives', { skip: process.getuid?.() === 0 && 'root ignores file modes' }, async () => {
  const f = path.join(root, 'locked.txt');
  await writeFile(f, 'secret');
  await chmod(f, 0o000);
  try {
    const r = await fetch(base + 'media/locked.txt');
    assert.equal(r.status, 404);
    await r.arrayBuffer();
    assert.equal((await fetch(base + 'api/tree')).status, 200);
  } finally { await chmod(f, 0o644); }
});

const hasMkfifo = spawnSync('mkfifo', ['--help']).error == null;
test('GET /media: FIFO -> 404 without blocking', { skip: !hasMkfifo && 'mkfifo unavailable' }, async () => {
  assert.equal(spawnSync('mkfifo', [path.join(root, 'pipe.fifo')]).status, 0);
  const r = await fetch(base + 'media/pipe.fifo', { signal: AbortSignal.timeout(2000) });
  assert.equal(r.status, 404);
  await r.arrayBuffer();
});

test('PUT /api/selections round-trips; requires JSON content type', async () => {
  const put = await fetch(base + 'api/selections', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: '1/ai-1', versions: ['v001'] }) });
  assert.equal(put.status, 200);
  assert.deepEqual((await put.json()).selected, { '1/ai-1': ['v001'] });
  const got = await fetch(base + 'api/selections').then((r) => r.json());
  assert.deepEqual(got.selected, { '1/ai-1': ['v001'] });
  const bad = await fetch(base + 'api/selections', { method: 'PUT', body: '{"key":"a","versions":[]}' });
  assert.equal(bad.status, 415);
  const invalid = await fetch(base + 'api/selections', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'a', versions: ['a::b'] }) });
  assert.equal(invalid.status, 400);
});

test('PUT /api/selections: oversized body -> 413 reaches the client', async () => {
  const r = await fetch(base + 'api/selections', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'a', versions: [], pad: 'x'.repeat(100 * 1024) }) });
  assert.equal(r.status, 413);
  assert.equal(r.headers.get('connection'), 'close');
});

test('GET /api/matte-preview validates src/bg and delegates to the previewer', async () => {
  const q = (src, bg) => fetch(`${base}api/matte-preview?src=${encodeURIComponent(src)}${bg ? `&bg=${bg}` : ''}`);
  const ok = await q('episodes/1/shots/ai-1/drafts/v001/alpha.mov');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(),
    { state: 'pending', src: path.join('episodes', '1', 'shots', 'ai-1', 'drafts', 'v001', 'alpha.mov'), bg: 'checker' });
  assert.equal((await q('episodes/1/shots/ai-1/drafts/v001/alpha.webm', 'green')).status, 200);
  assert.equal((await q('episodes/1/shots/ai-1/drafts/v001/output.mp4')).status, 400);   // not a matte
  assert.equal((await q('../secret/alpha.mov')).status, 400);                            // escapes root
  assert.equal((await q('.pipeline/studio/previews/x/alpha.mov')).status, 400);          // cache dir
  assert.equal((await q('./.pipeline/studio/previews/x/alpha.mov')).status, 400);        // ...even un-normalized
  assert.equal((await q('x/../.pipeline/studio/previews/x/alpha.mov')).status, 400);
  const lookalike = await q('.pipelineX/alpha.mov');                                     // not the cache dir
  assert.equal(lookalike.status, 200);
  assert.equal((await lookalike.json()).src, path.join('.pipelineX', 'alpha.mov'));
  assert.equal((await q('shots/a/alpha.mov', 'plaid')).status, 400);                    // unknown bg
});

test('rejects foreign Host headers (DNS-rebinding guard)', async () => {
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: '/api/tree', headers: { Host: 'evil.example' } },
      (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 403);
});

// node:http (not fetch) so the browser-controlled headers can be set.
async function rawGet(pathname, headers) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: pathname, headers },
      (res) => { res.resume(); resolve(res.statusCode); });
  });
}

test('rejects cross-site requests (Sec-Fetch-Site / Origin)', async () => {
  assert.equal(await rawGet('/api/tree', { 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.equal(await rawGet('/api/tree', { 'Sec-Fetch-Site': 'same-site' }), 403);
  assert.equal(await rawGet('/api/tree', { Origin: 'http://evil.example' }), 403);
  assert.equal(await rawGet('/api/tree', { Origin: 'not a url' }), 403);
  assert.equal(await rawGet('/api/tree', { 'Sec-Fetch-Site': 'same-origin' }), 200);
  assert.equal(await rawGet('/api/tree', { 'Sec-Fetch-Site': 'none' }), 200);
  // Following a link from another site is a cross-site top-level navigation: allow only the shell page.
  const nav = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal(await rawGet('/', nav), 200);
  assert.equal(await rawGet('/api/tree', nav), 403);
  assert.equal(await rawGet('/', { 'Sec-Fetch-Site': 'cross-site' }), 403);
  const u = new URL(base);
  assert.equal(await rawGet('/api/tree', { Origin: `http://${u.host}` }), 200);
});

test('PUT /api/selections: storage failure (unreadable store) -> 500, not 400', async () => {
  const proj = path.join(outer, 'corrupt');
  // A directory where the file should be: a real I/O failure, not malformed content.
  await mkdir(path.join(proj, '.pipeline', 'studio', 'selections.json'), { recursive: true });
  const { server: s2, url: b2 } = await startStudio({ root: proj, port: 0, previewer: {} });
  try {
    const r = await fetch(b2 + 'api/selections', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'a', versions: ['v001'] }) });
    assert.equal(r.status, 500);
    const bad = await fetch(b2 + 'api/selections', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'a', versions: ['x::y'] }) });
    assert.equal(bad.status, 400);
  } finally { s2.close(); }
});

// Malformed stores must not brick startup: GET normalizes (file untouched), PUT rewrites cleanly.
async function withSelectionsFile(name, content, fn) {
  const proj = path.join(outer, name);
  const file = path.join(proj, '.pipeline', 'studio', 'selections.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  const { server: s2, url: b2 } = await startStudio({ root: proj, port: 0, previewer: {} });
  try { await fn(b2, file); } finally { s2.close(); }
}
const putSel = (b, body) => fetch(b + 'api/selections', { method: 'PUT',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('GET /api/selections: invalid entries dropped with a warning; file untouched', async () => {
  const raw = '{"selected":{"shot-1":null,"ok":["v001", 5, "bad::x"]}}';
  await withSelectionsFile('malformed-entries', raw, async (b2, file) => {
    const r = await fetch(b2 + 'api/selections');
    assert.equal(r.status, 200);
    const doc = await r.json();
    assert.deepEqual(doc.selected, { ok: ['v001'] });
    assert.deepEqual(doc.warnings, ['ignored 3 invalid selection entries']);
    assert.equal(await readFile(file, 'utf8'), raw);
  });
});

test('GET /api/selections: invalid JSON -> 200 empty + warning; next PUT writes a clean doc', async () => {
  await withSelectionsFile('malformed-json', '{not json', async (b2, file) => {
    const doc = await fetch(b2 + 'api/selections').then((r) => r.json());
    assert.deepEqual(doc.selected, {});
    assert.equal(doc.warnings.length, 1);
    assert.match(doc.warnings[0], /not valid JSON.*starting empty.*untouched until the next save/);
    assert.equal(await readFile(file, 'utf8'), '{not json');
    const put = await putSel(b2, { key: 'a', versions: ['v001'] });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { version: 1, selected: { a: ['v001'] } });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, selected: { a: ['v001'] } });
    assert.equal((await fetch(b2 + 'api/selections').then((r) => r.json())).warnings, undefined);
  });
});

test('GET /api/selections: non-object "selected" -> empty + warning; PUT keeps only valid entries', async () => {
  await withSelectionsFile('malformed-array', '{"version":1,"selected":[]}', async (b2) => {
    const doc = await fetch(b2 + 'api/selections').then((r) => r.json());
    assert.deepEqual(doc.selected, {});
    assert.equal(doc.warnings.length, 1);
  });
  await withSelectionsFile('malformed-mixed', '{"selected":{"x":"v001","y":["v002"]}}', async (b2, file) => {
    assert.equal((await putSel(b2, { key: 'z', versions: ['v003'] })).status, 200);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).selected, { y: ['v002'], z: ['v003'] });
  });
});
