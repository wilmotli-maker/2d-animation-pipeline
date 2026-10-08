// test/edit-ui-server.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startEditUi, sessionKey, listVideos, SESSION_DIR } from '../src/edit-ui/server.js';

let root, server, base;
const calls = [];
const fakeGen = {
  name: 'fake',
  async run({ jobId, request }) { calls.push(request); return { output: `out/${jobId}.png`, stub: true }; },
};

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'edit-ui-'));
  await mkdir(path.join(root, 'shots', 'a'), { recursive: true });
  await writeFile(path.join(root, 'shots', 'a', 'clip.mp4'), 'v');
  await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'x', 'skip.mp4'), 'v');
  await mkdir(path.join(root, '.pipeline'), { recursive: true });
  await writeFile(path.join(root, '.pipeline', 'hidden.mp4'), 'v');
  ({ server, url: base } = await startEditUi({ root, port: 0, generator: fakeGen }));
});
after(async () => { server.close(); await rm(root, { recursive: true, force: true }); });

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('listVideos skips deps and dot-dirs', async () => {
  assert.deepEqual(await listVideos(root), ['shots/a/clip.mp4']);
});

test('sessionKey flattens paths', () => {
  assert.equal(sessionKey('shots/a/clip v1.mp4'), 'shots__a__clip_v1.mp4');
});

test('session round-trips and refuses unknown videos', async () => {
  const q = `api/session?video=${encodeURIComponent('shots/a/clip.mp4')}`;
  assert.deepEqual(await (await fetch(base + q)).json(), { video: 'shots/a/clip.mp4', version: 1 });
  const put = await fetch(base + q, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marks: [{ id: 'm1' }] }) });
  assert.equal(put.status, 200);
  const saved = JSON.parse(await readFile(path.join(root, SESSION_DIR, 'shots__a__clip.mp4.json'), 'utf8'));
  assert.deepEqual(saved.marks, [{ id: 'm1' }]);
  assert.equal((await fetch(`${base}api/session?video=../x.mp4`)).status, 404);
  assert.equal((await fetch(`${base}api/session?video=shots/a/nope.mp4`)).status, 404);
  const textPut = await fetch(base + q, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(textPut.status, 415);
});

test('generate validates, runs the generator, and exposes the job', async () => {
  assert.equal((await fetch(`${base}api/generate`, json({ kind: 'nope', video: 'shots/a/clip.mp4' }))).status, 400);
  assert.equal((await fetch(`${base}api/generate`, json({ kind: 'keyframe', video: 'shots/a/clip.mp4' }))).status, 400);
  const r = await fetch(`${base}api/generate`, json({ kind: 'keyframe', video: 'shots/a/clip.mp4', time: 0.5, prompts: [] }));
  assert.equal(r.status, 202);
  const { jobId } = await r.json();
  let job;
  for (let i = 0; i < 20; i++) { job = await (await fetch(`${base}api/jobs/${jobId}`)).json(); if (job.status !== 'running') break; await new Promise((s) => setTimeout(s, 10)); }
  assert.equal(job.status, 'done');
  assert.equal(job.output, `out/${jobId}.png`);
  assert.equal(calls.at(-1).time, 0.5);
});

test('cross-site requests are refused', async () => {
  const r = await fetch(`${base}api/videos`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 403);
});
