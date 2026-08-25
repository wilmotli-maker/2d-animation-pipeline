# Element / Image Upscale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a resolution-upscale pass for element sheet images (panel-aware for turnaround/pose, flat for cycles) and for standalone loose images, mirroring `pipeline shot upscale`.

**Architecture:** A new engine `src/upscale-image.js` (`upscaleImage`) uploads a source image (or each split panel), submits image-upscale jobs via the existing `runBatch`, downloads results, and for panel sheets reassembles a composite via a new `stitchPanels()` in `src/split-panels.js`. Credit accounting reuses `estimateCredits`/`recordCreditAttempt`; a new `image` location kind logs standalone upscales to `images/generations.jsonl`. Two CLI subcommands (`element upscale`, `image upscale`) drive the one engine.

**Tech Stack:** Node.js ESM, `node:test`, `sharp` (image dims + composite), the higgsfield CLI via `createRunner`.

**Spec:** `docs/superpowers/specs/2026-08-25-element-image-upscale-design.md`

---

## File Structure

- **Create** `src/upscale-image.js` — model table `UPSCALE_IMAGE_MODELS`, `UPSCALE_IMAGE_DEFAULT_MODEL`, `upscaleImage(root, spec, deps)`. One responsibility: turn a source image (element sheet or loose file) into an upscaled result + credit log + sidecar.
- **Modify** `src/paths.js` — add `elementUpscalePath()` and `imageGenerationsLogPath()`.
- **Modify** `src/split-panels.js` — add `stitchPanels()` and export the grid constants (`COLS`, `ROWS`) it shares with the engine.
- **Modify** `src/credits.js` — add the `image` location branch to `recordCreditAttempt`, and `walkImageJsonl` into `collectLogEntries`.
- **Modify** `bin/pipeline.js` — `element upscale` and `image upscale` CLI branches + help lines.
- **Create** `test/upscale-image.test.js` — engine + CLI-shape tests.
- **Create** `test/stitch-panels.test.js` — `stitchPanels` unit test.

Grid geometry lives in `split-panels.js` (single source of truth for `COLS`/`ROWS`); the engine imports it rather than redefining 3×2.

---

## Task 1: Path helpers

**Files:**
- Modify: `src/paths.js`
- Test: `test/paths.test.js` (create if absent; otherwise append)

- [ ] **Step 1: Write the failing test**

Create/append `test/paths.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elementUpscalePath, imageGenerationsLogPath } from '../src/paths.js';

test('elementUpscalePath sits beside the sheet instance, tagged', () => {
  const p = elementUpscalePath('/r', 'characters', 'ndiva', 'turnaround', 'front', '2x-topaz_image');
  assert.equal(p, '/r/elements/characters/niva/sheets/turnaround/front/upscaled-2x-topaz_image.png'
    .replace('niva', 'ndiva'));
});

test('imageGenerationsLogPath is project-root images/generations.jsonl', () => {
  assert.equal(imageGenerationsLogPath('/r'), '/r/images/generations.jsonl');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paths.test.js`
Expected: FAIL — `elementUpscalePath is not a function`.

- [ ] **Step 3: Add the helpers**

In `src/paths.js`, after `sheetPromptPath` (around line 27) add:

```javascript
// Composite output of `pipeline element upscale`, beside the sheet version it
// enlarged. `tag` carries scale+model (e.g. "2x-topaz_image") so different
// passes coexist rather than overwrite. Per-panel upscales land in the sibling
// `upscaled-<tag>/` directory.
export function elementUpscalePath(root, type, name, sheet, id, tag) {
  return path.join(sheetInstanceDir(root, type, name, sheet, id), `upscaled-${tag}.png`);
}
```

At the end of the file add:

```javascript
// Credit log for standalone `pipeline image upscale` runs — images with no
// element/shot home. Project-root so `reconcile`/`report` can find it.
export function imageGenerationsLogPath(root) {
  return path.join(root, 'images', 'generations.jsonl');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/paths.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths.js test/paths.test.js
git commit -m "feat(paths): element upscale + image generations log paths"
```

---

## Task 2: `stitchPanels()` reassembly

**Files:**
- Modify: `src/split-panels.js`
- Test: `test/stitch-panels.test.js`

Reassembles 6 upscaled panels into one 3×2 composite. Each panel is resized to
its **target grid cell** before compositing, so the result is model-agnostic
(topaz already returns cell-sized panels; bytedance returns a fixed 2k/4k that
must be snapped back onto the grid).

- [ ] **Step 1: Write the failing test**

Create `test/stitch-panels.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/stitch-panels.test.js`
Expected: FAIL — `stitchPanels is not a function`.

- [ ] **Step 3: Implement `stitchPanels` and export grid constants**

In `src/split-panels.js`, the `COLS`/`ROWS` consts already exist (`const COLS = 3; const ROWS = 2;`). Change them to be exported:

```javascript
export const COLS = 3;
export const ROWS = 2;
```

