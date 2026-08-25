import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { stitchPanels } from '../src/split-panels.js';

async function solid(file, w, h, rgb) {
  await sharp({ create: { width: w, height: h, channels: 3, background: rgb } })
    .png().toFile(file);
}

test('stitchPanels composites 6 panels into the summed 3x2 grid', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'stitch-'));
  // Target cells: cols [20,20,20], rows [10,10] -> canvas 60x20.
  const cells = [
    { w: 20, h: 10 }, { w: 20, h: 10 }, { w: 20, h: 10 },
    { w: 20, h: 10 }, { w: 20, h: 10 }, { w: 20, h: 10 },
  ];
  const paths = [];
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, `p${i}.png`);
    // Deliberately the WRONG size to prove stitch resizes to the cell.
    await solid(f, 7, 3, { r: i * 10, g: 0, b: 0 });
    paths.push(f);
  }
  const out = path.join(dir, 'composite.png');
  await stitchPanels(paths, cells, out);
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 60);
  assert.equal(meta.height, 20);
});

test('stitchPanels rejects a wrong panel count', async () => {
  await assert.rejects(
    () => stitchPanels(['a.png'], [{ w: 1, h: 1 }], 'out.png'),
    /expected 6 panels/,
  );
});
