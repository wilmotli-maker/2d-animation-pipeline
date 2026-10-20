// test/edit-ui-windows.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWindows } from '../src/edit-ui/windows.js';

const only = (r) => planWindows({ regions: r, duration: 10, fps: 24 }).windows;

test('a point region centers a 4s window on it', () => {
  const [w] = only([{ kind: 'point', start: 5, end: 5 }]);
  assert.deepEqual(w.window, [3, 7]);
  assert.deepEqual(w.sourceSpan, [3, 7]);
  assert.deepEqual(w.pad, { start: 0, end: 0 });
  assert.equal(w.clipDuration, 4);
  assert.deepEqual(w.editCenters, [5]);
});

test('a range wider than the minimum keeps its own width', () => {
  const [w] = only([{ kind: 'range', start: 2, end: 8 }]); // span 6 > 4
  assert.deepEqual(w.window, [2, 8]);
  assert.equal(w.clipDuration, 6);
});

test('a range without an anchor centers its edit point on the midpoint', () => {
  const [w] = only([{ kind: 'range', start: 2, end: 8 }]);
  assert.deepEqual(w.editCenters, [5]); // (2+8)/2
});

test('a range anchor sets an off-center edit point inside the window', () => {
  // The marked moment is 6.5s; the user dragged the boundaries to [2,8] so it is off-center.
  const [w] = only([{ kind: 'range', start: 2, end: 8, anchor: 6.5 }]);
  assert.deepEqual(w.window, [2, 8]);            // window still spans the region
  assert.deepEqual(w.editCenters, [6.5]);        // edit point is the anchor, not the midpoint 5
  // gestureOffset the generator derives (center - window[0]) is off-center within the clip:
  assert.equal(w.editCenters[0] - w.window[0], 4.5); // peaks at 4.5s of a 6s clip
});

test('a sub-minimum range with an anchor keeps a centered 4s window but an off-center edit point', () => {
  const [w] = only([{ kind: 'range', start: 4, end: 7, anchor: 4.5 }]); // span 3 < 4
  assert.deepEqual(w.window, [3.5, 7.5]);        // expanded to 4s, centered on the region midpoint 5.5
  assert.equal(w.clipDuration, 4);
  assert.deepEqual(w.editCenters, [4.5]);        // anchor, inside the window
});

test('a region near the start extends past 0 and pads the head, staying centered', () => {
  const [w] = only([{ kind: 'point', start: 1, end: 1 }]); // ideal [-1, 3]
  assert.deepEqual(w.window, [-1, 3]);
  assert.deepEqual(w.sourceSpan, [0, 3]);
  assert.deepEqual(w.pad, { start: 1, end: 0 });
  assert.equal(w.clipDuration, 4);
});

test('a region near the end pads the tail', () => {
  const [w] = only([{ kind: 'point', start: 9, end: 9 }]); // ideal [7, 11], duration 10
  assert.deepEqual(w.window, [7, 11]);
  assert.deepEqual(w.sourceSpan, [7, 10]);
  assert.deepEqual(w.pad, { start: 0, end: 1 });
});

test('overlapping windows merge and union their edit centers', () => {
  const ws = only([{ kind: 'point', start: 5, end: 5 }, { kind: 'point', start: 6, end: 6 }]);
  assert.equal(ws.length, 1);
  assert.deepEqual(ws[0].window, [3, 8]);
  assert.deepEqual(ws[0].editCenters, [5, 6]);
});

test('windows that merely touch still merge', () => {
  // [3,7] and [7,11] touch at 7
  const ws = only([{ kind: 'point', start: 5, end: 5 }, { kind: 'point', start: 9, end: 9 }]);
  assert.equal(ws.length, 1);
  assert.deepEqual(ws[0].window, [3, 11]);
});

test('non-overlapping windows stay separate, ordered by start', () => {
  const ws = only([{ kind: 'point', start: 8, end: 8 }, { kind: 'point', start: 2, end: 2 }]);
  assert.equal(ws.length, 2);
  assert.deepEqual(ws.map((w) => w.window), [[0, 4], [6, 10]]);
});

test('duration shorter than the minimum yields one whole-clip window with pads', () => {
  const ws = planWindows({ regions: [{ kind: 'point', start: 1, end: 1 }], duration: 2, fps: 24 }).windows;
  assert.equal(ws.length, 1);
  assert.deepEqual(ws[0].window, [-1, 3]);
  assert.deepEqual(ws[0].sourceSpan, [0, 2]);
  assert.deepEqual(ws[0].pad, { start: 1, end: 1 });
});

test('no regions yields no windows', () => {
  assert.deepEqual(planWindows({ regions: [], duration: 10, fps: 24 }).windows, []);
});
