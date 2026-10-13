// test/edit-ui-trim-generator.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTrimGenerator } from '../src/edit-ui/trim-generator.js';

function recordingDeps() {
  const submissions = [];
  return {
    submissions,
    ffmpeg: async () => {},                              // no-op; media assertions are separate
    transcribe: async () => 'Hello there',
    runner: { upload: async () => ({ id: 'vid-1' }) },
    runBatch: async (_r, items) => { submissions.push(...items); return items.map(() => ({ status: 'completed', outputUrl: 'http://x/out.mp4', id: 'j' })); },
    download: async (_url, abs) => { await writeFile(abs, 'clip'); },
    now: () => '2026-10-13T00:00:00.000Z',
  };
}

const editedKf = (frame, time) => ({ role: 'keyframe', kind: 'edited', frame, time, path: `abcdef0123456789/runs/v001/keyframes/edited/f${frame}.png` });
const baseInputs = [
  { role: 'source', path: 'abcdef0123456789/source.mp4' },
  { role: 'speechref', path: 'abcdef0123456789/runs/v001/speechref.mp4' },
  { role: 'audio', path: 'abcdef0123456789/derived/audio.wav' },
];

// Minimal run scaffold: workspace/<id>/runs/v001 with a manifest + source.
async function scaffold(fn, { inputs, marks = [], duration = 10, fps = 24 }) {
  const ws = await mkdtemp(path.join(tmpdir(), 'trimgen-'));
  const id = 'abcdef0123456789';
  const runDir = path.join(ws, id, 'runs', 'v001');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(ws, id, 'source.mp4'), 'v');
  const manifest = {
    run: 'v001', kind: 'video', prompt: { text: 'raise a fist' }, settings: { fps },
    source: { id, file: 'source.mp4', duration, width: 1080, height: 1920, fps },
    marks, prompts: [{ markId: null, text: 'raise a fist' }], inputs, warnings: [],
  };
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));
  const deps = recordingDeps();
  const gen = createTrimGenerator(deps);
  const job = {
    root: ws, videoPath: path.join(ws, id, 'source.mp4'), outDir: path.join(ws, id),
    runDir, run: manifest, jobId: 'job1', request: { kind: 'video', marks, fps },
  };
  try { return await fn({ ws, runDir, gen, job, deps }); } finally { await rm(ws, { recursive: true, force: true }); }
}

test('a single edited keyframe produces one window and one draft submission (3kf)', async () => {
  await scaffold(async ({ gen, job, deps, runDir }) => {
    const res = await gen.run(job);
    assert.equal(deps.submissions.length, 1);
    const { opts, model } = deps.submissions[0];
    assert.equal(model, 'seedance_2_5');
    assert.equal(opts.draft, true);                          // draft default
    assert.equal(opts.mode, 'omni_reference');
    assert.equal(opts.resolution, '480p');
    assert.equal(opts.aspectRatio, '9:16');                  // nearestAspect(1080,1920)
    assert.equal(opts.duration, 4);
    assert.ok(opts.startImage && opts.endImage);
    assert.equal(opts.imageReferences.length, 1);            // one pose => 3kf
    assert.deepEqual(opts.videoReferences, ['vid-1']);
    const m = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
    assert.equal(m.windows.length, 1);
    assert.deepEqual(m.windows[0].pad, { start: 0, end: 0 });
    assert.equal(m.windows[0].status, 'done');
    assert.match(res.output, /windows\/w01\/out\.mp4$/);
  }, { inputs: [...baseInputs, editedKf(120, 5)], duration: 10 });
});

test('a mark with no edited keyframe submits a 2kf text-pose job', async () => {
  await scaffold(async ({ gen, job, deps }) => {
    await gen.run(job);
    assert.equal(deps.submissions.length, 1);
    assert.equal(deps.submissions[0].opts.imageReferences.length, 0);  // text-pose => no middle
  }, { inputs: baseInputs, marks: [{ id: 'm1', kind: 'frame', start: 120, end: 120 }], duration: 10 });
});

test('two distant marks yield two windows and two submissions', async () => {
  await scaffold(async ({ gen, job, deps, runDir }) => {
    await gen.run(job);
    assert.equal(deps.submissions.length, 2);
    const m = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
    assert.equal(m.windows.length, 2);
  }, { inputs: baseInputs, marks: [{ id: 'a', kind: 'frame', start: 48, end: 48 }, { id: 'b', kind: 'frame', start: 216, end: 216 }], duration: 12 });
});

test('a failing window is isolated; other windows still complete and an output returns', async () => {
  await scaffold(async ({ gen, job, deps, runDir }) => {
    let call = 0;
    deps.runBatch = async (_r, items) => { call++; return items.map(() => (call === 1 ? { status: 'failed', error: 'boom' } : { status: 'completed', outputUrl: 'http://x/o.mp4' })); };
    const res = await gen.run(job);
    const m = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
    const statuses = m.windows.map((w) => w.status).sort();
    assert.deepEqual(statuses, ['done', 'error']);
    assert.ok(res.output);                                   // the good window still gives an output
  }, { inputs: baseInputs, marks: [{ id: 'a', kind: 'frame', start: 48, end: 48 }, { id: 'b', kind: 'frame', start: 216, end: 216 }], duration: 12 });
});

test('when every window fails, run() throws so the run is not marked done', async () => {
  await scaffold(async ({ gen, job, deps }) => {
    deps.runBatch = async (_r, items) => items.map(() => ({ status: 'failed', error: 'boom' }));
    await assert.rejects(() => gen.run(job), /all .*window|generation failed|no window/i);
  }, { inputs: baseInputs, marks: [{ id: 'a', kind: 'frame', start: 48, end: 48 }], duration: 10 });
});

test('no regions falls back to one whole-clip window', async () => {
  await scaffold(async ({ gen, job, deps }) => {
    await gen.run(job);
    assert.equal(deps.submissions.length, 1);
    assert.equal(deps.submissions[0].opts.duration, 10);     // whole clip
  }, { inputs: baseInputs, marks: [], duration: 10 });
});
