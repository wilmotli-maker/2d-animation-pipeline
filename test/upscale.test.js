import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { upscaleShot, UPSCALE_MODELS, UPSCALE_DEFAULT_MODEL } from '../src/upscale.js';
import { shotUpscalePath } from '../src/paths.js';

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'upscale-'));
  return root;
}

// A finalized shot as promoteDraft leaves it: final/<shotId>-vNNN.mp4
async function withFinal(root, shotId, name = `${shotId}-v002.mp4`) {
  const dir = path.join(root, 'shots', shotId, 'final');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), 'fake-mp4');
  return path.join(dir, name);
}

function fakes({ status = 'completed', outputUrl = 'https://x/up.mp4' } = {}) {
  const calls = { uploads: [], batches: [], downloads: [] };
  const runner = {
    async upload(file) { calls.uploads.push(file); return { id: 'media-1', type: 'video', url: 'https://x/in.mp4' }; },
    async estimateCost() { return 3; },
  };
  const runBatch = async (_runner, jobs) => {
    calls.batches.push(jobs);
    return [{ id: 'job-1', status, outputUrl: status === 'completed' ? outputUrl : null }];
  };
  const downloadTo = async (url, dest) => { calls.downloads.push({ url, dest }); };
  return { runner, runBatch, downloadTo, calls };
}

test('upscaleShot uploads the source and passes it by media id', async () => {
  const root = await project();
  const src = await withFinal(root, 's010');
  const { runner, runBatch, downloadTo, calls } = fakes();

  const res = await upscaleShot(root, { shotId: 's010' }, { runner, runBatch, downloadTo });

  assert.deepEqual(calls.uploads, [src]);
  const [job] = calls.batches[0];
  assert.equal(job.model, 'topaz_video');
  assert.deepEqual(job.opts.videoReferences, ['media-1']);
  assert.equal(job.opts.resolution, '1080p');
  assert.equal(res.mediaId, 'media-1');
  assert.equal(res.source, src);
});

test('output and sidecar land beside the clip, named by resolution', async () => {
  const root = await project();
  await withFinal(root, 's010');
  const { runner, runBatch, downloadTo, calls } = fakes();

  const res = await upscaleShot(root, { shotId: 's010', resolution: '2160p' }, { runner, runBatch, downloadTo });

  assert.equal(res.outputPath, shotUpscalePath(root, 's010', null, '2160p'));
  assert.match(res.outputPath, /final\/upscaled-2160p\.mp4$/);
  assert.equal(calls.downloads[0].dest, res.outputPath);

  const sidecar = JSON.parse(await readFile(res.sidecar, 'utf8'));
  assert.equal(sidecar.jobId, 'job-1');
  assert.equal(sidecar.model, 'topaz_video');
  assert.equal(sidecar.resolution, '2160p');
  assert.equal(sidecar.sourceMediaId, 'media-1');
});

test('a draft version writes into that draft folder', async () => {
  const root = await project();
  const dir = path.join(root, 'shots', 's010', 'drafts', 'v003');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'output.mp4'), 'fake');
  const { runner, runBatch, downloadTo } = fakes();

  const res = await upscaleShot(root, { shotId: 's010', version: 3 }, { runner, runBatch, downloadTo });
  assert.match(res.outputPath, /drafts\/v003\/upscaled-1080p\.mp4$/);
});

test('--input overrides source resolution entirely', async () => {
  const root = await project();
  await withFinal(root, 's010');
  const custom = path.join(root, 'elsewhere.mp4');
  await writeFile(custom, 'fake');
  const { runner, runBatch, downloadTo, calls } = fakes();

  const res = await upscaleShot(root, { shotId: 's010', input: custom }, { runner, runBatch, downloadTo });
  assert.deepEqual(calls.uploads, [custom]);
  assert.equal(res.source, custom);
});

test('bytedance sends its aigc defaults', async () => {
  const root = await project();
  await withFinal(root, 's010');
  const { runner, runBatch, downloadTo, calls } = fakes();

  await upscaleShot(root, { shotId: 's010', model: 'bytedance_video_upscale' }, { runner, runBatch, downloadTo });
  const [job] = calls.batches[0];
  assert.equal(job.opts.modelVersion, 'pro');
  assert.equal(job.opts.preset, 'aigc');
  // topaz-only flag must not leak into a bytedance call
  assert.equal(job.opts.aspectRatio, undefined);
});

test('topaz omits aspect_ratio unless asked, and forwards it when given', async () => {
  const root = await project();
  await withFinal(root, 's010');

  let f = fakes();
  await upscaleShot(root, { shotId: 's010' }, f);
  assert.equal(f.calls.batches[0][0].opts.aspectRatio, undefined);

  f = fakes();
  await upscaleShot(root, { shotId: 's010', aspectRatio: '3:4' }, f);
  assert.equal(f.calls.batches[0][0].opts.aspectRatio, '3:4');
});

test('rejects an unknown model and an unsupported resolution', async () => {
  const root = await project();
  await withFinal(root, 's010');
  const f = fakes();

  await assert.rejects(
    () => upscaleShot(root, { shotId: 's010', model: 'nope' }, f),
    /unknown upscale model/,
  );
  // 720p is not an upscale target — topaz starts at 1080p
  await assert.rejects(
    () => upscaleShot(root, { shotId: 's010', resolution: '720p' }, f),
    /--resolution must be one of/,
  );
});

test('a failed job throws instead of writing a partial result', async () => {
  const root = await project();
  await withFinal(root, 's010');
  const f = fakes({ status: 'failed' });
  await assert.rejects(() => upscaleShot(root, { shotId: 's010' }, f), /did not complete/);
  assert.equal(f.calls.downloads.length, 0);
});

test('a failed upscale logs to shot generations.jsonl', async () => {
  const root = await project();
  await withFinal(root, 's010');
  const f = fakes({ status: 'error' });
  await assert.rejects(() => upscaleShot(root, { shotId: 's010' }, f), /did not complete/);
  const log = JSON.parse(
    (await readFile(path.join(root, 'shots', 's010', 'generations.jsonl'), 'utf8')).trim());
  assert.equal(log.status, 'failed');
  assert.equal(log.failurePhase, 'generation');
  assert.equal(log.kind, 'upscale');
  assert.equal(log.billedLikely, true);
});

test('a missing shot version reports the path rather than uploading', async () => {
  const root = await project();
  const f = fakes();
  await assert.rejects(() => upscaleShot(root, { shotId: 'ghost' }, f), /no such shot version/);
  assert.equal(f.calls.uploads.length, 0);
});

test('model table exposes the documented defaults', () => {
  assert.equal(UPSCALE_DEFAULT_MODEL, 'topaz_video');
  assert.deepEqual(UPSCALE_MODELS.topaz_video.resolutions, ['1080p', '2160p']);
  assert.deepEqual(UPSCALE_MODELS.bytedance_video_upscale.resolutions, ['1080p', '2k', '4k']);
});
