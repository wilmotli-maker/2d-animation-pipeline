import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { harmonizeVideo, nearestAspect, PREVIS_PROMPT, STYLE_PROMPT, FILTER_STYLE_PROMPT, padVideoFilter } from '../src/harmonize.js';

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'harmonize-'));
  const input = path.join(root, 'clip.mp4');
  await writeFile(input, 'fake-mp4');
  return { root, input };
}

function fakes({ width = 560, height = 752, duration = 6.98, fail = null } = {}) {
  const calls = { uploads: [], batches: [], downloads: [], ff: [], pads: [], aligns: [], corners: [] };
  let n = 0;
  const runner = { async upload(file) { calls.uploads.push(file); return { id: `media-${++n}`, type: 'video', url: `https://x/${n}` }; } };
  const runBatch = async (_runner, jobs) => {
    calls.batches.push(jobs);
    const ref = jobs[0].ref;
    if (fail === ref) return [{ id: `job-${ref}`, status: 'failed', error: 'boom', outputUrl: null }];
    return [{ id: `job-${ref}`, status: 'completed', outputUrl: `https://x/${ref}.mp4` }];
  };
  const downloadTo = async (url, dest) => { calls.downloads.push({ url, dest }); await writeFile(dest, `dl:${url}`); };
  const ffprobe = async () => JSON.stringify({ streams: [{ width, height }], format: { duration } });
  const ff = async (args) => { calls.ff.push(args); const out = args[args.length - 1]; if (typeof out === 'string' && (out.endsWith('.png') || out.endsWith('.mp4'))) await writeFile(out, 'ff'); };
  const padFrame = async (src, out, opts) => { calls.pads.push({ src, out, opts }); await writeFile(out, 'pad'); return { out, margin: opts.margin, width, height }; };
  const alignFraming = async (reference, generated, out, opts) => {
    calls.aligns.push({ reference, generated, out, opts });
    return { applied: false, reason: 'identity', transform: { tx: 0, ty: 0, rot: 0, s: 1 } };
  };
  const sampleCorner = async (file) => { calls.corners.push(file); return '0x9d9d9d'; };
  return { runner, runBatch, downloadTo, ffprobe, ff, padFrame, alignFraming, sampleCorner, calls };
}
const exists = async (p) => { try { await access(p, constants.F_OK); return true; } catch { return false; } };

test('default (filter) guidance: one restyle gen on a b+w+blur guidance clip', async () => {
  const { root, input } = await project();
  const d = fakes();
  const res = await harmonizeVideo(root, { input }, d);

  assert.equal(d.calls.batches.length, 1, 'only one Seedance generation (the restyle)');
  const restyle = d.calls.batches[0][0];
  assert.equal(restyle.ref, 'harmonize');
  assert.equal(restyle.opts.mode, 'video_edit');
  assert.equal(restyle.opts.prompt, FILTER_STYLE_PROMPT);
  assert.equal(restyle.opts.imageReferences.length, 2, 'first+last appearance refs');
  // the guidance clip was built non-generatively with a desaturate+blur filter
  const guide = d.calls.ff.find((a) => a.some((x) => typeof x === 'string' && x.includes('gblur')));
  assert.ok(guide, 'ffmpeg built the b+w+blur guidance');
  assert.ok(guide.some((x) => typeof x === 'string' && x.includes('hue=s=0')));
  assert.equal(res.guidance.mode, 'filter');
  assert.equal(res.jobs.previz, null, 'no previz generation');
  assert.equal(res.outputPath, path.join(root, 'clip.harmonized.mp4'));
});

test('previz guidance: generates a grey maquette then restyles (two gens)', async () => {
  const { root, input } = await project();
  const d = fakes();
  const res = await harmonizeVideo(root, { input, guidance: 'previz' }, d);

  assert.equal(d.calls.batches.length, 2);
  const [previz, restyle] = d.calls.batches.map((b) => b[0]);
  assert.equal(previz.opts.prompt, PREVIS_PROMPT);
  assert.ok(!previz.opts.imageReferences, 'previz has no appearance ref');
  assert.equal(restyle.opts.prompt, STYLE_PROMPT);
  assert.equal(res.guidance.mode, 'previz');
  assert.ok(res.jobs.previz);
  // no gblur filter in previz mode (guidance comes from the generation)
  assert.ok(!d.calls.ff.some((a) => a.some((x) => typeof x === 'string' && x.includes('gblur'))));
});

test('extracts first+last frame as default refs, derives aspect + duration', async () => {
  const { root, input } = await project();
  const d = fakes({ width: 560, height: 752 });
  const res = await harmonizeVideo(root, { input }, d);
  const extracts = d.calls.ff.filter((a) => a[a.length - 1].endsWith('.png'));
  assert.equal(extracts.length, 2);
  assert.equal(res.aspectRatio, '3:4');
  assert.equal(res.duration, 7);
});

