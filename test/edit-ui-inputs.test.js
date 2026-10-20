// test/edit-ui-inputs.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';
import { sampleFrameIndices, nearestAspect, strokesSvg, prepareRunInputs, extractFrame, renderAnnotationImages } from '../src/edit-ui/inputs.js';
import { createRun, composePrompt, resolveDialogue } from '../src/edit-ui/workspace.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

async function withRun(fn, request = {}, derived = {}) {
  const ws = await mkdtemp(path.join(tmpdir(), 'edit-inputs-'));
  const meta = { id: '0123456789abcdef', name: 'c.mp4', file: 'source.mp4' };
  await mkdir(path.join(ws, meta.id), { recursive: true });
  try {
    const run = await createRun(ws, meta, { request: { fps: 24, marks: [], prompts: [], ...request }, derived });
    await fn(ws, run);
  } finally { await rm(ws, { recursive: true, force: true }); }
}

test('sampleFrameIndices spreads evenly, includes first and last, never repeats', () => {
  assert.deepEqual(sampleFrameIndices(100, 5), [0, 25, 50, 74, 99]);
  assert.deepEqual(sampleFrameIndices(100, 1), [0]);
  assert.deepEqual(sampleFrameIndices(3, 8), [0, 1, 2]);
  assert.deepEqual(sampleFrameIndices(0, 4), []);
  assert.deepEqual(sampleFrameIndices(50, 0), []);
});

test('nearestAspect picks the closest supported shape', () => {
  assert.equal(nearestAspect(1920, 1080), '16:9');
  assert.equal(nearestAspect(1080, 1920), '9:16');
  assert.equal(nearestAspect(1000, 1000), '1:1');
  assert.equal(nearestAspect(720, 960), '3:4');
  assert.equal(nearestAspect(null, null), '16:9');
});

test('strokesSvg scales points and pen width, and refuses odd colours', () => {
  const svg = strokesSvg([{ color: '#112233', width: 10, pts: [[0.5, 0.5], [1, 1]] }, { color: 'red" onload="x', width: 5, pts: [[0, 0]] }], 2000, 1000);
  assert.match(svg, /M1000\.0 500\.0 L2000\.0 1000\.0/);
  assert.match(svg, /stroke="#112233" stroke-width="20\.00"/);
  assert.doesNotMatch(svg, /onload/);
});

test('dialogue: edited text wins, can be excluded, and lands in the prompt', () => {
  const raw = { text: 'Hello Myra', engine: 'whisper' };
  assert.deepEqual(resolveDialogue({}, raw), { text: 'Hello Myra', include: true, edited: false });
  assert.deepEqual(resolveDialogue({ transcript: { text: 'Hello Mira', include: true } }, raw), { text: 'Hello Mira', include: true, edited: true });
  assert.equal(resolveDialogue({ transcript: { text: 'x', include: false } }, raw).include, false);
  assert.equal(resolveDialogue({}, null).include, false);
  assert.match(composePrompt({ dialogue: 'Hello Mira' }), /^Dialogue \(spoken word for word, exactly as written\): "Hello Mira"$/);
});

test('prepareRunInputs records speechref, auto keyframes (skipping edited frames) and annotations', async () => {
  const made = [];
  const tools = {
    speechRef: async (wav, out, o) => { made.push(['speech', wav, o.aspect]); await writeFile(out, 's'); },
    frame: async (_v, t, out) => { made.push(['frame', +t.toFixed(3)]); await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, 'f'); },
    annotate: async (_src, strokes, base) => { made.push(['annotate', strokes.length]); await writeFile(`${base}.png`, 'a'); await writeFile(`${base}-strokes.png`, 'b'); return { withFrame: `${base}.png`, only: `${base}-strokes.png` }; },
  };
  const request = {
    fps: 24, autoKeyframes: 3, keyframes: [{ frame: 99 }],
    annotations: [{ frame: 10, strokes: [{ color: '#fff', width: 5, pts: [[0, 0]] }] }, { frame: 10, strokes: [{ color: '#000', width: 5, pts: [[1, 1]] }] }, { frame: 20, strokes: [] }],
  };
  await withRun(async (ws, run) => {
    const m = await prepareRunInputs(ws, run, {
      videoPath: '/v.mp4', probe: { fps: 24, frames: 100, duration: 100 / 24, width: 1280, height: 720 }, request, derived: { audio: '/a.wav' }, tools,
    });
    const roles = m.inputs.map((i) => `${i.role}${i.kind ? `:${i.kind}` : ''}`);
    assert.deepEqual(roles, ['source', 'audio', 'prompt', 'speechref', 'keyframe:auto', 'keyframe:auto', 'annotation:frame', 'annotation:strokes']);
    assert.deepEqual(m.autoKeyframes.map((k) => k.frame), [0, 50], 'frame 99 already has an edited keyframe');
    assert.deepEqual(m.annotationImages.map((k) => k.frame), [10, 10]);
    assert.ok(made.some((x) => x[0] === 'annotate' && x[1] === 2), 'both strokes on frame 10 are merged');
    assert.deepEqual(made[0], ['speech', '/a.wav', '16:9']);
    assert.deepEqual(m.window, { start: 0, end: 100 / 24 });
    assert.deepEqual(m.warnings, []);
  }, request, { audio: '/a.wav' });
});

