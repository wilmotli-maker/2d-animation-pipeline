// test/edit-ui-splice.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mad, warp, findPairs, buildSpliceFilter, spliceClip } from '../src/edit-ui/splice.js';

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

test('spliceClip throws when no valid in/out points (out not after in)', async () => {
  const d = fakeDeps();
  await assert.rejects(() => spliceClip({ orig: 'o.mp4', gen: 'g.mp4', out: 'out.mp4', edit: 0.5, seam: 'mid',
    align: 'none', fps: 8, size: { W: W2, H: H2 }, inRange: [0.5, 0.9], outRange: [0.1, 0.4] }, d), /widen/i);
});
