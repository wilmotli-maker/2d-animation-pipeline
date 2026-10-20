import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { harmonizeVideo, nearestAspect, PREVIS_PROMPT, STYLE_PROMPT } from '../src/harmonize.js';

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'harmonize-'));
  const input = path.join(root, 'clip.mp4');
  await writeFile(input, 'fake-mp4');
  return { root, input };
}

function fakes({ width = 560, height = 752, duration = 6.98, fail = null } = {}) {
  const calls = { uploads: [], batches: [], downloads: [], ff: [] };
  let n = 0;
  const runner = {
    async upload(file) { calls.uploads.push(file); return { id: `media-${++n}`, type: 'video', url: `https://x/${n}` }; },
  };
  const runBatch = async (_runner, jobs) => {
    calls.batches.push(jobs);
    const ref = jobs[0].ref;
    if (fail === ref) return [{ id: `job-${ref}`, status: 'failed', error: 'boom', outputUrl: null }];
    return [{ id: `job-${ref}`, status: 'completed', outputUrl: `https://x/${ref}.mp4` }];
  };
  const downloadTo = async (url, dest) => { calls.downloads.push({ url, dest }); await writeFile(dest, `dl:${url}`); };
  const ffprobe = async () => JSON.stringify({ streams: [{ width, height }], format: { duration } });
  const ff = async (args) => { calls.ff.push(args); const out = args[args.length - 1]; if (out.endsWith('.png') || out.endsWith('.mp4')) await writeFile(out, 'ff'); };
  return { runner, runBatch, downloadTo, ffprobe, ff, calls };
}

const exists = async (p) => { try { await access(p, constants.F_OK); return true; } catch { return false; } };

test('runs previz then restyle with the right Seedance opts', async () => {
  const { root, input } = await project();
  const d = fakes();
  const res = await harmonizeVideo(root, { input }, d);

  assert.equal(d.calls.batches.length, 2, 'two generations');
  const [previz, restyle] = d.calls.batches.map((b) => b[0]);
  // previz: video_edit, no image reference, the previz prompt
  assert.equal(previz.model, 'seedance_2_5');
  assert.equal(previz.opts.mode, 'video_edit');
  assert.equal(previz.opts.generateAudio, false);
  assert.equal(previz.opts.prompt, PREVIS_PROMPT);
  assert.ok(!previz.opts.imageReferences, 'previz has no appearance reference');
  // restyle: image references present, the style prompt
  assert.equal(restyle.opts.prompt, STYLE_PROMPT);
  assert.equal(restyle.opts.imageReferences.length, 2, 'two appearance refs (first+last)');
  // output + previz paths
  assert.equal(res.outputPath, path.join(root, 'clip.harmonized.mp4'));
  assert.equal(res.previzPath, path.join(root, 'clip.previz.mp4'));
  // the final mux ffmpeg call targets the harmonized output, pulling audio from the input
  const mux = d.calls.ff.find((a) => a[a.length - 1] === res.outputPath);
  assert.ok(mux && mux.includes('1:a?'), 'muxes input audio onto the restyled clip');
  assert.deepEqual(res.jobs, { previz: 'job-previz', restyle: 'job-harmonize' });
});

test('extracts first+last frame as default refs, derives aspect from dims', async () => {
  const { root, input } = await project();
  const d = fakes({ width: 560, height: 752 });
  const res = await harmonizeVideo(root, { input }, d);
  // two frame extractions happened (first + last)
  const extracts = d.calls.ff.filter((a) => a[a.length - 1].endsWith('.png'));
  assert.equal(extracts.length, 2);
  assert.equal(res.aspectRatio, '3:4');
  assert.equal(res.duration, 7); // round(6.98)
  // refs uploaded to the restyle: input, previz, then the two refs
  assert.equal(d.calls.uploads.length, 4);
});

test('caller-supplied refs skip extraction', async () => {
  const { root, input } = await project();
  const ref = path.join(root, 'look.png');
  await writeFile(ref, 'png');
  const d = fakes();
  await harmonizeVideo(root, { input, refs: [ref] }, d);
  const extracts = d.calls.ff.filter((a) => a[a.length - 1].endsWith('.png'));
  assert.equal(extracts.length, 0, 'no frame extraction when refs given');
  const restyle = d.calls.batches[1][0];
  assert.equal(restyle.opts.imageReferences.length, 1);
});

test('writes outputs under --out when given', async () => {
  const { root, input } = await project();
  const d = fakes();
  const res = await harmonizeVideo(root, { input, out: 'harm' }, d);
  assert.equal(res.outputPath, path.join(root, 'harm', 'clip.harmonized.mp4'));
});

test('keepPreviz:false removes the previz intermediate', async () => {
  const { root, input } = await project();
  const d = fakes();
  const res = await harmonizeVideo(root, { input, keepPreviz: false }, d);
  assert.equal(res.previzPath, null);
  assert.equal(await exists(path.join(root, 'clip.previz.mp4')), false);
});

test('a failed previz throws and never starts the restyle', async () => {
  const { root, input } = await project();
  const d = fakes({ fail: 'previz' });
  await assert.rejects(harmonizeVideo(root, { input }, d), /previz did not complete/);
  assert.equal(d.calls.batches.length, 1, 'restyle never ran');
});

test('nearestAspect picks the closest allowed ratio', () => {
  assert.equal(nearestAspect(560, 752), '3:4');
  assert.equal(nearestAspect(1920, 1080), '16:9');
  assert.equal(nearestAspect(1080, 1080), '1:1');
  assert.equal(nearestAspect(0, 0), '3:4');
});
