// test/edit-ui-server.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startEditUi, listRecent } from '../src/edit-ui/server.js';

let outer, workspace, server, base, initialId;
const revealed = [];
const calls = [];
const fakeGen = {
  name: 'fake',
  async run({ jobId, request }) { calls.push(request); return { output: `x/${jobId}.png`, stub: true }; },
};

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), 'edit-ui-'));
  workspace = path.join(outer, 'ws');
  await writeFile(path.join(outer, 'clip.mp4'), 'video-bytes');
  ({ server, url: base, initialId } = await startEditUi({ workspace, port: 0, generator: fakeGen, video: path.join(outer, 'clip.mp4'), reveal: (p) => revealed.push(p) }));
});
after(async () => { server.close(); await rm(outer, { recursive: true, force: true }); });

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const upload = (url, name, body, type = 'application/octet-stream') => fetch(base + url, {
  method: 'POST', headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent(name) }, body,
});

test('a startup video is imported by content hash and listed as recent', async () => {
  assert.match(initialId, /^[0-9a-f]{16}$/);
  assert.equal(await readFile(path.join(workspace, initialId, 'source.mp4'), 'utf8'), 'video-bytes');
  const { recent, initial } = await (await fetch(`${base}api/recent`)).json();
  assert.equal(initial, initialId);
  assert.deepEqual(recent.map((r) => r.name), ['clip.mp4']);
});

test('uploading the same bytes resumes the same id; other types are refused', async () => {
  const r = await upload('api/open', 'renamed.mp4', 'video-bytes');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).id, initialId);
  assert.equal((await upload('api/open', 'notes.txt', 'x')).status, 400);
  assert.equal((await upload('api/open', 'a.mp4', 'x', 'text/plain')).status, 400);
  assert.equal((await readdir(workspace)).filter((d) => d.startsWith('.import')).length, 0);
  assert.equal((await listRecent(workspace)).length, 1);
});

test('source is served from the workspace; traversal is not', async () => {
  const meta = await (await fetch(`${base}api/video?id=${initialId}`)).json();
  assert.equal(meta.src, `/files/${initialId}/source.mp4`);
  assert.equal(await (await fetch(base + meta.src.slice(1))).text(), 'video-bytes');
  assert.equal((await fetch(`${base}files/..%2F..%2Fclip.mp4`)).status, 404);
  assert.equal((await fetch(`${base}api/video?id=../x`)).status, 404);
});

test('session round-trips', async () => {
  const q = `api/session?id=${initialId}`;
  assert.deepEqual(await (await fetch(base + q)).json(), { version: 2 });
  const put = await fetch(base + q, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marks: [{ id: 'm1' }] }) });
  assert.equal(put.status, 200);
  assert.deepEqual((await (await fetch(base + q)).json()).marks, [{ id: 'm1' }]);
  assert.equal((await fetch(base + q, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
});

test('keyframe upload stores images only', async () => {
  const r = await upload(`api/keyframe-upload?id=${initialId}`, 'kf.png', 'png-bytes');
  assert.equal(r.status, 200);
  const { output } = await r.json();
  assert.match(output, new RegExp(`^${initialId}/keyframes/upload-.*\\.png$`));
  assert.equal(await readFile(path.join(workspace, output), 'utf8'), 'png-bytes');
  assert.equal((await upload(`api/keyframe-upload?id=${initialId}`, 'kf.exe', 'x')).status, 400);
});

test('generate validates, runs the generator, and exposes the job', async () => {
  assert.equal((await fetch(`${base}api/generate`, json({ kind: 'nope', id: initialId }))).status, 400);
  assert.equal((await fetch(`${base}api/generate`, json({ kind: 'keyframe', id: initialId }))).status, 400);
  assert.equal((await fetch(`${base}api/generate`, json({ kind: 'video', id: 'ffffffffffffffff' }))).status, 404);
  const r = await fetch(`${base}api/generate`, json({ kind: 'keyframe', id: initialId, time: 0.5, prompts: [] }));
  assert.equal(r.status, 202);
  const { jobId } = await r.json();
  let job;
  for (let i = 0; i < 20; i++) { job = await (await fetch(`${base}api/jobs/${jobId}`)).json(); if (job.status !== 'running') break; await new Promise((s) => setTimeout(s, 10)); }
  assert.equal(job.status, 'done');
  assert.equal(calls.at(-1).time, 0.5);
});

async function waitJob(jobId) {
  let job;
  for (let i = 0; i < 50; i++) { job = await (await fetch(`${base}api/jobs/${jobId}`)).json(); if (job.status !== 'running') break; await new Promise((s) => setTimeout(s, 10)); }
  return job;
}

test('a video generate creates a numbered run with a manifest and prompt', async () => {
  const req = { kind: 'video', id: initialId, fps: 24, marks: [{ id: 'm', start: 0, end: 4 }],
    prompts: [{ id: 'p', markId: 'm', text: 'wave hello' }], annotations: [], keyframes: [] };
  const job = await waitJob((await (await fetch(`${base}api/generate`, json(req))).json()).jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.run, 'v001');
  const runDir = path.join(workspace, initialId, 'runs', 'v001');
  assert.match(await readFile(path.join(runDir, 'prompt.txt'), 'utf8'), /wave hello/);
  const { runs } = await (await fetch(`${base}api/runs?id=${initialId}`)).json();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'done');
  assert.equal(runs[0].generator.name, 'fake');
  assert.ok(runs[0].finishedAt);
  assert.equal(calls.at(-1).kind, 'video');
});

test('reveal opens only this video\'s folders', async () => {
  assert.equal((await fetch(`${base}api/reveal`, json({ id: initialId, run: 'v001' }))).status, 200);
  assert.equal(revealed.at(-1), path.join(workspace, initialId, 'runs', 'v001'));
  assert.equal((await fetch(`${base}api/reveal`, json({ id: initialId, run: '../../..' }))).status, 404);
  assert.equal((await fetch(`${base}api/reveal`, json({ id: initialId, run: 'v999' }))).status, 404);
});

test('transcript is null for a clip without audio', async () => {
  assert.deepEqual(await (await fetch(`${base}api/transcript?id=${initialId}`)).json(), { transcript: null });
});

test('cross-site requests are refused', async () => {
  assert.equal((await fetch(`${base}api/recent`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});