test('caller-supplied refs skip extraction', async () => {
  const { root, input } = await project();
  const ref = path.join(root, 'look.png');
  await writeFile(ref, 'png');
  const d = fakes();
  await harmonizeVideo(root, { input, refs: [ref] }, d);
  assert.equal(d.calls.ff.filter((a) => a[a.length - 1].endsWith('.png')).length, 0);
  assert.equal(d.calls.batches[0][0].opts.imageReferences.length, 1);
});

test('writes outputs under --out when given', async () => {
  const { root, input } = await project();
  const res = await harmonizeVideo(root, { input, out: 'harm' }, fakes());
  assert.equal(res.outputPath, path.join(root, 'harm', 'clip.harmonized.mp4'));
});

test('keepPreviz:false removes the guidance intermediate', async () => {
  const { root, input } = await project();
  const res = await harmonizeVideo(root, { input, keepPreviz: false }, fakes());
  assert.equal(res.previzPath, null);
  assert.equal(await exists(path.join(root, 'clip.guidance.mp4')), false);
});

test('a failed restyle throws', async () => {
  const { root, input } = await project();
  await assert.rejects(harmonizeVideo(root, { input }, fakes({ fail: 'harmonize' })), /harmonize did not complete/);
});

test('rejects an unknown guidance mode', async () => {
  const { root, input } = await project();
  await assert.rejects(harmonizeVideo(root, { input, guidance: 'nope' }, fakes()), /guidance must be/);
});

test('the restyle prompt copies the guidance camera and does not ask for a different margin', () => {
  assert.match(FILTER_STYLE_PROMPT, /@Video1 is the camera/);
  assert.match(FILTER_STYLE_PROMPT, /scale the character larger or smaller/);
  assert.doesNotMatch(FILTER_STYLE_PROMPT, /generous margin/i);
  assert.match(STYLE_PROMPT, /scale the character up or down/);
  assert.match(PREVIS_PROMPT, /exact camera framing/);
});

test('pads the guidance video and both stills, then seeds the undo at the pad inverse', async () => {
  const { root, input } = await project();
  const d = fakes({ width: 560, height: 752 });
  const res = await harmonizeVideo(root, { input }, d);
  const pad = d.calls.ff.find((a) => a.some((x) => typeof x === 'string' && x.includes('pad=560:752')));
  assert.ok(pad, 'guidance video was padded');
  assert.match(pad.join(' '), /scale=426:572/);
  assert.match(pad.join(' '), /color=0x9d9d9d/);
  assert.equal(d.calls.pads.length, 2);
  assert.equal(d.calls.pads[0].opts.margin, 0.12);
  const uploaded = d.calls.uploads.map((f) => path.basename(f));
  assert.ok(uploaded.some((n) => n.includes('.guidance.pad.')));
  assert.ok(uploaded.filter((n) => n.endsWith('.pad.png')).length === 2);
  assert.equal(d.calls.aligns[0].reference, input);
  assert.ok(Math.abs(d.calls.aligns[0].opts.seedScale - (1 / 0.76)) < 1e-9);
  assert.equal(res.framing.reason, 'identity');
  const mux = d.calls.ff.find((a) => a.includes('-c:a'));
  assert.match(String(mux[1]), /\.restyled\./);
});

test('muxes the aligned file when the pad undo applies', async () => {
  const { root, input } = await project();
  const d = fakes();
  d.alignFraming = async (reference, generated, out, opts) => {
    d.calls.aligns.push({ reference, generated, out, opts });
    await writeFile(out, 'aligned');
    return { applied: true, reason: 'aligned', transform: { tx: 3, ty: 2.625, rot: 0, s: 1.3308 } };
  };
  const res = await harmonizeVideo(root, { input }, d);
  const mux = d.calls.ff.find((a) => a.includes('-c:a'));
  assert.match(String(mux[1]), /\.aligned\./);
  assert.equal(res.framing.transform.s, 1.3308);
});

test('padMargin 0 skips the pad and seeds the align at identity', async () => {
  const { root, input } = await project();
  const d = fakes();
  await harmonizeVideo(root, { input, padMargin: 0 }, d);
  assert.equal(d.calls.pads.length, 0);
  assert.equal(d.calls.aligns[0].opts.seedScale, 1);
  assert.ok(!d.calls.ff.some((a) => a.some((x) => typeof x === 'string' && x.includes('pad='))));
});

test('padVideoFilter keeps even inner dimensions', () => {
  assert.equal(padVideoFilter(560, 752, 0.12, '0x9d9d9d'), 'scale=426:572,pad=560:752:(ow-iw)/2:(oh-ih)/2:color=0x9d9d9d');
});

test('nearestAspect picks the closest allowed ratio', () => {
  assert.equal(nearestAspect(560, 752), '3:4');
  assert.equal(nearestAspect(1920, 1080), '16:9');
  assert.equal(nearestAspect(1080, 1080), '1:1');
  assert.equal(nearestAspect(0, 0), '3:4');
});
