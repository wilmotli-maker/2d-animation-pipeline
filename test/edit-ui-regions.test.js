// test/edit-ui-regions.test.js
// Unit tests for the edit-ui region/mark model (src/edit-ui/web/regions.js): a region is a range
// mark (the bar), a mark is a frame-mark tick inside it, keyframes/ink live inside by frame. These
// cover the refactor's invariants: non-destructive marking, overlap merge, and selective delete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/edit-ui/web/regions.js';

// 96 frames = 4s @ 24fps; clip long enough that distant marks don't collide at the edges.
const cfg = (lastFrame = 480) => {
  let n = 0;
  return { regionFrames: () => 96, lastFrame: () => lastFrame, uid: (p) => `${p}${++n}` };
};
const D0 = () => ({ marks: [], prompts: [], annotations: [], keyframes: [] });
const regions = (D) => D.marks.filter((m) => m.kind === 'range');
const ticks = (D) => D.marks.filter((m) => m.kind === 'frame');

test('M creates one region with one tick, centered on the frame', () => {
  const c = cfg(); const D = D0();
  const t = R.addMarkAtFrame(D, 100, c);
  assert.equal(regions(D).length, 1);
  assert.equal(ticks(D).length, 1);
  assert.equal(t.kind, 'frame');
  assert.equal(t.start, 100);
  assert.ok(R.inMark(regions(D)[0], 100));
});

test('M at the same frame twice reuses the tick (no duplicate)', () => {
  const c = cfg(); const D = D0();
  R.addMarkAtFrame(D, 100, c);
  R.addMarkAtFrame(D, 100, c);
  assert.equal(ticks(D).length, 1);
  assert.equal(regions(D).length, 1);
});

test('a second M inside the region adds a tick and keeps the first (non-destructive)', () => {
  const c = cfg(); const D = D0();
  const t1 = R.addMarkAtFrame(D, 100, c);
  const t2 = R.addMarkAtFrame(D, 110, c);
  assert.equal(regions(D).length, 1, 'still one region');
  assert.deepEqual(ticks(D).map((t) => t.id).sort(), [t1.id, t2.id].sort());
  const reg = regions(D)[0];
  assert.ok(R.inMark(reg, 100) && R.inMark(reg, 110));
});

test('a second M far away makes a separate region', () => {
  const c = cfg(); const D = D0();
  R.addMarkAtFrame(D, 100, c);
  R.addMarkAtFrame(D, 400, c);
  assert.equal(regions(D).length, 2);
  assert.equal(ticks(D).length, 2);
});

test('overlapping regions merge into one and rehome their content', () => {
  const c = cfg(); const D = D0();
  const A = R.newRegion(D, 52, 148, c);
  const B = R.newRegion(D, 140, 236, c); // overlaps A
  D.prompts.push({ id: 'p1', markId: B.id, text: 'x' });
  D.keyframes.push({ id: 'k1', markId: B.id, frame: 150, versions: [], current: -1 });
  D.annotations.push({ id: 'a1', markId: B.id, frame: 160, strokes: [] });
  R.mergeRegions(D, A.id, c);
  assert.equal(regions(D).length, 1);
  const reg = regions(D)[0];
  assert.equal(reg.id, A.id);
  assert.ok(reg.start <= 52 && reg.end >= 236, 'union span');
  assert.equal(D.prompts[0].markId, A.id);
  assert.equal(D.keyframes[0].markId, A.id);
  assert.equal(D.annotations[0].markId, A.id);
});

test('two regions created ~4s apart merge (same overlap/touch rule as planWindows)', () => {
  const c = cfg(); const D = D0();
  R.addMarkAtFrame(D, 100, c);
  R.addMarkAtFrame(D, 150, c); // within 4s → windows overlap → one region, two ticks
  assert.equal(regions(D).length, 1);
  assert.equal(ticks(D).length, 2);
});

test('addRange (I/O or drag) makes a region plus a tick at its midpoint', () => {
  const c = cfg(); const D = D0();
  const t = R.addRange(D, 60, 200, c);
  assert.equal(regions(D).length, 1);
  assert.equal(t.kind, 'frame');
  assert.equal(t.start, 130);
  assert.ok(R.inMark(regions(D)[0], 130));
});

test('deleting a selected mark removes only that tick; region + siblings + keyframes stay', () => {
  const c = cfg(); const D = D0();
  const t1 = R.addMarkAtFrame(D, 100, c);
  const t2 = R.addMarkAtFrame(D, 120, c);
  const reg = regions(D)[0];
  D.keyframes.push({ id: 'k1', markId: reg.id, frame: 105 });
  R.deleteSelection(D, { sel: t1.id, focus: 'mark' });
  assert.deepEqual(ticks(D).map((t) => t.id), [t2.id]);
  assert.equal(regions(D).length, 1);
  assert.equal(D.keyframes.length, 1);
});

