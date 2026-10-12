// test/edit-ui-workspace.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composePrompt, createRun, updateRun, listRuns, ensureTranscript } from '../src/edit-ui/workspace.js';

async function withWorkspace(fn) {
  const ws = await mkdtemp(path.join(tmpdir(), 'edit-ws-'));
  const meta = { id: 'abcdef0123456789', name: 'clip.mp4', file: 'source.mp4' };
  await mkdir(path.join(ws, meta.id, 'keyframes'), { recursive: true });
  await writeFile(path.join(ws, meta.id, 'source.mp4'), 'v');
  try { await fn(ws, meta); } finally { await rm(ws, { recursive: true, force: true }); }
}

test('composePrompt puts whole-video prompts first, then marks in timeline order', () => {
  const text = composePrompt({
    fps: 24,
    marks: [{ id: 'b', start: 48, end: 72, label: '' }, { id: 'a', start: 12, end: 12, label: 'Blink' }],
    prompts: [{ markId: 'b', text: 'wave' }, { markId: null, text: 'keep style' }, { markId: 'a', text: 'eyes shut ' }, { markId: 'a', text: '  ' }],
  });
  assert.equal(text, 'keep style\n\n[Blink, frame 12 (0.50s)]\neyes shut\n\n[frames 48–72 (2.00s–3.04s)]\nwave');
});

test('createRun numbers runs, freezes keyframes, and writes a manifest', async () => {
  await withWorkspace(async (ws, meta) => {
    await writeFile(path.join(ws, meta.id, 'keyframes', 'kf.png'), 'png-1');
    const request = {
      fps: 24, marks: [{ id: 'm', start: 3, end: 3 }], prompts: [{ id: 'p', markId: 'm', text: 'smile' }], annotations: [],
      keyframes: [{ frame: 3, time: 0.15, markId: 'm', image: `${meta.id}/keyframes/kf.png` }, { frame: 9, image: '../../etc/passwd' }],
    };
    const r1 = await createRun(ws, meta, { request, generator: 'stub', warnings: ['w'] });
    // The working keyframe changes later; the run's copy must not.
    await writeFile(path.join(ws, meta.id, 'keyframes', 'kf.png'), 'png-2');
    const r2 = await createRun(ws, meta, { request });
    assert.deepEqual([r1.name, r2.name], ['v001', 'v002']);
    assert.equal(await readFile(path.join(r1.dir, 'keyframes', 'edited', 'f0003.png'), 'utf8'), 'png-1');
    assert.equal(await readFile(path.join(r1.dir, 'prompt.txt'), 'utf8'), '[frame 3 (0.13s)]\nsmile\n');
    const m = r1.manifest;
    assert.equal(m.status, 'pending');
    assert.deepEqual(m.warnings, ['w']);
    assert.deepEqual(m.inputs.map((i) => i.role), ['source', 'prompt', 'keyframe']);
    assert.equal(m.keyframes.length, 1, 'path outside the workspace is skipped');
    await updateRun(r1.dir, { status: 'done', output: 'x.mp4' });
    assert.deepEqual((await listRuns(ws, meta.id)).map((x) => [x.run, x.status]), [['v001', 'done'], ['v002', 'pending']]);
  });
});

test('ensureTranscript extracts audio once, transcribes, and caches', async () => {
  await withWorkspace(async (ws, meta) => {
    let extracts = 0; let transcribes = 0;
    const extractAudio = async (_src, out) => { extracts++; await writeFile(out, 'wav'); };
    const transcriber = { async transcribe(p) { transcribes++; assert.match(p, /derived[\\/]audio\.wav$/); return { text: 'hello there' }; } };
    const a = await ensureTranscript(ws, meta, { hasAudio: true, extractAudio, transcriber });
    const b = await ensureTranscript(ws, meta, { hasAudio: true, extractAudio, transcriber });
    assert.equal(a.text, 'hello there');
    assert.deepEqual(b, a);
    assert.deepEqual([extracts, transcribes], [1, 1]);
    assert.equal(await ensureTranscript(ws, { ...meta, id: 'ffffffffffffffff' }, { hasAudio: false }), null);
  });
});
