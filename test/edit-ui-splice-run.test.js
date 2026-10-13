// test/edit-ui-splice-run.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSpliceRunner } from '../src/edit-ui/splice-run.js';

const ID = '0123456789abcdef';

async function scaffold(fn, windows, { duration = 12, fps = 24 } = {}) {
  const ws = await mkdtemp(path.join(tmpdir(), 'splice-'));
  const runDir = path.join(ws, ID, 'runs', 'v001');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(ws, ID, 'source.mp4'), 'v');
  for (const w of windows) {
    await mkdir(path.join(runDir, 'windows', w.name), { recursive: true });
    if (w.output) await writeFile(path.join(runDir, 'windows', w.name, 'out.mp4'), 'g');
  }
  const manifest = { run: 'v001', kind: 'video', source: { id: ID, file: 'source.mp4', duration, fps }, windows, inputs: [], warnings: [] };
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));
  const spliceCalls = []; const ff = [];
  const runner = createSpliceRunner({
    ffmpeg: async (a) => { ff.push(a); },
    ffprobe: async () => '560,752',
    splice: async (o) => { spliceCalls.push(o); await writeFile(o.out, 's'); return { output: o.out, seam: o.seam }; },
  });
  const meta = { id: ID, file: 'source.mp4' };
  try { return await fn({ ws, runDir, runner, meta, manifest, spliceCalls, ff }); } finally { await rm(ws, { recursive: true, force: true }); }
}

const win = (name, s, e, pad, editCenter) => ({
  name, window: [s - pad.start, e + pad.end], sourceSpan: [s, e], pad,
  clipDuration: (e + pad.end) - (s - pad.start), editCenters: [editCenter], status: 'done',
  output: `${ID}/runs/v001/windows/${name}/out.mp4`,
});

test('a single interior window de-pads and splices with seam mid', async () => {
  await scaffold(async ({ ws, runner, meta, manifest, runDir, spliceCalls, ff }) => {
    const res = await runner(ws, meta, manifest);
    assert.equal(spliceCalls.length, 1);
    assert.equal(spliceCalls[0].seam, 'mid');
    assert.equal(spliceCalls[0].edit, 6);
    assert.ok(ff.some((a) => a.join(' ').includes('splice-src.mp4')), 'de-pad ffmpeg ran');
    assert.match(res.output, /spliced\.mp4$/);
    const m = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
    assert.ok(m.spliced && m.spliced.output);
  }, [win('w01', 4, 8, { start: 0, end: 0 }, 6)]);
});

test('seam comes from pad: head when pad.start>0, tail when pad.end>0 (right-to-left)', async () => {
  await scaffold(async ({ ws, runner, meta, manifest, spliceCalls }) => {
    await runner(ws, meta, manifest);
    assert.deepEqual(spliceCalls.map((c) => c.seam), ['tail', 'head']); // w02 (right) first
  }, [win('w01', 0, 3, { start: 1, end: 0 }, 1), win('w02', 9, 12, { start: 0, end: 1 }, 11)]);
});

test('a window covering the whole source short-circuits to de-pad (no splice call)', async () => {
  await scaffold(async ({ ws, runner, meta, manifest, spliceCalls }) => {
    await runner(ws, meta, manifest);
    assert.equal(spliceCalls.length, 0, 'no seam matching for a whole-clip window');
  }, [win('w01', 0, 12, { start: 1, end: 1 }, 6)]);
});

test('two windows splice right-to-left, the left into the right output', async () => {
  await scaffold(async ({ ws, runner, meta, manifest, spliceCalls }) => {
    await runner(ws, meta, manifest);
    assert.equal(spliceCalls.length, 2);
    assert.equal(spliceCalls[0].edit, 9);                      // right window first
    assert.equal(spliceCalls[1].edit, 3);                      // then left
    assert.equal(spliceCalls[1].orig, spliceCalls[0].out);     // left splices into right's output
  }, [win('w01', 1, 5, { start: 0, end: 0 }, 3), win('w02', 7, 11, { start: 0, end: 0 }, 9)]);
});

test('a run with no usable windows throws', async () => {
  await scaffold(async ({ ws, runner, meta, manifest }) => {
    await assert.rejects(() => runner(ws, meta, manifest), /no .*window/i);
  }, [{ name: 'w01', status: 'error', output: null, window: [0, 4], sourceSpan: [0, 4], pad: { start: 0, end: 0 }, clipDuration: 4, editCenters: [2] }]);
});
