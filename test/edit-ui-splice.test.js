// test/edit-ui-splice.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mad, warp, findPairs, buildSpliceFilter, spliceClip, segmentPlan, morphJoinFilter, segmentRenderArgs, flowModeForSeam, resolveMorphEngine } from '../src/edit-ui/splice.js';

const PP = { inPt: { i: 24, j: 20 }, outPt: { i: 72, j: 60 }, origLen: 96, genLen: 96 };

test('segmentPlan for a mid seam = orig head + gen mid + orig tail', () => {
  const segs = segmentPlan({ seam: 'mid', retime: false, ...PP });
  assert.deepEqual(segs, [
    { src: 'orig', from: 0, to: 24, retimeTo: null },
    { src: 'gen', from: 20, to: 61, retimeTo: null },
    { src: 'orig', from: 73, to: 96, retimeTo: null },
  ]);
});

test('segmentPlan retime sets the mid target frame count to the original span length', () => {
  const segs = segmentPlan({ seam: 'mid', retime: true, ...PP });
  assert.equal(segs[1].retimeTo, 48); // spanEnd(72) - spanStart(24)
});

test('segmentPlan head seam drops the head, tail seam drops the tail', () => {
  assert.deepEqual(segmentPlan({ seam: 'head', retime: false, ...PP }).map((s) => s.src), ['gen', 'orig']);
  assert.deepEqual(segmentPlan({ seam: 'tail', retime: false, ...PP }).map((s) => s.src), ['orig', 'gen']);
});

test('morphJoinFilter inserts a minterpolate motion morph between the two clips', () => {
  const { filter, map } = morphJoinFilter({ leftFrames: 24, morph: 6, fps: 24 });
  assert.equal(map, '[v]');
  assert.match(filter, /minterpolate=/);
  assert.match(filter, /mi_mode=mci/);
  assert.match(filter, /trim=start_frame=23:end_frame=24/); // left's last frame
  assert.match(filter, /concat=n=3/);                        // left-rest + morph + right-rest
});

test('segmentRenderArgs trims the frame range; retime stretches to the target count', () => {
  const plain = segmentRenderArgs({ src: 'orig', from: 0, to: 24, retimeTo: null }, { orig: 'o.mp4', gen: 'g.mp4', fps: 24, out: 's.mp4' });
  assert.match(plain.join(' '), /-i o\.mp4/);
  assert.match(plain.join(' '), /trim=start_frame=0:end_frame=24/);
  const retimed = segmentRenderArgs({ src: 'gen', from: 20, to: 60, retimeTo: 48 }, { orig: 'o.mp4', gen: 'g.mp4', fps: 24, out: 'm.mp4' });
  assert.match(retimed.join(' '), /-i g\.mp4/);
  assert.match(retimed.join(' '), /setpts=1\.2000\*/); // 48/(60-20)=1.2
});

const W = 4, H = 4;
const frame = (fill) => Uint8Array.from({ length: W * H }, () => fill);

test('mad is the mean absolute difference', () => {
  assert.equal(mad(Uint8Array.from([0, 0, 10, 10]), Uint8Array.from([0, 10, 10, 20])), (0 + 10 + 0 + 10) / 4);
});

test('warp returns the same buffer for the identity transform (fast path)', () => {
  const src = frame(50);
  assert.equal(warp(src, { tx: 0, ty: 0, s: 1, rot: 0 }, { W, H }), src);
});

test('warp by a whole-pixel translation shifts content', () => {
  const src = new Uint8Array(W * H); src[1 * W + 1] = 200;
  const out = warp(src, { tx: 1, ty: 0, s: 1, rot: 0 }, { W, H });
  assert.ok(out[1 * W + 2] > 100, 'bright pixel moved one column right');
});

test('findPairs picks the orig/gen frames that match, within the search ranges', () => {
  const O = [0, 40, 80, 120, 160, 200].map(frame);
  const G = [0, 40, 80, 120, 160, 200].map(frame);
  const { inPt, outPt } = findPairs(O, G, { inRange: [0, 0.5], outRange: [0.5, 0.9], fps: 6, shift: 0.5, offsetPenalty: 1.5 });
  assert.equal(inPt.i, inPt.j);
  assert.equal(outPt.i, outPt.j);
  assert.ok(outPt.i > inPt.i);
});

