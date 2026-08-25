import path from 'node:path';
import { mkdir, readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { sheetDir, sheetInstanceDir } from './paths.js';

// A turnaround is composed as one 16:9 sheet in a fixed 3×2 grid (see the
// director's Mode 2A). These are the six angles in that reading order — top row
// left→right, then bottom row. The numeric prefix keeps the folder ordered; the
// angle slug lets downstream prompt-generation reference a panel by meaning
// (e.g. pass `03-side.png` as the reference for a side-on shot).
export const TURNAROUND_PANELS = [
  '01-front',
  '02-three-quarter-front',
  '03-side',
  '04-three-quarter-rear',
  '05-rear',
  '06-face-closeup',
];

// A pose sheet is the same 3×2 grid, but each panel's meaning is chosen per run
// (the pose set varies), so the panels get generic ordered names rather than
// fixed angle labels. Downstream references them by position, e.g. `panel-2`.
export const POSE_PANELS = ['panel-1', 'panel-2', 'panel-3', 'panel-4', 'panel-5', 'panel-6'];

// Which sheet types get auto-split, and the panel names to use. Sheet types not
// listed here (e.g. `cycles`) are left as the single all-in-one sheet.
export const SHEET_PANEL_LABELS = {
  turnaround: TURNAROUND_PANELS,
  pose: POSE_PANELS,
};

export const COLS = 3;
export const ROWS = 2;

// Split a 3×2 six-panel sheet into one image file per panel under outDir, named
// by `labels` (in grid reading order). Returns the written paths in that order.
// The crop is an even grid; the last column/row absorbs any rounding remainder
// so no edge pixels are dropped. `sharpImpl` is injectable for tests and
// defaults to the sharp package (loaded lazily so importing this module — e.g.
// for TURNAROUND_PANELS — never requires the native dependency).
export async function splitPanels(imagePath, outDir, labels = TURNAROUND_PANELS, { sharpImpl } = {}) {
  const sharp = sharpImpl || (await import('sharp')).default;
  const ext = path.extname(imagePath) || '.png';

  const { width, height } = await sharp(imagePath).metadata();
  if (!width || !height) {
    throw new Error(`cannot read image dimensions for ${imagePath}`);
  }
  const colW = Math.floor(width / COLS);
  const rowH = Math.floor(height / ROWS);

  await mkdir(outDir, { recursive: true });

  const outputs = [];
  for (let i = 0; i < labels.length; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const left = col * colW;
    const top = row * rowH;
    const w = col === COLS - 1 ? width - left : colW;
    const h = row === ROWS - 1 ? height - top : rowH;
    const out = path.join(outDir, `${labels[i]}${ext}`);
    await sharp(imagePath).extract({ left, top, width: w, height: h }).toFile(out);
    outputs.push(out);
  }
  return outputs;
}

// A generated sheet image is `vNNN.<img-ext>`; its panel folder is the sibling
// `vNNN/`. Prompt snapshots (`vNNN.prompt.md`) are deliberately excluded.
const SHEET_IMAGE_RE = /^(v\d+)\.(png|jpe?g|webp)$/i;

async function listDirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
async function listFiles(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
async function pathExists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

// Split existing sheet versions that don't already have a panel folder — the
// post-hoc counterpart to the auto-split at generation time. Walks
// elements/<type>/<name>/sheets/<sheetType>/<slug>/ under `root`, and for every
// splittable sheet type (SHEET_PANEL_LABELS) splits each `vNNN` image whose
// `vNNN/` folder is missing. Existing folders are left untouched, so it is safe
// to re-run. `filter` narrows the scan by { type, name, sheet, id }; omit a key
// to include all. Returns one record per image: { image, panelsDir, status:
// 'split' | 'skipped', panels?, reason? }. `splitPanels` is injectable for tests.
export async function backfillPanels(root, filter = {}, { splitPanels: split = splitPanels } = {}) {
  const elementsDir = path.join(root, 'elements');
  const splittable = Object.keys(SHEET_PANEL_LABELS);
  const results = [];

  const types = filter.type ? [filter.type] : await listDirs(elementsDir);
  for (const type of types) {
    const names = filter.name ? [filter.name] : await listDirs(path.join(elementsDir, type));
    for (const name of names) {
      for (const sheet of splittable) {
        if (filter.sheet && filter.sheet !== sheet) continue;
        const slugs = filter.id ? [filter.id] : await listDirs(sheetDir(root, type, name, sheet));
        for (const slug of slugs) {
          const instanceDir = sheetInstanceDir(root, type, name, sheet, slug);
          for (const file of await listFiles(instanceDir)) {
            const m = SHEET_IMAGE_RE.exec(file);
            if (!m) continue;
            const image = path.join(instanceDir, file);
            const panelsDir = path.join(instanceDir, m[1]);
            if (await pathExists(panelsDir)) {
              results.push({ image, panelsDir, status: 'skipped', reason: 'panel folder already exists' });
              continue;
            }
            const panels = await split(image, panelsDir, SHEET_PANEL_LABELS[sheet]);
            results.push({ image, panelsDir, status: 'split', panels });
          }
        }
      }
    }
  }
  return results;
}

// Inverse of splitPanels: composite 6 panel images (grid reading order) into one
// 3×2 image. `cells` gives each panel's TARGET dimensions { w, h } in the same
// order; every panel is resized to its cell before compositing, so the output is
// independent of what size a given upscaler returned. `sharpImpl` is injectable;
// defaults to the sharp package, loaded lazily.
export async function stitchPanels(panelPaths, cells, outPath, { sharpImpl } = {}) {
  if (panelPaths.length !== COLS * ROWS || cells.length !== COLS * ROWS) {
    throw new Error(`stitchPanels: expected ${COLS * ROWS} panels, got ${panelPaths.length}`);
  }
  const sharp = sharpImpl || (await import('sharp')).default;

  const colW = [0, 0, 0];
  const rowH = [0, 0];
  for (let i = 0; i < cells.length; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    colW[col] = Math.max(colW[col], cells[i].w);
    rowH[row] = Math.max(rowH[row], cells[i].h);
  }
  const canvasW = colW.reduce((a, b) => a + b, 0);
  const canvasH = rowH.reduce((a, b) => a + b, 0);
  const colX = [0, colW[0], colW[0] + colW[1]];
  const rowY = [0, rowH[0]];

  const composites = [];
  for (let i = 0; i < panelPaths.length; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const buf = await sharp(panelPaths[i])
      .resize(cells[i].w, cells[i].h, { fit: 'fill' })
      .toBuffer();
    composites.push({ input: buf, left: colX[col], top: rowY[row] });
  }

  await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(composites).png().toFile(outPath);
  return { output: outPath, width: canvasW, height: canvasH };
}