test('deleting a selected region removes it and everything inside', () => {
  const c = cfg(); const D = D0();
  R.addMarkAtFrame(D, 100, c);
  R.addMarkAtFrame(D, 120, c);
  const reg = regions(D)[0];
  D.prompts.push({ id: 'p1', markId: reg.id, text: 'x' });
  D.keyframes.push({ id: 'k1', markId: reg.id, frame: 105 });
  D.annotations.push({ id: 'a1', markId: reg.id, frame: 110, strokes: [] });
  R.deleteSelection(D, { sel: reg.id, focus: 'region' });
  assert.equal(D.marks.length, 0);
  assert.equal(D.prompts.length, 0);
  assert.equal(D.keyframes.length, 0);
  assert.equal(D.annotations.length, 0);
});

test('deleting a selected keyframe removes only it; the (now empty) region remains', () => {
  const c = cfg(); const D = D0();
  R.addMarkAtFrame(D, 100, c);
  const reg = regions(D)[0];
  D.keyframes.push({ id: 'k1', markId: reg.id, frame: 100 });
  R.deleteSelection(D, { sel: reg.id, focus: { kf: 'k1' } });
  assert.equal(D.keyframes.length, 0);
  assert.equal(regions(D).length, 1);
  assert.equal(ticks(D).length, 1);
});

test('deleting a selected ink removes only it', () => {
  const c = cfg(); const D = D0();
  R.addMarkAtFrame(D, 100, c);
  const reg = regions(D)[0];
  D.annotations.push({ id: 'a1', markId: reg.id, frame: 100, strokes: [] });
  D.annotations.push({ id: 'a2', markId: reg.id, frame: 110, strokes: [] });
  R.deleteSelection(D, { sel: reg.id, focus: { ann: 'a1' } });
  assert.deepEqual(D.annotations.map((a) => a.id), ['a2']);
});

test('an empty region is allowed: deleting the last tick leaves the region', () => {
  const c = cfg(); const D = D0();
  const t = R.addMarkAtFrame(D, 100, c);
  R.deleteSelection(D, { sel: t.id, focus: 'mark' });
  assert.equal(ticks(D).length, 0);
  assert.equal(regions(D).length, 1);
});

test('selecting a range mark with mark-focus still deletes the whole region', () => {
  const c = cfg(); const D = D0();
  R.addMarkAtFrame(D, 100, c);
  const reg = regions(D)[0];
  R.deleteSelection(D, { sel: reg.id, focus: 'mark' });
  assert.equal(D.marks.length, 0);
});

test('migrateMarks splits a legacy range anchor into a region plus a frame-mark tick', () => {
  const c = cfg();
  const D = { marks: [{ id: 'm1', kind: 'range', start: 52, end: 148, anchor: 100, label: '' }], prompts: [], annotations: [], keyframes: [] };
  R.migrateMarks(D, c);
  assert.equal(regions(D).length, 1);
  assert.equal(ticks(D).length, 1);
  assert.equal(ticks(D)[0].start, 100);
  assert.ok(!('anchor' in regions(D)[0]));
});

test('clampRegionContents pulls a region\'s keyframes/ink back inside after a resize', () => {
  const c = cfg(); const D = D0();
  const reg = R.newRegion(D, 52, 148, c);
  D.keyframes.push({ id: 'k1', markId: reg.id, frame: 200 }); // now outside
  D.annotations.push({ id: 'a1', markId: reg.id, frame: 10, strokes: [] }); // now outside
  R.clampRegionContents(D, reg, c);
  assert.equal(D.keyframes[0].frame, 148);
  assert.equal(D.annotations[0].frame, 52);
});

test('regionContents reports ticks, keyframes and ink by frame position', () => {
  const c = cfg(); const D = D0();
  const reg = R.newRegion(D, 52, 148, c);
  R.newFrameMark(D, 100, c);
  R.newFrameMark(D, 300, c); // outside region
  D.keyframes.push({ id: 'k1', markId: reg.id, frame: 110 });
  D.annotations.push({ id: 'a1', markId: reg.id, frame: 120, strokes: [] });
  const con = R.regionContents(D, reg);
  assert.equal(con.marks.length, 1);
  assert.equal(con.marks[0].start, 100);
  assert.equal(con.keyframes.length, 1);
  assert.equal(con.annotations.length, 1);
});
