// test/edit-ui-server.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startEditUi, listRecent } from '../src/edit-ui/server.js';
import { createElement, writeStyleLock } from '../src/element.js';

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

test('a video generate auto-splices and the job exposes the spliced output while keeping the raw output', async () => {
  const out3 = await mkdtemp(path.join(tmpdir(), 'edit-ui-autosplice-'));
  await writeFile(path.join(out3, 'clip.mp4'), 'auto-splice-bytes');
  const spliceCalls = [];
  const stubSplice = async (ws, meta, m) => { spliceCalls.push(m); return { output: `${meta.id}/runs/${m.run}/spliced.mp4` }; };
  const { server: s3, url: b3, initialId: id3 } = await startEditUi({
    workspace: path.join(out3, 'ws'), port: 0, generator: fakeGen, video: path.join(out3, 'clip.mp4'), reveal: () => {}, splice: stubSplice,
  });
  try {
    const req = { kind: 'video', id: id3, fps: 24, marks: [{ id: 'm', kind: 'range', start: 0, end: 96, anchor: 48 }], prompts: [], annotations: [], keyframes: [] };
    const { jobId } = await (await fetch(`${b3}api/generate`, json(req))).json();
    let job; for (let i = 0; i < 50; i++) { job = await (await fetch(`${b3}api/jobs/${jobId}`)).json(); if (job.status !== 'running') break; await new Promise((s) => setTimeout(s, 10)); }
    assert.equal(job.status, 'done');
    assert.equal(spliceCalls.length, 1);                 // splice ran automatically after generation
    assert.match(job.spliced, /spliced\.mp4$/);          // spliced output exposed to the client
    assert.match(job.output, /\.png$/);                  // raw generated output preserved (viewable unspliced)
  } finally { s3.close(); await rm(out3, { recursive: true, force: true }); }
});

test('a failing auto-splice does not fail the generation (raw result still done)', async () => {
  const out4 = await mkdtemp(path.join(tmpdir(), 'edit-ui-autosplice-fail-'));
  await writeFile(path.join(out4, 'clip.mp4'), 'auto-splice-fail-bytes');
  const failSplice = async () => { throw new Error('no usable edit window to splice'); };
  const { server: s4, url: b4, initialId: id4 } = await startEditUi({
    workspace: path.join(out4, 'ws'), port: 0, generator: fakeGen, video: path.join(out4, 'clip.mp4'), reveal: () => {}, splice: failSplice,
  });
  try {
    const req = { kind: 'video', id: id4, fps: 24, marks: [{ id: 'm', kind: 'range', start: 0, end: 96, anchor: 48 }], prompts: [], annotations: [], keyframes: [] };
    const { jobId } = await (await fetch(`${b4}api/generate`, json(req))).json();
    let job; for (let i = 0; i < 50; i++) { job = await (await fetch(`${b4}api/jobs/${jobId}`)).json(); if (job.status !== 'running') break; await new Promise((s) => setTimeout(s, 10)); }
    assert.equal(job.status, 'done');                    // generation still succeeded
    assert.equal(job.spliced ?? null, null);             // no spliced output
    assert.ok((job.warnings || []).some((w) => /splice/i.test(w))); // surfaced as a warning
  } finally { s4.close(); await rm(out4, { recursive: true, force: true }); }
});

const pollAt = async (b, jobId) => {
  let job; for (let i = 0; i < 50; i++) { job = await (await fetch(`${b}api/jobs/${jobId}`)).json(); if (job.status !== 'running') break; await new Promise((s) => setTimeout(s, 10)); }
  return job;
};
// The run manifest is written by several concurrent updateRun calls, so a read can briefly land
// mid-write (listRuns skips an unparseable manifest). Poll until the harmonize field appears.
const pollRunHarmonize = async (b, id) => {
  let runs = []; for (let i = 0; i < 100; i++) { ({ runs } = await (await fetch(`${b}api/runs?id=${id}`)).json()); if (runs[0] && runs[0].harmonize) break; await new Promise((s) => setTimeout(s, 10)); }
  return runs;
};

