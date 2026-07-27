import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { splitPanels, backfillPanels, TURNAROUND_PANELS, POSE_PANELS } from '../src/split-panels.js';
import { createElement } from '../src/element.js';
import { sheetInstanceDir } from '../src/paths.js';

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

// A splitPanels stand-in for backfill tests: records calls, writes stub panels.
function recordingSplit(recorded) {
  return async (image, outDir, labels) => {
    recorded.push({ image, outDir, labels });
    await mkdir(outDir, { recursive: true });
    const out = [];
    for (const l of labels) { const p = path.join(outDir, `${l}.png`); await writeFile(p, 'PANEL'); out.push(p); }
    return out;
  };
}

// Write a fake generated sheet image (and its prompt snapshot) into an instance.
async function seedSheet(root, name, sheet, slug, vtag = 'v001') {
  await createElement(root, { type: 'characters', name }).catch(() => {}); // ok if it exists
  const dir = sheetInstanceDir(root, 'characters', name, sheet, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${vtag}.png`), 'BYTES');
  await writeFile(path.join(dir, `${vtag}.prompt.md`), 'prompt');
  return dir;
}

test('backfillPanels splits sheets missing a folder and skips ones already split', async () => {
  await withTemp(async (root) => {
    const a = await seedSheet(root, 'cecilia', 'turnaround', 'winter');
    const b = await seedSheet(root, 'cecilia', 'pose', 'combat');
    // 'winter' already has a panel folder -> should be skipped.
    await mkdir(path.join(a, 'v001'), { recursive: true });

    const recorded = [];
    const results = await backfillPanels(root, {}, { splitPanels: recordingSplit(recorded) });

    // Only the pose sheet gets split.
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].image, path.join(b, 'v001.png'));
    assert.deepEqual(recorded[0].labels, POSE_PANELS);
    assert.deepEqual(
      (await readdir(path.join(b, 'v001'))).sort(),
      POSE_PANELS.map((l) => `${l}.png`).sort(),
    );

    const split = results.filter((r) => r.status === 'split');
    const skipped = results.filter((r) => r.status === 'skipped');
    assert.equal(split.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].image, path.join(a, 'v001.png'));
  });
});

test('backfillPanels ignores cycles sheets and non-image files', async () => {
  await withTemp(async (root) => {
    await seedSheet(root, 'cecilia', 'cycles', 'walk');
    const recorded = [];
    const results = await backfillPanels(root, {}, { splitPanels: recordingSplit(recorded) });
    assert.equal(recorded.length, 0);
    assert.equal(results.length, 0); // cycles never enters the splittable set
  });
});

test('backfillPanels narrows the scan by filter', async () => {
  await withTemp(async (root) => {
    await seedSheet(root, 'cecilia', 'turnaround', 'winter');
    await seedSheet(root, 'cecilia', 'turnaround', 'summer');
    await seedSheet(root, 'darius', 'turnaround', 'winter');

    const recorded = [];
    await backfillPanels(root, { name: 'cecilia', id: 'winter' }, { splitPanels: recordingSplit(recorded) });

    assert.equal(recorded.length, 1);
    assert.match(recorded[0].image, /characters\/cecilia\/sheets\/turnaround\/winter\/v001\.png$/);
  });
});

test('backfillPanels handles multiple versions in one instance', async () => {
  await withTemp(async (root) => {
    const dir = await seedSheet(root, 'cecilia', 'turnaround', 'winter', 'v001');
    await writeFile(path.join(dir, 'v002.png'), 'BYTES');
    await writeFile(path.join(dir, 'v002.prompt.md'), 'p');
    await mkdir(path.join(dir, 'v001'), { recursive: true }); // v001 already split

    const recorded = [];
    const results = await backfillPanels(root, {}, { splitPanels: recordingSplit(recorded) });

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].image, path.join(dir, 'v002.png'));
    assert.equal(results.filter((r) => r.status === 'split').length, 1);
    assert.equal(results.filter((r) => r.status === 'skipped').length, 1);
  });
});