test('findPairs honors genOffset: gen frame j maps to orig frame j+offset', () => {
  // orig 20 frames; gen 7 frames where G[j] === O[j+10]. Out-range (orig 14..16) has NO gen
  // frame within ±shift of i unless the offset re-centers the gen search — this fails without it.
  const O = Array.from({ length: 20 }, (_, i) => frame(i * 12));
  const G = Array.from({ length: 7 }, (_, j) => frame((j + 10) * 12));
  const r = findPairs(O, G, { inRange: [11, 13], outRange: [14, 16], fps: 1, shift: 3, genOffset: 10 });
  assert.equal(r.inPt.i - r.inPt.j, 10);
  assert.equal(r.outPt.i - r.outPt.j, 10);
});

const pts = { inPt: { i: 24, j: 24 }, outPt: { i: 72, j: 72 } };

test('mid hard-cut keeps both original sides and concats three segments', () => {
  const { filter, expectedOutputFrames } = buildSpliceFilter({ seam: 'mid', blend: 0, retime: false, ...pts, origLen: 96, genLen: 96, fps: 24 });
  assert.match(filter, /concat=n=3:v=1:a=0/);
  assert.match(filter, /trim=end_frame=24/);
  assert.match(filter, /trim=start_frame=73/);
  assert.equal(expectedOutputFrames, 24 + (72 - 24) + (96 - 72 - 1));
});

test('head seam drops the original head (one out-seam) and keeps the tail', () => {
  const { filter } = buildSpliceFilter({ seam: 'head', blend: 0, retime: false, ...pts, origLen: 96, genLen: 96, fps: 24 });
  assert.match(filter, /concat=n=2:v=1:a=0/);
  assert.doesNotMatch(filter, /\[s1\]/);
});

test('tail seam keeps the original head and drops the tail', () => {
  const { filter } = buildSpliceFilter({ seam: 'tail', blend: 0, retime: false, ...pts, origLen: 96, genLen: 96, fps: 24 });
  assert.match(filter, /concat=n=2:v=1:a=0/);
  assert.doesNotMatch(filter, /\[s3\]/);
});

test('buildSpliceFilter is video-only (maps [v]); audio is handled by the orchestrator', () => {
  const { filter, maps } = buildSpliceFilter({ seam: 'mid', blend: 0, retime: false, ...pts, origLen: 96, genLen: 96, fps: 24 });
  assert.deepEqual(maps, ['[v]']);
  assert.doesNotMatch(filter, /\[0:a\]|concat=n=\d+:v=0:a=1/);
});

test('a positive blend produces an xfade graph for a mid edit', () => {
  const { filter } = buildSpliceFilter({ seam: 'mid', blend: 4, retime: false, ...pts, origLen: 96, genLen: 96, fps: 24 });
  assert.match(filter, /xfade=transition=fade/);
});

test('retime stretches the gen segment to the original span length', () => {
  const { k } = buildSpliceFilter({ seam: 'mid', blend: 0, retime: true, inPt: { i: 24, j: 20 }, outPt: { i: 72, j: 60 }, origLen: 96, genLen: 96, fps: 24 });
  assert.ok(Math.abs(k - (72 - 24) / (60 - 20)) < 1e-9);
});

const W2 = 4, H2 = 4;
const gray = (v) => Uint8Array.from({ length: W2 * H2 }, () => v);
const FR = [0, 30, 60, 90, 120, 150, 180, 210].map(gray);

function fakeDeps() {
  const calls = [];
  return {
    calls,
    ffmpeg: async (args) => { calls.push(args); },
    ffmpegOut: async () => Buffer.from([0, 0, 0]),
    ffprobe: async () => '560,752',
    decode: async () => FR,
  };
}

test('spliceClip finds pairs and renders a splice (align none)', async () => {
  const d = fakeDeps();
  const rep = await spliceClip({ orig: 'o.mp4', gen: 'g.mp4', out: 'out.mp4', edit: 0.5, seam: 'mid',
    align: 'none', fps: 8, size: { W: W2, H: H2 }, inRange: [0.1, 0.5], outRange: [0.5, 0.9] }, d);
  assert.ok(rep.inPoint && rep.outPoint);
  assert.ok(rep.outPoint.genFrame > rep.inPoint.genFrame);
  const last = d.calls.at(-1).join(' ');
  assert.match(last, /filter_complex/);
  assert.match(last, /out\.mp4/);
});

test('with source audio, spliceClip muxes the ORIGINAL audio and retimes the middle', async () => {
  const d = fakeDeps();
  const rep = await spliceClip({ orig: 'o.mp4', gen: 'g.mp4', out: 'out.mp4', edit: 0.5, seam: 'mid',
    align: 'none', fps: 8, size: { W: W2, H: H2 }, inRange: [0.1, 0.5], outRange: [0.5, 0.9], audio: true }, d);
  const last = d.calls.at(-1).join(' ');
  assert.match(last, /-map 0:a\?/);           // original audio stream, not a filtered one
  assert.match(last, /-c:a aac/);
  assert.doesNotMatch(last, /concat=n=\d+:v=0:a=1/); // no generated-audio splice
  assert.equal(rep.audio, true);
  assert.equal(rep.retime, true);             // middle retimed so length == source, audio aligns
});