test('a video generate auto-harmonizes the splice: spliced preview first, harmonized via its own job', async () => {
  const out5 = await mkdtemp(path.join(tmpdir(), 'edit-ui-harmonize-'));
  await writeFile(path.join(out5, 'clip.mp4'), 'harmonize-bytes');
  const stubSplice = async (ws, meta, m) => ({ output: `${meta.id}/runs/${m.run}/spliced.mp4` });
  const harmCalls = [];
  const stubHarmonize = async (args) => {
    harmCalls.push(args);
    const output = path.relative(args.workspace, path.join(args.runDir, 'harmonized.mp4')).split(path.sep).join('/');
    return { output, previz: null };
  };
  const { server: s5, url: b5, initialId: id5 } = await startEditUi({
    workspace: path.join(out5, 'ws'), port: 0, generator: fakeGen, video: path.join(out5, 'clip.mp4'), reveal: () => {}, splice: stubSplice, harmonize: stubHarmonize,
  });
  try {
    const req = { kind: 'video', id: id5, harmonize: true, styleLock: 'a 3D-rendered boy, no flat 2D', fps: 24, marks: [{ id: 'm', kind: 'range', start: 0, end: 96, anchor: 48 }], prompts: [], annotations: [], keyframes: [] };
    const { jobId } = await (await fetch(`${b5}api/generate`, json(req))).json();
    const gen = await pollAt(b5, jobId);
    assert.equal(gen.status, 'done');
    assert.match(gen.spliced, /spliced\.mp4$/);          // the preview is available immediately
    assert.equal(gen.harmonizing, true);                  // and harmonization was kicked off
    assert.ok(gen.harmonizeJobId, 'harmonize job id exposed');

    const harm = await pollAt(b5, gen.harmonizeJobId);    // the harmonize job completes separately
    assert.equal(harm.status, 'done');
    assert.match(harm.output, /harmonized\.mp4$/);
    assert.equal(harmCalls.length, 1);
    assert.match(harmCalls[0].splicedAbs, /spliced\.mp4$/);
    assert.equal(harmCalls[0].styleLock, 'a 3D-rendered boy, no flat 2D');  // request style lock reaches the harmonizer

    const runs = await pollRunHarmonize(b5, id5);
    assert.equal(runs[0].harmonize.status, 'done');       // and the manifest records it
    assert.match(runs[0].harmonize.output, /harmonized\.mp4$/);
  } finally { s5.close(); await rm(out5, { recursive: true, force: true }); }
});

test('harmonization is off by default: without the per-session flag it never runs', async () => {
  const out7 = await mkdtemp(path.join(tmpdir(), 'edit-ui-harmonize-off-'));
  await writeFile(path.join(out7, 'clip.mp4'), 'harmonize-off-bytes');
  const stubSplice = async (ws, meta, m) => ({ output: `${meta.id}/runs/${m.run}/spliced.mp4` });
  let harmCalled = 0;
  const stubHarmonize = async () => { harmCalled++; return { output: 'x/harmonized.mp4' }; };
  const { server: s7, url: b7, initialId: id7 } = await startEditUi({
    workspace: path.join(out7, 'ws'), port: 0, generator: fakeGen, video: path.join(out7, 'clip.mp4'), reveal: () => {}, splice: stubSplice, harmonize: stubHarmonize,
  });
  try {
    const req = { kind: 'video', id: id7, fps: 24, marks: [{ id: 'm', kind: 'range', start: 0, end: 96, anchor: 48 }], prompts: [], annotations: [], keyframes: [] };
    const gen = await pollAt(b7, (await (await fetch(`${b7}api/generate`, json(req))).json()).jobId);
    assert.equal(gen.status, 'done');
    assert.match(gen.spliced, /spliced\.mp4$/);          // still spliced
    assert.equal(gen.harmonizing ?? false, false);        // but harmonization was not triggered
    assert.equal(gen.harmonizeJobId ?? null, null);
    assert.equal(harmCalled, 0);
  } finally { s7.close(); await rm(out7, { recursive: true, force: true }); }
});

