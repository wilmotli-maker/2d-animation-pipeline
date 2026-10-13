// test/edit-ui-splice.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mad, warp, findPairs } from '../src/edit-ui/splice.js';

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
