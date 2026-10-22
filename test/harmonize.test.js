import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { harmonizeVideo, nearestAspect, chromaRestoreGain, restoreWashedChroma, PREVIS_PROMPT, STYLE_PROMPT, FILTER_STYLE_PROMPT } from '../src/harmonize.js';

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'harmonize-'));
  const input = path.join(root, 'clip.mp4');
  await writeFile(input, 'fake-mp4');
  return { root, input };
}

function fakes({ width = 560, height = 752, duration = 6.98, fail = null } = {}) {
  const calls = { uploads: [], batches: [], downloads: [], ff: [] };
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
  const ff = async (args) => { calls.ff.push(args); const out = args[args.length - 1]; if (out.endsWith('.png') || out.endsWith('.mp4')) await writeFile(out, 'ff'); };
  const restoreChroma = async () => ({ applied: false, framesBoosted: 0, maxGain: 1 });
  return { runner, runBatch, downloadTo, ffprobe, ff, restoreChroma, calls };
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

test('chromaRestoreGain lifts every frame short of the source and leaves a stronger one alone', () => {
  assert.equal(chromaRestoreGain(120, 110), 120 / 110);
  assert.equal(chromaRestoreGain(120, 70), 120 / 70);
  assert.equal(chromaRestoreGain(120, 130), 1); // already stronger than the source
  assert.equal(chromaRestoreGain(120, 8), 1); // hue is gone; a gain would amplify noise
  assert.equal(chromaRestoreGain(120, 0), 1);
  assert.equal(chromaRestoreGain(0, 40), 1);
  assert.equal(chromaRestoreGain(300, 20), 3); // capped
});

test('muxes audio onto the chroma-restored clip when the restyle came back washed', async () => {
  const { root, input } = await project();
  const d = fakes();
  const seen = [];
  d.restoreChroma = async (source, result, out) => {
    seen.push({ source, result, out });
    await writeFile(out, 'chroma');
    return { applied: true, framesBoosted: 40, maxGain: 1.8 };
  };
  const res = await harmonizeVideo(root, { input }, d);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].source, input);
  assert.match(seen[0].result, /\.restyled\./);
  const mux = d.calls.ff.find((a) => a.includes('-c:v') && a.includes('copy'));
  assert.equal(mux[1], seen[0].out, 'audio is muxed onto the chroma-restored video');
  assert.equal(res.chroma.framesBoosted, 40);
  assert.equal(res.chroma.maxGain, 1.8);
  assert.equal(await exists(seen[0].out), false, 'the temp restored clip is removed');
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${r.status}: ${r.stderr}`);
}

// Mean channel-difference of the centre of one frame. The test plate is flat grey, so the
// centre is the coloured box and this tracks how much colour survived.
async function centerChroma(file, frame) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),crop=16:16:32:24`, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`ffmpeg ${r.status}: ${r.stderr}`);
  const buf = r.stdout;
  let chroma = 0, n = 0;
  for (let p = 0; p < buf.length; p += 3) {
    chroma += Math.abs(buf[p] - buf[p + 1]) + Math.abs(buf[p + 1] - buf[p + 2]) + Math.abs(buf[p + 2] - buf[p]);
    n++;
  }
  return n ? chroma / n : 0;
}

test('restoreWashedChroma recolours only the frames the restyle washed out', { skip: !hasFfmpeg && 'ffmpeg not on PATH' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chroma-'));
  const src = path.join(dir, 'src.mp4');
  const washed = path.join(dir, 'washed.mp4');
  const out = path.join(dir, 'out.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x9a9a9a:s=80x64:r=24', '-frames:v', '16', '-vf', 'drawbox=x=24:y=16:w=32:h=32:color=0xdd3355@1:t=fill', '-pix_fmt', 'yuv420p', src]);
  ffmpeg(['-i', src, '-vf', "hue=s=0.35:enable='lt(n,8)'", '-pix_fmt', 'yuv420p', washed]);

  const unchanged = await restoreWashedChroma(src, src, path.join(dir, 'same.mp4'));
  assert.equal(unchanged.applied, false);

  const res = await restoreWashedChroma(src, washed, out);
  assert.equal(res.applied, true);
  assert.ok(res.framesBoosted >= 6 && res.framesBoosted <= 8, `boosted ${res.framesBoosted} frames`);

  const [srcEarly, washedEarly, outEarly, washedLate, outLate] = await Promise.all([
    centerChroma(src, 2), centerChroma(washed, 2), centerChroma(out, 2),
    centerChroma(washed, 12), centerChroma(out, 12),
  ]);
  assert.ok(outEarly > washedEarly * 1.4, `washed frame chroma ${washedEarly} -> ${outEarly}`);
  assert.ok(Math.abs(outEarly - srcEarly) < Math.abs(washedEarly - srcEarly), 'restored frame is closer to the source');
  assert.ok(Math.abs(outLate - washedLate) < 20, `coloured frame should stay put (${washedLate} vs ${outLate})`);
});

test('nearestAspect picks the closest allowed ratio', () => {
  assert.equal(nearestAspect(560, 752), '3:4');
  assert.equal(nearestAspect(1920, 1080), '16:9');
  assert.equal(nearestAspect(1080, 1080), '1:1');
  assert.equal(nearestAspect(0, 0), '3:4');
});
