import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { splitPanels, TURNAROUND_PANELS, POSE_PANELS } from '../src/split-panels.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'split-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// A minimal stand-in for sharp: records extract regions and writes a stub file.
function fakeSharp(recorded, { width, height }) {
  return (input) => ({
    metadata: async () => ({ width, height }),
    extract(region) { this._region = region; return this; },
    async toFile(out) { recorded.push({ input, region: this._region, out }); await writeFile(out, 'PANEL'); },
  });
}

test('splitPanels writes six named panels into outDir in grid order', async () => {
  await withTemp(async (dir) => {
    const recorded = [];
    const outDir = path.join(dir, 'v001');
    const paths = await splitPanels(path.join(dir, 'v001.png'), outDir, TURNAROUND_PANELS, {
      sharpImpl: fakeSharp(recorded, { width: 900, height: 600 }),
    });

    assert.deepEqual(
      paths.map((p) => path.basename(p)),
      ['01-front.png', '02-three-quarter-front.png', '03-side.png',
        '04-three-quarter-rear.png', '05-rear.png', '06-face-closeup.png'],
    );
    // Files actually written to the panels folder.
    assert.deepEqual((await readdir(outDir)).sort(), paths.map((p) => path.basename(p)).sort());
  });
});

test('splitPanels writes generic panel names for a pose sheet', async () => {
  await withTemp(async (dir) => {
    const recorded = [];
    const outDir = path.join(dir, 'v001');
    const paths = await splitPanels(path.join(dir, 'v001.png'), outDir, POSE_PANELS, {
      sharpImpl: fakeSharp(recorded, { width: 900, height: 600 }),
    });
    assert.deepEqual(
      paths.map((p) => path.basename(p)),
      ['panel-1.png', 'panel-2.png', 'panel-3.png', 'panel-4.png', 'panel-5.png', 'panel-6.png'],
    );
  });
});

test('splitPanels crops an even 3×2 grid with no lost edge pixels', async () => {
  await withTemp(async (dir) => {
    const recorded = [];
    // 901×601 stresses the rounding remainder: last col/row absorbs the +1.
    await splitPanels(path.join(dir, 'v001.png'), path.join(dir, 'v001'), TURNAROUND_PANELS, {
      sharpImpl: fakeSharp(recorded, { width: 901, height: 601 }),
    });

    const regions = recorded.map((r) => r.region);
    // colW=300, rowH=300. Panel 1 top-left, panel 6 bottom-right.
    assert.deepEqual(regions[0], { left: 0, top: 0, width: 300, height: 300 });
    assert.deepEqual(regions[2], { left: 600, top: 0, width: 301, height: 300 }); // top-right absorbs +1 width
    assert.deepEqual(regions[3], { left: 0, top: 300, width: 300, height: 301 }); // bottom-left absorbs +1 height
    assert.deepEqual(regions[5], { left: 600, top: 300, width: 301, height: 301 }); // bottom-right absorbs both

    // Columns tile the full width, rows tile the full height — no gaps/overlap.
    const covers = (a, len) => a.reduce((s, r) => s + r, 0) === len;
    assert.ok(covers([regions[0].width, regions[1].width, regions[2].width], 901));
    assert.ok(covers([regions[0].height, regions[3].height], 601));
  });
});

test('splitPanels throws when the image has no readable dimensions', async () => {
  await withTemp(async (dir) => {
    const badSharp = () => ({ metadata: async () => ({}), extract() { return this; }, async toFile() {} });
    await assert.rejects(
      () => splitPanels(path.join(dir, 'x.png'), dir, TURNAROUND_PANELS, { sharpImpl: badSharp }),
      /cannot read image dimensions/,
    );
  });
});
