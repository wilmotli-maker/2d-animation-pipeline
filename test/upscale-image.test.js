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
