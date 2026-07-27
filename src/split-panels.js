import path from 'node:path';
import { mkdir } from 'node:fs/promises';

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

const COLS = 3;
const ROWS = 2;

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