Add at the end of the file:

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/stitch-panels.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/split-panels.js test/stitch-panels.test.js
git commit -m "feat(panels): stitchPanels reassembles upscaled panels into a sheet"
```

---

## Task 3: `image` credit-log location + reconcile scan

**Files:**
- Modify: `src/credits.js`
- Test: `test/credits-image.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/credits-image.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { recordCreditAttempt, collectLogEntries } from '../src/credits.js';
import { imageGenerationsLogPath } from '../src/paths.js';

test('image location logs to images/generations.jsonl and reconcile sees it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'creditimg-'));
  await recordCreditAttempt(root, { kind: 'image' }, {
    model: 'topaz_image', scale: 2, jobId: 'job-9', kind: 'upscale',
    credits: 3, creditsSource: 'api', status: 'generated',
    source: '/x/in.png', output: '/x/in.upscaled-2x-topaz_image.png',
  });
  const logged = JSON.parse((await readFile(imageGenerationsLogPath(root), 'utf8')).trim());
  assert.equal(logged.jobId, 'job-9');
  assert.equal(logged.kind, 'upscale');

  const entries = await collectLogEntries(root);
  assert.ok(entries.some((e) => e.jobId === 'job-9' && e.model === 'topaz_image'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/credits-image.test.js`
Expected: FAIL — `unknown credit log location kind: image`.

- [ ] **Step 3: Add the `image` branch and the walker**

In `src/credits.js`, import the new path helper — change line 5:

```javascript
import { generationsLogPath, imageGenerationsLogPath, shotDir, shotDraftsDir, shotGenerationsLogPath, taskStatePath } from './paths.js';
```

Add an appender near `appendShotGeneration` (after it):

```javascript
export async function appendImageGeneration(root, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  await appendFile(imageGenerationsLogPath(root), line);
}
```

Note: `appendFile` won't create the `images/` dir. Guard it — in
`appendImageGeneration`, before `appendFile` add:

```javascript
  await mkdir(path.dirname(imageGenerationsLogPath(root)), { recursive: true });
```

(`mkdir` is already imported on line 1.)

In `recordCreditAttempt`, before the final `throw`, add:

```javascript
  if (location.kind === 'image') {
    await appendImageGeneration(root, entry);
    return;
  }
```

Add a walker beside `walkShotJsonl` (after it, ~line 353):

```javascript
async function walkImageJsonl(root) {
  const file = imageGenerationsLogPath(root);
  const entries = [];
  for (const raw of await readJsonl(file)) {
    entries.push(normalizeEntry(raw, { kind: raw.kind || 'upscale' }));
  }
  return entries;
}
```

Wire it into `collectLogEntries` (line 405):

```javascript
  const fromJsonl = [
    ...await walkElementLogs(root),
    ...await walkShotJsonl(root),
    ...await walkImageJsonl(root),
  ];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/credits-image.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/credits.js test/credits-image.test.js
git commit -m "feat(credits): image location kind + reconcile scan for standalone upscales"
```

---

## Task 4: `upscaleImage` engine — model table + flat flow

**Files:**
- Create: `src/upscale-image.js`
- Test: `test/upscale-image.test.js`

This task builds the model table and the FLAT flow (cycles / `--input` /
standalone). Panel flow is Task 5.

- [ ] **Step 1: Write the failing test**

Create `test/upscale-image.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { upscaleImage, UPSCALE_IMAGE_MODELS, UPSCALE_IMAGE_DEFAULT_MODEL } from '../src/upscale-image.js';

async function project() {
  return mkdtemp(path.join(tmpdir(), 'upimg-'));
}

// Fakes. sharpImpl returns fixed 100x50 metadata so topaz dim math is predictable.
function fakes({ status = 'completed', outputUrl = 'https://x/up.png' } = {}) {
  const calls = { uploads: [], batches: [], downloads: [] };
  const runner = {
    async upload(file) { calls.uploads.push(file); return { id: `media-${calls.uploads.length}`, type: 'image' }; },
    async estimateCost() { return 3; },
  };
  const runBatch = async (_r, jobs) => {
    calls.batches.push(jobs);
    return jobs.map((j, i) => ({ ref: j.ref, id: `job-${i + 1}`, status, outputUrl: status === 'completed' ? outputUrl : null }));
  };
  const downloadTo = async (url, dest) => { calls.downloads.push({ url, dest }); await writeFile(dest, 'img'); };
  const sharpImpl = () => ({ metadata: async () => ({ width: 100, height: 50 }) });
  return { runner, runBatch, downloadTo, sharpImpl, calls };
}

test('model table exposes documented defaults', () => {
  assert.equal(UPSCALE_IMAGE_DEFAULT_MODEL, 'topaz_image');
  assert.ok(UPSCALE_IMAGE_MODELS.topaz_image);
  assert.ok(UPSCALE_IMAGE_MODELS.bytedance_image_upscale);
});

test('standalone flat flow: topaz sends scaled output dims, writes beside input', async () => {
  const root = await project();
  const src = path.join(root, 'loose.png');
  await writeFile(src, 'img');
  const f = fakes();

  const res = await upscaleImage(root, {
    mode: 'image', input: src, scale: 2,
  }, f);

  assert.deepEqual(f.calls.uploads, [src]);
  const [job] = f.calls.batches[0];
  assert.equal(job.model, 'topaz_image');
  assert.deepEqual(job.opts.imageReferences, ['media-1']);
  assert.equal(job.opts.outputWidth, 200);
  assert.equal(job.opts.outputHeight, 100);
  assert.equal(job.opts.variant, 'Standard V2');
  assert.match(res.outputPath, /loose\.upscaled-2x-topaz_image\.png$/);
  assert.equal(f.calls.downloads[0].dest, res.outputPath);
});

test('standalone honors --out and logs to images/generations.jsonl', async () => {
  const root = await project();
  const src = path.join(root, 'loose.png');
  await writeFile(src, 'img');
  const outDir = path.join(root, 'out');
  await mkdir(outDir, { recursive: true });
  const f = fakes();

  const res = await upscaleImage(root, { mode: 'image', input: src, out: outDir, scale: 4 }, f);
  assert.equal(path.dirname(res.outputPath), outDir);

  const log = JSON.parse((await readFile(path.join(root, 'images', 'generations.jsonl'), 'utf8')).trim());
  assert.equal(log.kind, 'upscale');
  assert.equal(log.scale, 4);
  assert.equal(log.jobId, 'job-1');
});

test('bytedance maps scale to a resolution enum, sends no dims', async () => {
  const root = await project();
  const src = path.join(root, 'loose.png');
  await writeFile(src, 'img');
  const f = fakes();

  await upscaleImage(root, { mode: 'image', input: src, model: 'bytedance_image_upscale', scale: 4 }, f);
  const [job] = f.calls.batches[0];
  assert.equal(job.opts.resolution, '4k');
  assert.equal(job.opts.outputWidth, undefined);
});

test('rejects unknown model and invalid scale before uploading', async () => {
  const root = await project();
  const src = path.join(root, 'loose.png');
  await writeFile(src, 'img');

  let f = fakes();
  await assert.rejects(() => upscaleImage(root, { mode: 'image', input: src, model: 'nope' }, f), /unknown upscale model/);
  assert.equal(f.calls.uploads.length, 0);

  f = fakes();
  await assert.rejects(() => upscaleImage(root, { mode: 'image', input: src, scale: 3 }, f), /--scale must be/);
  assert.equal(f.calls.uploads.length, 0);
});

test('a missing input reports the path without uploading', async () => {
  const root = await project();
  const f = fakes();
  await assert.rejects(() => upscaleImage(root, { mode: 'image', input: path.join(root, 'ghost.png') }, f), /no such image/);
  assert.equal(f.calls.uploads.length, 0);
});

test('a failed job throws and writes no output', async () => {
  const root = await project();
  const src = path.join(root, 'loose.png');
  await writeFile(src, 'img');
  const f = fakes({ status: 'failed' });
  await assert.rejects(() => upscaleImage(root, { mode: 'image', input: src }, f), /did not complete/);
  assert.equal(f.calls.downloads.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/upscale-image.test.js`
Expected: FAIL — cannot find module `../src/upscale-image.js`.

- [ ] **Step 3: Implement the engine (flat flow)**

Create `src/upscale-image.js`:

```javascript
import path from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { runBatch as defaultRunBatch } from './batch.js';
import { downloadTo as defaultDownloadTo } from './download.js';
import { estimateCredits, recordCreditAttempt, resolveActiveTask } from './credits.js';
import { elementUpscalePath } from './paths.js';

// Image upscalers enlarge a finished still. topaz_image is non-generative and
// preserves line weight and paper texture on flat cartoon art (the same reason
// topaz_video is the clip default); bytedance is the cheaper enum-sized option.
// topaz_image_generative is deliberately excluded — it invents detail, wrong for
// a faithful upscale of a locked design.
export const UPSCALE_IMAGE_MODELS = {
  topaz_image: {
    kind: 'dimensions',              // needs explicit output_width/height
    defaults: { variant: 'Standard V2' },
  },
  bytedance_image_upscale: {
    kind: 'enum',                    // takes a 2k/4k resolution, not dims
    scaleToResolution: { 2: '2k', 4: '4k' },
  },
};

export const UPSCALE_IMAGE_DEFAULT_MODEL = 'topaz_image';
const VALID_SCALES = [2, 4];

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

// Build the per-job opts for one image at { width, height } source dims.
function buildOpts(cfg, mediaId, scale, width, height) {
  const opts = { imageReferences: [mediaId] };
  if (cfg.kind === 'dimensions') {
    opts.outputWidth = Math.round(width * scale);
    opts.outputHeight = Math.round(height * scale);
    Object.assign(opts, cfg.defaults);
  } else {
    opts.resolution = cfg.scaleToResolution[scale];
  }
  return opts;
}

function validate(model, scale) {
  const cfg = UPSCALE_IMAGE_MODELS[model];
  if (!cfg) {
    throw new Error(`unknown upscale model "${model}" — expected one of ${Object.keys(UPSCALE_IMAGE_MODELS).join(', ')}`);
  }
  if (!VALID_SCALES.includes(scale)) {
    throw new Error(`--scale must be one of ${VALID_SCALES.join(', ')}, got "${scale}"`);
  }
  return cfg;
}

/**
 * Upscale one image. `spec.mode` selects the flow:
 *   - 'image'   : standalone loose file (this task) — flat, one job.
 *   - 'element' : element sheet (Task 5) — panel-aware for turnaround/pose.
 */
export async function upscaleImage(root, spec, deps = {}) {
  const {
    runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
    splitPanels, stitchPanels, sharpImpl,
  } = deps;
  const {
    mode = 'image', model = UPSCALE_IMAGE_DEFAULT_MODEL, scale = 2,
  } = spec;
  const cfg = validate(model, Number(scale));
  const task = await resolveActiveTask(root, spec);

  if (mode === 'element') {
    return upscaleElementSheet(root, spec, { cfg, task, runner, runBatch, downloadTo, splitPanels, stitchPanels, sharpImpl });
  }
  return upscaleStandalone(root, spec, { cfg, model, scale: Number(scale), task, runner, runBatch, downloadTo, sharpImpl });
}

async function readDims(sharpImpl, file) {
  const sharp = sharpImpl || (await import('sharp')).default;
  const { width, height } = await sharp(file).metadata();
  if (!width || !height) throw new Error(`cannot read image dimensions for ${file}`);
  return { width, height };
}

async function upscaleStandalone(root, spec, ctx) {
  const { cfg, model, scale, task, runner, runBatch, downloadTo, sharpImpl } = ctx;
  const { input, out } = spec;
  if (!input) throw new Error('image upscale: --input is required');
  if (!await exists(input)) throw new Error(`no such image: ${input}`);

  const media = await runner.upload(input);
  let opts;
  if (cfg.kind === 'dimensions') {
    const { width, height } = await readDims(sharpImpl, input);
    opts = buildOpts(cfg, media.id, scale, width, height);
  } else {
    opts = buildOpts(cfg, media.id, scale);
  }

  const { credits, source: creditsSource } = await estimateCredits({ runner, model, images: [media.id], ...opts });
  const tag = `${scale}x-${model}`;
  const stem = path.basename(input).replace(/\.[^.]+$/, '');
  const outputPath = path.join(out || path.dirname(input), `${stem}.upscaled-${tag}.png`);
  const location = { kind: 'image' };
  const creditFields = { credits, creditsSource, kind: 'upscale', task, model, scale };

  const [result] = await runBatch(runner, [{ ref: stem, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    await recordCreditAttempt(root, location, {
      ...creditFields, jobId: result.id ?? null, status: 'failed', failurePhase: 'generation',
      billedLikely: !!result.id, error: result.error || String(result.status),
      source: input, sourceMediaId: media.id,
    });
    throw new Error(`image upscale for ${input} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  try {
    await downloadTo(result.outputUrl, outputPath);
    await writeFile(outputPath.replace(/\.png$/, '.json'), JSON.stringify({
      ...creditFields, jobId: result.id, source: input, sourceMediaId: media.id,
      params: opts, output: outputPath, upscaledAt: new Date().toISOString(), status: 'generated',
    }, null, 2) + '\n');
    await recordCreditAttempt(root, location, {
      ...creditFields, jobId: result.id, status: 'generated',
      source: input, sourceMediaId: media.id, output: outputPath,
    });
    return { outputPath, jobId: result.id, model, scale, source: input, task };
  } catch (err) {
    await recordCreditAttempt(root, location, {
      ...creditFields, jobId: result.id, status: 'failed', failurePhase: 'post_complete',
      billedLikely: true, error: String(err?.message || err), source: input, sourceMediaId: media.id,
    });
    throw err;
  }
}

// Stub — implemented in Task 5.
async function upscaleElementSheet() {
  throw new Error('element sheet upscale not yet implemented');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/upscale-image.test.js`
Expected: PASS (all flat-flow tests).

- [ ] **Step 5: Commit**

```bash
git add src/upscale-image.js test/upscale-image.test.js
git commit -m "feat(upscale-image): engine + standalone flat image upscale flow"
```

---

## Task 5: `upscaleImage` engine — panel-aware element flow

**Files:**
- Modify: `src/upscale-image.js`
- Modify: `test/upscale-image.test.js`

Element sheets: `turnaround`/`pose` split into 6 panels, one upscale job per
panel, then `stitchPanels` reassembles the composite. `cycles` (no panels) and
any `--input` take the flat single-job flow but write into the sheet dir.

- [ ] **Step 1: Write the failing tests**

Append to `test/upscale-image.test.js`:

```javascript
import { elementUpscalePath } from '../src/paths.js';
import { SHEET_PANEL_LABELS } from '../src/split-panels.js';

// Lay down a sheet version and its panel folder.
async function withSheet(root, { type = 'characters', name = 'ndiva', sheet = 'turnaround', id = 'front', v = 'v001' } = {}) {
  const dir = path.join(root, 'elements', type, name, 'sheets', sheet, id);
  await mkdir(path.join(dir, v), { recursive: true });
  await writeFile(path.join(dir, `${v}.png`), 'sheet');
  for (const label of SHEET_PANEL_LABELS[sheet]) {
    await writeFile(path.join(dir, v, `${label}.png`), 'panel');
  }
  return { dir, type, name, sheet, id, v };
}

function panelFakes(opts = {}) {
  const f = fakes(opts);
  const splitPanels = async (image, outDir, labels) => labels.map((l) => path.join(outDir, `${l}.png`));
  const stitched = [];
  const stitchPanels = async (panelPaths, cells, outPath) => { stitched.push({ panelPaths, cells, outPath }); await writeFile(outPath, 'composite'); return { output: outPath }; };
  return { ...f, splitPanels, stitchPanels, stitched };
}

test('turnaround upscales all 6 panels then stitches a composite', async () => {
  const root = await project();
  const s = await withSheet(root);
  const f = panelFakes();

  const res = await upscaleImage(root, { mode: 'element', type: s.type, name: s.name, sheet: s.sheet, id: s.id, scale: 2 }, f);

  // 6 uploads, 6 jobs in one batch.
  assert.equal(f.calls.uploads.length, 6);
  assert.equal(f.calls.batches[0].length, 6);
  // composite lands at the tagged sheet path
  assert.equal(res.outputPath, elementUpscalePath(root, s.type, s.name, s.sheet, s.id, '2x-topaz_image'));
  assert.equal(f.stitched.length, 1);
  assert.equal(f.stitched[0].outPath, res.outputPath);
  // per-panel files under upscaled-<tag>/
  assert.match(f.calls.downloads[0].dest, /upscaled-2x-topaz_image\/.*\.png$/);
});

test('cycles (no panels) takes the flat flow into the sheet dir', async () => {
  const root = await project();
  const s = await withSheet(root, { sheet: 'cycles', id: 'walk' });
  // cycles has no panel folder; ensure the version file exists
  const f = panelFakes();
  const res = await upscaleImage(root, { mode: 'element', type: s.type, name: s.name, sheet: 'cycles', id: 'walk', scale: 2 }, f);
  assert.equal(f.calls.uploads.length, 1);
  assert.equal(f.stitched.length, 0);
  assert.match(res.outputPath, /sheets\/cycles\/walk\/upscaled-2x-topaz_image\.png$/);
});

test('one failed panel throws, writes no composite', async () => {
  const root = await project();
  const s = await withSheet(root);
  const f = panelFakes();
  // make the 3rd panel job fail
  const realRunBatch = f.runBatch;
  f.runBatch = async (r, jobs) => {
    const out = await realRunBatch(r, jobs);
    out[2] = { ...out[2], status: 'failed', outputUrl: null };
    return out;
  };
  await assert.rejects(() => upscaleImage(root, { mode: 'element', type: s.type, name: s.name, sheet: s.sheet, id: s.id, scale: 2 }, f), /did not complete/);
  assert.equal(f.stitched.length, 0);
});

test('missing sheet version reports the path without uploading', async () => {
  const root = await project();
  const f = panelFakes();
  await assert.rejects(
    () => upscaleImage(root, { mode: 'element', type: 'characters', name: 'ghost', sheet: 'turnaround', id: 'front' }, f),
    /no such sheet version/,
  );
  assert.equal(f.calls.uploads.length, 0);
});
```

Note: `cycles` needs a version file but no panel dir. Adjust `withSheet` call
for cycles — it currently writes a panel dir from `SHEET_PANEL_LABELS[sheet]`,
which is `undefined` for cycles. Guard the loop in `withSheet`:

```javascript
  for (const label of SHEET_PANEL_LABELS[sheet] || []) {
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/upscale-image.test.js`
Expected: FAIL — `element sheet upscale not yet implemented`.

- [ ] **Step 3: Implement `upscaleElementSheet`**

In `src/upscale-image.js`, add imports at the top:

```javascript
import { readdir } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import {
  splitPanels as defaultSplitPanels, stitchPanels as defaultStitchPanels,
  SHEET_PANEL_LABELS, COLS, ROWS,
} from './split-panels.js';
import { appendGeneration } from './element.js';
import { sheetInstanceDir } from './paths.js';
```

Replace the `upscaleElementSheet` stub with:

```javascript
// Highest vNNN.png in a sheet instance dir, or null.
async function latestVersion(dir) {
  let files;
  try { files = await readdir(dir); } catch { return null; }
  const versions = files
    .map((f) => /^(v\d+)\.png$/.exec(f))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
  return versions.length ? versions[versions.length - 1] : null;
}

async function upscaleElementSheet(root, spec, ctx) {
  const { cfg, task, runner, runBatch, downloadTo, splitPanels = defaultSplitPanels, stitchPanels = defaultStitchPanels, sharpImpl } = ctx;
  const { type, name, sheet, id, input } = spec;
  const model = spec.model || UPSCALE_IMAGE_DEFAULT_MODEL;
  const scale = Number(spec.scale ?? 2);
  const dir = sheetInstanceDir(root, type, name, sheet, id);

  // Resolve the source version.
  let version = spec.version;
  if (input) {
    if (!await exists(input)) throw new Error(`no such image: ${input}`);
  } else {
    if (version == null || version === 'latest') {
      version = await latestVersion(dir);
    } else if (/^\d+$/.test(String(version))) {
      version = `v${String(version).padStart(3, '0')}`;
    }
    if (!version || !await exists(path.join(dir, `${version}.png`))) {
      throw new Error(`no such sheet version: ${path.join(dir, `${version || 'v???'}.png`)}`);
    }
  }

  const tag = `${scale}x-${model}`;
  const location = { kind: 'element', type, name };
  const panelLabels = SHEET_PANEL_LABELS[sheet];

  // Flat flow: cycles, or --input override.
  if (input || !panelLabels) {
    const src = input || path.join(dir, `${version}.png`);
    return flatIntoSheet(root, { src, dir, tag, model, scale, cfg, sheet, id, task, location }, { runner, runBatch, downloadTo, sharpImpl });
  }

  // Panel flow: split (or reuse) panels, upscale each, stitch.
  const src = path.join(dir, `${version}.png`);
  const panelsDir = path.join(dir, version);
  let panelPaths;
  if (await exists(panelsDir)) {
    panelPaths = panelLabels.map((l) => path.join(panelsDir, `${l}.png`));
  } else {
    panelPaths = await splitPanels(src, panelsDir, panelLabels);
  }

  // Per-panel source dims (topaz) → target cells for stitch.
  const cells = [];
  const jobs = [];
  const uploads = [];
  for (let i = 0; i < panelPaths.length; i++) {
    const media = await runner.upload(panelPaths[i]);
    uploads.push(media);
    let opts, cell;
    if (cfg.kind === 'dimensions') {
      const { width, height } = await readDims(sharpImpl, panelPaths[i]);
      opts = buildOpts(cfg, media.id, scale, width, height);
      cell = { w: opts.outputWidth, h: opts.outputHeight };
    } else {
      opts = buildOpts(cfg, media.id, scale);
      // enum models: derive a target cell from the panel's own scaled dims so
      // the grid stays consistent regardless of what the model returns.
      const { width, height } = await readDims(sharpImpl, panelPaths[i]);
      cell = { w: Math.round(width * scale), h: Math.round(height * scale) };
    }
    cells.push(cell);
    jobs.push({ ref: `${panelLabels[i]}`, model, opts });
  }

  const outTag = `upscaled-${tag}`;
  const upscaledPanelsDir = path.join(dir, outTag);
  await mkdir(upscaledPanelsDir, { recursive: true });

  const creditFields = { credits: null, creditsSource: null, kind: 'upscale', task, model, scale };
  const results = await runBatch(runner, jobs);

  // Log each panel job; a single failure fails the whole sheet.
  const outPanelPaths = [];
  let failed = null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const entryBase = { ...creditFields, sheetType: sheet, sheetId: id, panel: panelLabels[i], jobId: r.id ?? null, source: panelPaths[i], sourceMediaId: uploads[i].id };
    if (r.status !== 'completed' || !r.outputUrl) {
      await appendGeneration(root, type, name, { ...entryBase, status: 'failed', failurePhase: 'generation', billedLikely: !!r.id, error: r.error || String(r.status) });
      failed = failed || panelLabels[i];
      continue;
    }
    const dest = path.join(upscaledPanelsDir, `${panelLabels[i]}.png`);
    await downloadTo(r.outputUrl, dest);
    outPanelPaths.push(dest);
    await appendGeneration(root, type, name, { ...entryBase, status: 'generated', output: dest });
  }
  if (failed) {
    throw new Error(`element upscale for ${type}/${name} ${sheet}/${id} did not complete: panel ${failed} failed`);
  }

  const compositePath = elementUpscalePath(root, type, name, sheet, id, tag);
  await stitchPanels(outPanelPaths, cells, compositePath, { sharpImpl });
  await writeFile(compositePath.replace(/\.png$/, '.json'), JSON.stringify({
    ...creditFields, sheetType: sheet, sheetId: id, source: src, panels: outPanelPaths,
    output: compositePath, upscaledAt: new Date().toISOString(), status: 'generated',
  }, null, 2) + '\n');

  return { outputPath: compositePath, panelsDir: upscaledPanelsDir, panels: outPanelPaths, jobIds: results.map((r) => r.id), model, scale, source: src, task };
}

// Flat flow that writes into a sheet dir (cycles / --input).
async function flatIntoSheet(root, p, deps) {
  const { src, dir, tag, model, scale, cfg, sheet, id, task, location } = p;
  const { runner, runBatch, downloadTo, sharpImpl } = deps;
  const media = await runner.upload(src);
  let opts;
  if (cfg.kind === 'dimensions') {
    const { width, height } = await readDims(sharpImpl, src);
    opts = buildOpts(cfg, media.id, scale, width, height);
  } else {
    opts = buildOpts(cfg, media.id, scale);
  }
  const { credits, source: creditsSource } = await estimateCredits({ runner, model, images: [media.id], ...opts });
  const creditFields = { credits, creditsSource, kind: 'upscale', task, model, scale, sheetType: sheet, sheetId: id };
  const outputPath = path.join(dir, `upscaled-${tag}.png`);

  const [result] = await runBatch(runner, [{ ref: id, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    await appendGeneration(root, location.type, location.name, {
      ...creditFields, jobId: result.id ?? null, status: 'failed', failurePhase: 'generation',
      billedLikely: !!result.id, error: result.error || String(result.status), source: src, sourceMediaId: media.id,
    });
    throw new Error(`element upscale for ${location.type}/${location.name} ${sheet}/${id} did not complete: ${result.status}`);
  }
  await downloadTo(result.outputUrl, outputPath);
  await writeFile(outputPath.replace(/\.png$/, '.json'), JSON.stringify({
    ...creditFields, jobId: result.id, source: src, sourceMediaId: media.id, params: opts,
    output: outputPath, upscaledAt: new Date().toISOString(), status: 'generated',
  }, null, 2) + '\n');
  await appendGeneration(root, location.type, location.name, {
    ...creditFields, jobId: result.id, status: 'generated', source: src, sourceMediaId: media.id, output: outputPath,
  });
  return { outputPath, jobId: result.id, model, scale, source: src, task };
}
```

Remove the now-duplicate `mkdir`/`readdir` import if the top-of-file import block
already imports them (consolidate into the existing `node:fs/promises` import
line: `import { access, writeFile, mkdir, readdir } from 'node:fs/promises';`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/upscale-image.test.js`
Expected: PASS (flat + panel tests).

- [ ] **Step 5: Commit**

```bash
git add src/upscale-image.js test/upscale-image.test.js
git commit -m "feat(upscale-image): panel-aware element sheet upscale + reassembly"
```

---

## Task 6: CLI wiring — `element upscale` and `image upscale`

**Files:**
- Modify: `bin/pipeline.js`
- Test: manual smoke via `--help` and arg validation (no network)

- [ ] **Step 0: Map topaz's scalar params to CLI flags**

`buildGenerateArgs`/`buildCostArgs` only emit opt keys listed in `SCALAR_PARAMS`
(`src/cli.js` ~line 67). `resolution` is present (bytedance is covered) but
topaz's `outputWidth`/`outputHeight`/`variant` are not, so they'd be silently
dropped on real runs. Add them:

```javascript
  // Upscaler params (bytedance_video_upscale).
  modelVersion: '--model-version',
  preset: '--preset',
  fps: '--fps',
  // Image upscaler params (topaz_image).
  outputWidth: '--output-width',
  outputHeight: '--output-height',
  variant: '--variant',
```

Verify against the CLI: `node_modules/.bin/higgsfield model get topaz_image`
lists `output_width`, `output_height`, `variant` — confirm the kebab flags match
(`generate create topaz_image --help` if unsure).

Quick check the mapping is wired both places:

Run: `node -e "import('./src/cli.js').then(m=>console.log(m.buildGenerateArgs('topaz_image',{imageReferences:['id'],outputWidth:200,outputHeight:100,variant:'Standard V2'}).join(' ')))"`
Expected: contains `--output-width 200 --output-height 100 --variant Standard V2`.

Commit:

```bash
git add src/cli.js
git commit -m "feat(cli): map topaz_image output-width/height/variant params"
```

- [ ] **Step 1: Add the import**

At the top of `bin/pipeline.js`, beside the `upscaleShot` import (line 14), add:

```javascript
import { upscaleImage, UPSCALE_IMAGE_MODELS, UPSCALE_IMAGE_DEFAULT_MODEL } from '../src/upscale-image.js';
```

- [ ] **Step 2: Add the `element upscale` branch**

After the `shot upscale` branch (ends ~line 273), add:

```javascript
  } else if (cmd === 'element' && sub === 'upscale') {
    const f = parseFlags(rest);
    if (!f.type || !f.name || !f.sheet || !f.id) {
      fail('usage: pipeline element upscale --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> [--version <n|latest>] [--model topaz_image|bytedance_image_upscale] [--scale 2|4] [--input <file>] [--root <dir>]');
    }
    const model = f.model || UPSCALE_IMAGE_DEFAULT_MODEL;
    if (!UPSCALE_IMAGE_MODELS[model]) {
      fail(`element upscale: --model must be one of ${Object.keys(UPSCALE_IMAGE_MODELS).join(', ')}`);
    }
    const scale = Number(f.scale ?? 2);
    const res = await upscaleImage(projectRoot(f.root), {
      mode: 'element', type: f.type, name: f.name, sheet: f.sheet, id: f.id,
      version: f.version, input: f.input, model, scale, task: f.task,
    }, { runner: createRunner({ exec: inheritStderrExec }) });
    console.log(`upscaled ${res.source}${res.task ? `  [task: ${res.task}]` : ''}`);
    console.log(`  -> ${res.outputPath} (${res.model}, ${res.scale}x)`);
    if (res.panels) console.log(`  panels: ${res.panelsDir} (${res.panels.length})`);
  } else if (cmd === 'image' && sub === 'upscale') {
    const f = parseFlags(rest);
    if (!f.input) {
      fail('usage: pipeline image upscale --input <file> [--model topaz_image|bytedance_image_upscale] [--scale 2|4] [--out <dir>] [--root <dir>]');
    }
    const model = f.model || UPSCALE_IMAGE_DEFAULT_MODEL;
    if (!UPSCALE_IMAGE_MODELS[model]) {
      fail(`image upscale: --model must be one of ${Object.keys(UPSCALE_IMAGE_MODELS).join(', ')}`);
    }
    const scale = Number(f.scale ?? 2);
    const res = await upscaleImage(projectRoot(f.root), {
      mode: 'image', input: f.input, out: f.out, model, scale, task: f.task,
    }, { runner: createRunner({ exec: inheritStderrExec }) });
    console.log(`upscaled ${res.source}${res.task ? `  [task: ${res.task}]` : ''}`);
    console.log(`  -> ${res.outputPath} (${res.model}, ${res.scale}x, job ${res.jobId})`);
```

- [ ] **Step 3: Add help lines**

In `printHelp`, after the `shot upscale` help line (~line 394), add:

```javascript
      '  pipeline element upscale --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> [--version <n|latest>] [--model topaz_image|bytedance_image_upscale] [--scale 2|4] [--input <file>]  # enlarge a sheet (panel-aware for turnaround/pose)',
      '  pipeline image upscale --input <file> [--model topaz_image|bytedance_image_upscale] [--scale 2|4] [--out <dir>]  # enlarge any single image',
```

- [ ] **Step 4: Verify arg validation without network**

Run: `node bin/pipeline.js element upscale --type characters --name x --sheet turnaround`
Expected: prints the usage line and exits non-zero (missing `--id`).

Run: `node bin/pipeline.js image upscale --model nope --input /tmp/x.png`
Expected: `image upscale: --model must be one of ...`, non-zero.

Run: `node bin/pipeline.js help | grep -c "upscale"`
Expected: at least `3` (shot + element + image lines).

- [ ] **Step 5: Commit**

```bash
git add bin/pipeline.js
git commit -m "feat(cli): element upscale and image upscale subcommands"
```

---

## Task 7: Full suite + docs sync

**Files:**
- Modify: `README.md` (command reference)
- Modify: `templates/CLAUDE.md` if it enumerates pipeline commands (grep first)

- [ ] **Step 1: Run the whole test suite**

Run: `node --test`
Expected: all tests PASS, including the new files.

- [ ] **Step 2: Grep for command docs to update**

Run: `grep -rn "shot upscale" README.md templates/ docs/recipes/ 2>/dev/null`
For each hit that lists commands, add the parallel `element upscale` /
`image upscale` lines with the same flag summary as the help text.

- [ ] **Step 3: Commit docs**

```bash
git add README.md templates/CLAUDE.md docs/recipes/
git commit -m "docs: document element/image upscale commands"
```

- [ ] **Step 4: Open the PR (per project convention — confirm before merge)**

```bash
git push -u origin HEAD
gh pr create --title "feat: element / image upscale" --body "Implements docs/superpowers/specs/2026-08-25-element-image-upscale-design.md.

- pipeline element upscale — panel-aware for turnaround/pose (upscale each panel, reassemble), flat for cycles/--input
- pipeline image upscale — standalone single-image upscale
- topaz_image (default) + bytedance_image_upscale
- credit accounting: per-panel logging; new 'image' location kind for loose images

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Do NOT merge until the user confirms.

---

## Self-Review Notes

- **Spec coverage:** command surface (Task 6), models table + sizing (Task 4), panel-aware flow + stitch (Tasks 2/5), flat flow (Tasks 4/5), credits per-panel + `image` kind (Tasks 3/5), paths (Task 1), failure handling (Task 5 tests), standalone `--out`/log (Tasks 3/4). All covered.
- **Type consistency:** `upscaleImage(root, spec, deps)`, `stitchPanels(panelPaths, cells, outPath, {sharpImpl})`, `buildOpts(cfg, mediaId, scale, width?, height?)`, opts keys `outputWidth`/`outputHeight`/`resolution`/`variant`, tag format `<scale>x-<model>` — used identically across tasks.
- **Resolved risk:** `src/cli.js` `SCALAR_PARAMS` only emits listed opt keys. `resolution`/`imageReferences` are already wired; `outputWidth`/`outputHeight`/`variant` are added in Task 6 Step 0. Engine unit tests use a fake runner so they pass regardless, but real CLI runs need that mapping — hence it's an explicit step, not left implicit.