test('a failing harmonization keeps the spliced preview and reports the error on its own job', async () => {
  const out6 = await mkdtemp(path.join(tmpdir(), 'edit-ui-harmonize-fail-'));
  await writeFile(path.join(out6, 'clip.mp4'), 'harmonize-fail-bytes');
  const stubSplice = async (ws, meta, m) => ({ output: `${meta.id}/runs/${m.run}/spliced.mp4` });
  const stubHarmonize = async () => { throw new Error('seedance boom'); };
  const { server: s6, url: b6, initialId: id6 } = await startEditUi({
    workspace: path.join(out6, 'ws'), port: 0, generator: fakeGen, video: path.join(out6, 'clip.mp4'), reveal: () => {}, splice: stubSplice, harmonize: stubHarmonize,
  });
  try {
    const req = { kind: 'video', id: id6, harmonize: true, fps: 24, marks: [{ id: 'm', kind: 'range', start: 0, end: 96, anchor: 48 }], prompts: [], annotations: [], keyframes: [] };
    const { jobId } = await (await fetch(`${b6}api/generate`, json(req))).json();
    const gen = await pollAt(b6, jobId);
    assert.equal(gen.status, 'done');
    assert.match(gen.spliced, /spliced\.mp4$/);          // splice preview unaffected by harmonize failure
    const harm = await pollAt(b6, gen.harmonizeJobId);
    assert.equal(harm.status, 'error');
    assert.match(harm.error, /seedance boom/);
    const runs = await pollRunHarmonize(b6, id6);
    assert.equal(runs[0].harmonize.status, 'error');
  } finally { s6.close(); await rm(out6, { recursive: true, force: true }); }
});

test('reveal opens only this video\'s folders', async () => {
  assert.equal((await fetch(`${base}api/reveal`, json({ id: initialId, run: 'v001' }))).status, 200);
  assert.equal(revealed.at(-1), path.join(workspace, initialId, 'runs', 'v001'));
  assert.equal((await fetch(`${base}api/reveal`, json({ id: initialId, run: '../../..' }))).status, 404);
  assert.equal((await fetch(`${base}api/reveal`, json({ id: initialId, run: 'v999' }))).status, 404);
});

test('POST /api/splice validates id and run (404)', async () => {
  assert.equal((await fetch(`${base}api/splice`, json({ id: 'ffffffffffffffff', run: 'v001' }))).status, 404);
  assert.equal((await fetch(`${base}api/splice`, json({ id: initialId, run: '../../..' }))).status, 404);
  assert.equal((await fetch(`${base}api/splice`, json({ id: initialId, run: 'v999' }))).status, 404);
});

test('POST /api/splice runs the splice job and exposes its output', async () => {
  const { mkdir } = await import('node:fs/promises');
  const out2 = await mkdtemp(path.join(tmpdir(), 'edit-ui-splice-'));
  await writeFile(path.join(out2, 'clip.mp4'), 'video-bytes-2');
  const stubSplice = async (ws, meta, m) => ({ output: `${meta.id}/runs/${m.run}/spliced.mp4` });
  const { server: srv, url: b, initialId: id2 } = await startEditUi({
    workspace: path.join(out2, 'ws'), port: 0, generator: fakeGen, video: path.join(out2, 'clip.mp4'),
    reveal: () => {}, splice: stubSplice,
  });
  try {
    const runDir = path.join(out2, 'ws', id2, 'runs', 'v001');
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({ run: 'v001', windows: [{ name: 'w01', status: 'done', output: 'x' }] }));
    const r = await fetch(`${b}api/splice`, json({ id: id2, run: 'v001' }));
    assert.equal(r.status, 202);
    const jobId = (await r.json()).jobId;
    let job; for (let i = 0; i < 50; i++) { job = await (await fetch(`${b}api/jobs/${jobId}`)).json(); if (job.status !== 'running') break; await new Promise((s) => setTimeout(s, 10)); }
    assert.equal(job.status, 'done');
    assert.match(job.output, /spliced\.mp4$/);
  } finally { srv.close(); await rm(out2, { recursive: true, force: true }); }
});

test('transcript is null for a clip without audio', async () => {
  assert.deepEqual(await (await fetch(`${base}api/transcript?id=${initialId}`)).json(), { transcript: null });
});

