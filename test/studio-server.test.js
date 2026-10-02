// test/studio-server.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'a', versions: ['final'] }) });
  assert.equal(invalid.status, 400);
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
