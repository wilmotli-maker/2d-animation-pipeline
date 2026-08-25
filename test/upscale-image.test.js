import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { upscaleImage, UPSCALE_IMAGE_MODELS, UPSCALE_IMAGE_DEFAULT_MODEL } from '../src/upscale-image.js';
import { elementUpscalePath } from '../src/paths.js';
import { SHEET_PANEL_LABELS } from '../src/split-panels.js';

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

// Lay down a sheet version and its panel folder.
async function withSheet(root, { type = 'characters', name = 'ndiva', sheet = 'turnaround', id = 'front', v = 'v001' } = {}) {
  const dir = path.join(root, 'elements', type, name, 'sheets', sheet, id);
  await mkdir(path.join(dir, v), { recursive: true });
  await writeFile(path.join(dir, `${v}.png`), 'sheet');
  for (const label of SHEET_PANEL_LABELS[sheet] || []) {
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
  assert.equal(res.outputPath, elementUpscalePath(root, s.type, s.name, s.sheet, s.id, s.v, '2x-topaz_image'));
  // composite is prefixed by the source version stem
  assert.match(res.outputPath, /v001\.upscaled-2x-topaz_image\.png$/);
  assert.equal(f.stitched.length, 1);
  assert.equal(f.stitched[0].outPath, res.outputPath);
  // per-panel files under <stem>.upscaled-<tag>/
  assert.match(f.calls.downloads[0].dest, /v001\.upscaled-2x-topaz_image\/.*\.png$/);

  // each panel estimates its own credits (fakes estimateCost => 3), logged per panel
  const logPath = path.join(root, 'elements', s.type, s.name, 'generations.jsonl');
  const entries = (await readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const panelEntries = entries.filter((e) => e.panel && e.status === 'generated');
  assert.equal(panelEntries.length, 6);
  for (const e of panelEntries) {
    assert.equal(e.credits, 3);
    assert.equal(e.creditsSource, 'api');
    assert.equal(e.kind, 'upscale');
  }
});

test('cycles (no panels) takes the flat flow into the sheet dir', async () => {
  const root = await project();
  const s = await withSheet(root, { sheet: 'cycles', id: 'walk' });
  // cycles has no panel folder; ensure the version file exists
  const f = panelFakes();
  const res = await upscaleImage(root, { mode: 'element', type: s.type, name: s.name, sheet: 'cycles', id: 'walk', scale: 2 }, f);
  assert.equal(f.calls.uploads.length, 1);
  assert.equal(f.stitched.length, 0);
  assert.match(res.outputPath, /sheets\/cycles\/walk\/v001\.upscaled-2x-topaz_image\.png$/);
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