test('cross-site requests are refused', async () => {
  assert.equal((await fetch(`${base}api/recent`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('POST /api/harmonize harmonizes an already-spliced run on demand; refuses unspliced runs', async () => {
  const outH = await mkdtemp(path.join(tmpdir(), 'edit-ui-harmonize-ondemand-'));
  await writeFile(path.join(outH, 'clip.mp4'), 'harmonize-ondemand-bytes');
  const { updateRun } = await import('../src/edit-ui/workspace.js');
  let doSplice = false;
  const stubSplice = async (ws, meta, m) => {
    if (!doSplice) throw new Error('no splice yet');
    const output = `${meta.id}/runs/${m.run}/spliced.mp4`;
    await updateRun(path.join(ws, meta.id, 'runs', m.run), { spliced: { output } });
    return { output };
  };
  const calls = [];
  const stubHarmonize = async (args) => {
    calls.push(args);
    return { output: path.relative(args.workspace, path.join(args.runDir, 'harmonized.mp4')).split(path.sep).join('/'), previz: null };
  };
  const { server: sH, url: bH, initialId: idH } = await startEditUi({
    workspace: path.join(outH, 'ws'), port: 0, generator: fakeGen, video: path.join(outH, 'clip.mp4'), reveal: () => {}, splice: stubSplice, harmonize: stubHarmonize,
  });
  try {
    const req = { kind: 'video', id: idH, fps: 24, marks: [{ id: 'm', kind: 'range', start: 0, end: 96, anchor: 48 }], prompts: [], annotations: [], keyframes: [] };
    const gen = await pollAt(bH, (await (await fetch(`${bH}api/generate`, json(req))).json()).jobId);
    assert.equal(gen.status, 'done');
    const unspliced = await fetch(`${bH}api/harmonize`, json({ id: idH, run: gen.run }));
    assert.equal(unspliced.status, 409);                  // nothing spliced yet
    doSplice = true;
    const sp = await pollAt(bH, (await (await fetch(`${bH}api/splice`, json({ id: idH, run: gen.run }))).json()).jobId);
    assert.equal(sp.status, 'done');
    const lock = { styleRegister: '3d-render', wardrobe: 'blue coat' };
    const resp = await fetch(`${bH}api/harmonize`, json({ id: idH, run: gen.run, styleLock: lock }));
    assert.equal(resp.status, 202);
    const harm = await pollAt(bH, (await resp.json()).jobId);
    assert.equal(harm.status, 'done');
    assert.match(harm.output, /harmonized\.mp4$/);
    assert.match(calls[0].splicedAbs, /spliced\.mp4$/);
    assert.deepEqual(calls[0].styleLock, lock);
  } finally { sH.close(); await rm(outH, { recursive: true, force: true }); }
});

test('GET /api/elements and the style-lock route read the project root', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'edit-ui-elements-http-'));
  const root = path.join(out, 'project');
  await createElement(root, { type: 'characters', name: 'ada' });
  await writeStyleLock(root, 'characters', 'ada', { wardrobe: 'red hoodie' });
  const { server: srv, url } = await startEditUi({
    workspace: path.join(out, 'ws'), port: 0, root, generator: fakeGen, reveal: () => {},
  });
  try {
    const list = await (await fetch(`${url}api/elements`)).json();
    assert.deepEqual(list.elements, [{ type: 'characters', name: 'ada' }]);
    const lock = await (await fetch(`${url}api/elements/characters/ada/style-lock`)).json();
    assert.equal(lock.styleLock.wardrobe, 'red hoodie');
    assert.match(lock.text, /red hoodie/);
  } finally { srv.close(); await rm(out, { recursive: true, force: true }); }
});

test('omitted root lists no elements and refuses a style-lock read', async () => {
  assert.deepEqual(await (await fetch(`${base}api/elements`)).json(), { elements: [] });
  const lock = await fetch(`${base}api/elements/characters/ada/style-lock`);
  assert.equal(lock.status, 404);
  assert.equal((await lock.json()).error, 'no project root');
});