test('prepareRunInputs does NOT add edited keyframe inputs (createRun owns them — avoid double refs)', async () => {
  // Regression: edited keyframes are frozen by createRun. If prepareRunInputs also added them, each
  // keyframe would be referenced twice (two poses at one time → an extra @ImageN, clip ends on the
  // keyframe pose, not the end frame). The image here doesn't exist, so createRun makes none either;
  // the point is that prepareRunInputs contributes zero.
  const tools = { speechRef: async () => {}, frame: async () => {}, annotate: async () => {} };
  const request = { fps: 24, autoKeyframes: 0, keyframes: [{ frame: 48, time: 2.0, image: 'vid123/keyframes/upload-abc.png' }] };
  await withRun(async (ws, run) => {
    const m = await prepareRunInputs(ws, run, {
      videoPath: '/v.mp4', probe: { fps: 24, frames: 100, duration: 100 / 24, width: 1280, height: 720 }, request, derived: {}, tools,
    });
    assert.equal(m.inputs.filter((i) => i.role === 'keyframe' && i.kind === 'edited').length, 0);
  }, request);
});

test('with autoKeyframes 0 (the seedance-draft default) no auto keyframes are generated', async () => {
  const made = [];
  const tools = {
    speechRef: async (wav, out) => { await writeFile(out, 's'); },
    frame: async (_v, t, out) => { made.push(+t.toFixed(3)); await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, 'f'); },
    annotate: async () => ({ withFrame: '/x.png', only: '/y.png' }),
  };
  const request = { fps: 24, autoKeyframes: 0 };
  await withRun(async (ws, run) => {
    const m = await prepareRunInputs(ws, run, {
      videoPath: '/v.mp4', probe: { fps: 24, frames: 100, duration: 100 / 24, width: 1280, height: 720 }, request, derived: { audio: '/a.wav' }, tools,
    });
    assert.deepEqual(m.autoKeyframes, []);
    assert.ok(!m.inputs.some((i) => i.role === 'keyframe' && i.kind === 'auto'), 'no keyframe:auto inputs');
    assert.deepEqual(made, [], 'no source frames were extracted for auto keyframes');
  }, request, { audio: '/a.wav' });
});

test('a failing media tool becomes a warning, not a failed run', async () => {
  const tools = {
    speechRef: async () => { throw new Error('no ffmpeg'); },
    frame: async () => { throw new Error('boom'); },
    annotate: async () => { throw new Error('unused'); },
  };
  await withRun(async (ws, run) => {
    const m = await prepareRunInputs(ws, run, { videoPath: '/v', probe: { fps: 24, frames: 10 }, request: { fps: 24, autoKeyframes: 2, annotations: [{ frame: 1, strokes: [{ pts: [[0, 0]] }] }] }, derived: { audio: '/a.wav' }, tools });
    assert.equal(m.warnings.length, 4);
    assert.match(m.warnings[0], /speech reference unavailable: no ffmpeg/);
    assert.deepEqual(m.inputs.map((i) => i.role), ['source', 'prompt']);
  });
});

test('annotation rendering produces a frame composite and a transparent strokes layer', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edit-ann-'));
  try {
    const src = path.join(dir, 'f.png');
    await sharp({ create: { width: 200, height: 100, channels: 3, background: '#0000ff' } }).png().toFile(src);
    const { withFrame, only } = await renderAnnotationImages(src, [{ color: '#ff0000', width: 50, pts: [[0, 0.5], [1, 0.5]] }], path.join(dir, 'f0001'));
    const px = async (f, x, y) => { const { data, info } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); const i = (y * info.width + x) * 4; return [...data.slice(i, i + 4)]; };
    assert.deepEqual(await px(withFrame, 100, 50), [255, 0, 0, 255], 'stroke is drawn over the frame');
    assert.deepEqual(await px(withFrame, 100, 5), [0, 0, 255, 255], 'frame shows elsewhere');
    assert.deepEqual(await px(only, 100, 50), [255, 0, 0, 255]);
    assert.equal((await px(only, 100, 5))[3], 0, 'strokes layer is transparent elsewhere');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('extractFrame grabs the requested frame with real ffmpeg', { skip: !hasFfmpeg && 'ffmpeg not on PATH' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edit-frame-'));
  try {
    const vid = path.join(dir, 'v.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:r=24:d=1', '-pix_fmt', 'yuv420p', vid]);
    const out = await extractFrame(vid, 0.5, path.join(dir, 'sub', 'f.png'));
    const meta = await sharp(out).metadata();
    assert.deepEqual([meta.width, meta.height], [64, 48]);
    assert.ok((await stat(out)).size > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