test('with no source audio, spliceClip stays video-only and does not force retime', async () => {
  const d = fakeDeps();
  const rep = await spliceClip({ orig: 'o.mp4', gen: 'g.mp4', out: 'out.mp4', edit: 0.5, seam: 'mid',
    align: 'none', fps: 8, size: { W: W2, H: H2 }, inRange: [0.1, 0.5], outRange: [0.5, 0.9], audio: false }, d);
  const last = d.calls.at(-1).join(' ');
  assert.doesNotMatch(last, /-map 0:a/);
  assert.equal(rep.audio, false);
  assert.equal(rep.retime, false);
});

test('spliceClip morph>0 (minterpolate engine) renders segments, morph-joins them, and muxes audio', async () => {
  const d = fakeDeps();
  const rep = await spliceClip({ orig: 'o.mp4', gen: 'g.mp4', out: 'out.mp4', edit: 0.5, seam: 'mid',
    align: 'none', fps: 8, size: { W: W2, H: H2 }, inRange: [0.1, 0.5], outRange: [0.5, 0.9], audio: true, morph: 4, morphEngine: 'minterpolate' }, d);
  const cmds = d.calls.map((a) => a.join(' '));
  assert.ok(cmds.some((c) => /-seg0\.mp4/.test(c)) && cmds.some((c) => /-seg2\.mp4/.test(c)), '3 segments rendered');
  assert.ok(cmds.some((c) => /minterpolate=.*mi_mode=mci/.test(c)), 'morph join used');
  assert.ok(cmds.at(-1).includes('-map 1:a?') || d.calls.at(-1).join(' ').includes('1:a?'), 'final mux maps original audio');
  assert.equal(rep.morph, 4);
  assert.equal(rep.segments, 3);
  assert.equal(rep.morphEngine, 'minterpolate');
});

test('spliceClip morph>0 defaults to the flow engine and warps the source side at each seam', async () => {
  const d = fakeDeps();
  const joins = [];
  d.joinSeam = async ({ left, right, out, mode }) => { joins.push({ left, right, out, mode }); return { out }; };
  const rep = await spliceClip({ orig: 'o.mp4', gen: 'g.mp4', out: 'out.mp4', edit: 0.5, seam: 'mid',
    align: 'none', fps: 8, size: { W: W2, H: H2 }, inRange: [0.1, 0.5], outRange: [0.5, 0.9], audio: true, morph: 4 }, d);
  assert.equal(rep.morphEngine, 'flow');
  // mid seam segments = [orig, gen, orig]: head join warps the left (source head), tail join the right (source tail).
  assert.deepEqual(joins.map((j) => j.mode), ['one-sided-left', 'one-sided-right']);
  assert.deepEqual(rep.joins.map((j) => j.mode), ['one-sided-left', 'one-sided-right']);
  const cmds = d.calls.map((a) => a.join(' '));
  assert.ok(!cmds.some((c) => /minterpolate=/.test(c)), 'flow engine does not use minterpolate');
});

test('flowModeForSeam warps whichever side is the source; resolveMorphEngine defaults to flow', () => {
  assert.equal(flowModeForSeam('orig', 'gen'), 'one-sided-left');
  assert.equal(flowModeForSeam('gen', 'orig'), 'one-sided-right');
  assert.equal(flowModeForSeam('gen', 'gen'), 'balanced');
  const saved = process.env.EDIT_UI_MORPH; delete process.env.EDIT_UI_MORPH;
  try {
    assert.equal(resolveMorphEngine(), 'flow');
    assert.equal(resolveMorphEngine('minterpolate'), 'minterpolate');
    process.env.EDIT_UI_MORPH = 'minterpolate';
    assert.equal(resolveMorphEngine(), 'minterpolate');          // env fallback
  } finally { if (saved === undefined) delete process.env.EDIT_UI_MORPH; else process.env.EDIT_UI_MORPH = saved; }
  assert.throws(() => resolveMorphEngine('bogus'), /unknown morphEngine/);
});

test('spliceClip throws when no valid in/out points (out not after in)', async () => {
  const d = fakeDeps();
  await assert.rejects(() => spliceClip({ orig: 'o.mp4', gen: 'g.mp4', out: 'out.mp4', edit: 0.5, seam: 'mid',
    align: 'none', fps: 8, size: { W: W2, H: H2 }, inRange: [0.5, 0.9], outRange: [0.1, 0.4] }, d), /widen/i);
});
