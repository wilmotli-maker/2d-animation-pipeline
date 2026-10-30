import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { harmonizeVideo, nearestAspect, splicedGenSpan, selectiveGreyFilter, selectiveFilterPrompt, parseSatAvg, parseMeanStat, chromaGain, lumaMap, PREVIS_PROMPT, STYLE_PROMPT, FILTER_STYLE_PROMPT, filterStylePrompt, previzStylePrompt, restyleStyleClause, BORDER_PROMPT_CLAUSE, padVideoFilter, COMPOSITE_SCENE_PROMPT, compositeScenePrompt } from '../src/harmonize.js';

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'harmonize-'));
  const input = path.join(root, 'clip.mp4');
  await writeFile(input, 'fake-mp4');
  return { root, input };
}

function fakes({ width = 560, height = 752, duration = 6.98, fail = null, satSource = null, satHarm = null, lumaSource = null, lumaHarm = null } = {}) {
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
  const ff = async (args) => {
    calls.ff.push(args);
    // A signalstats measurement pass ends in `-f null -`; return canned SATAVG + YLOW/YHIGH for the
    // source (plain input) or the restyle (the `.restyled.`/`.aligned.` temp), so the conform runs.
    if (args.includes('-f') && args[args.indexOf('-f') + 1] === 'null') {
      const file = args[args.indexOf('-i') + 1];
      const isHarm = file.includes('.restyled.') || file.includes('.aligned.');
      const v = isHarm ? satHarm : satSource;
      const lo = isHarm ? lumaHarm : lumaSource; // [ylow, yhigh] | null
      let s = 'frame\n';
      if (v != null) s += `lavfi.signalstats.SATAVG=${v}\n`;
      if (lo) s += `lavfi.signalstats.YLOW=${lo[0]}\nlavfi.signalstats.YHIGH=${lo[1]}\n`;
      return s;
    }
    const out = args[args.length - 1];
    if (typeof out === 'string' && (out.endsWith('.png') || out.endsWith('.mp4'))) await writeFile(out, 'ff');
    return '';
  };
  const padFrame = async (src, out, opts) => { calls.pads.push({ src, out, opts }); await writeFile(out, 'pad'); return { out, margin: opts.margin, width, height }; };
  const alignFraming = async (reference, generated, out, opts) => {
    calls.aligns.push({ reference, generated, out, opts });
    return { applied: false, reason: 'identity', transform: { tx: 0, ty: 0, rot: 0, s: 1 } };
  };
  const sampleCorner = async (file) => { calls.corners.push(file); return '0x9d9d9d'; };
  return { runner, runBatch, downloadTo, ffprobe, ff, padFrame, alignFraming, sampleCorner, calls };
}
const mux = (calls) => calls.ff.find((a) => a.includes('-map') && a.includes('0:v'));
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

test('passthrough guidance: one restyle gen on a full-colour guidance clip, no pad', async () => {
  const { root, input } = await project();
  const ref = path.join(root, 'composite-still.png');
  await writeFile(ref, 'png');
  const d = fakes();
  const res = await harmonizeVideo(root, { input, guidance: 'passthrough', refs: [ref] }, d);

  assert.equal(d.calls.batches.length, 1, 'only one Seedance generation (the restyle)');
  const restyle = d.calls.batches[0][0];
  assert.equal(restyle.ref, 'harmonize');
  assert.equal(restyle.opts.prompt, COMPOSITE_SCENE_PROMPT);
  // guidance is built non-generatively but WITHOUT desaturation/blur (keeps the source colour)
  assert.ok(!d.calls.ff.some((a) => a.some((x) => typeof x === 'string' && x.includes('hue=s=0'))), 'no desaturate');
  assert.ok(!d.calls.ff.some((a) => a.some((x) => typeof x === 'string' && x.includes('gblur'))), 'no blur');
  // passthrough defaults to no pad
  assert.equal(d.calls.pads.length, 0, 'no stills padded');
  assert.ok(!d.calls.ff.some((a) => a.some((x) => typeof x === 'string' && x.startsWith('scale=iw*'))), 'guidance not padded');
  assert.equal(res.guidance.mode, 'passthrough');
  assert.equal(res.jobs.previz, null);
});

test('passthrough: spec.prompt overrides the composite-scene prompt', async () => {
  const { root, input } = await project();
  const ref = path.join(root, 'still.png');
  await writeFile(ref, 'png');
  const d = fakes();
  await harmonizeVideo(root, { input, guidance: 'passthrough', refs: [ref], prompt: 'CUSTOM PROMPT' }, d);
  assert.equal(d.calls.batches[0][0].opts.prompt, 'CUSTOM PROMPT');
});

test('the composite-scene prompt asks for the scene instead of forbidding scenery', () => {
  // The filter prompt forbids scenery (flat-plate restyle); the composite prompt must do the opposite.
  assert.match(COMPOSITE_SCENE_PROMPT, /TARGET STILL/);
  assert.match(COMPOSITE_SCENE_PROMPT, /full colour/i);
  assert.match(COMPOSITE_SCENE_PROMPT, /contact shadow/i);
  assert.doesNotMatch(COMPOSITE_SCENE_PROMPT, /add no scenery/i);
  assert.equal(COMPOSITE_SCENE_PROMPT, compositeScenePrompt(''));
  assert.match(compositeScenePrompt('crayon look'), /crayon look/);
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

test('splicedGenSpan is the retimed gen window in the spliced output', () => {
  assert.deepEqual(splicedGenSpan({ retime: true, inPoint: { origFrame: 55 }, outPoint: { origFrame: 146 } }), [55, 146]);
  assert.equal(splicedGenSpan({ retime: false, inPoint: { origFrame: 55 }, outPoint: { origFrame: 146 } }), null);
  assert.equal(splicedGenSpan(null), null);
});

test('a gen span greys only that window and tells the restyle to keep the coloured ends', async () => {
  const { root, input } = await project();
  const d = fakes();
  await harmonizeVideo(root, { input, genSpan: [48, 96] }, d);
  const guide = d.calls.ff.find((a) => a.some((x) => typeof x === 'string' && x.includes('gblur')));
  assert.equal(guide[guide.indexOf('-vf') + 1], selectiveGreyFilter(48, 96, 1.2));
  const prompt = d.calls.batches[0][0].opts.prompt;
  assert.equal(prompt, selectiveFilterPrompt(48, 96, 24));
  assert.match(prompt, /From 2\.00s to 4\.00s/);
  assert.match(prompt, /ONLY part to repaint/);
  assert.doesNotMatch(prompt, /black-and-white guidance pass/);
});

test('parseSatAvg averages the SATAVG lines, null when none', () => {
  assert.equal(parseSatAvg('lavfi.signalstats.SATAVG=6\nlavfi.signalstats.SATAVG=8\n'), 7);
  assert.equal(parseSatAvg('no stats here'), null);
  assert.equal(parseSatAvg(''), null);
  assert.equal(parseSatAvg(undefined), null);
});

test('chromaGain lifts harmonized onto source, clamped, with a deadband and grey guard', () => {
  assert.ok(Math.abs(chromaGain(8, 7) - 8 / 7) < 1e-9, 'ratio when both are saturated');
  assert.equal(chromaGain(8.0, 7.9), 1, 'inside the deadband -> no change');
  assert.equal(chromaGain(100, 1), 2.0, 'clamped to max');
  assert.equal(chromaGain(1, 100), 0.5, 'clamped to min');
  assert.equal(chromaGain(0.2, 7), 1, 'grey source -> no change');
  assert.equal(chromaGain(7, 0.2), 1, 'grey restyle -> no change');
  assert.equal(chromaGain(null, 7), 1, 'missing measurement -> no change');
});

test('parseMeanStat averages an arbitrary signalstats key', () => {
  assert.equal(parseMeanStat('lavfi.signalstats.YLOW=60\nlavfi.signalstats.YLOW=70\n', 'YLOW'), 65);
  assert.equal(parseMeanStat('lavfi.signalstats.YHIGH=150\n', 'YHIGH'), 150);
  assert.equal(parseMeanStat('nope', 'YLOW'), null);
});

test('lumaMap fits the source tonal range, identity when untrustworthy', () => {
  // v013 numbers: harm (61.47,150.17) onto src (66.02,141.20) -> contrast-reducing map.
  const m = lumaMap({ ylow: 66.02, yhigh: 141.20 }, { ylow: 61.47, yhigh: 150.17 });
  assert.ok(Math.abs(m.a - 75.18 / 88.70) < 1e-3, `slope ${m.a}`);
  assert.ok(Math.abs((m.a * 61.47 + m.b) - 66.02) < 1e-6, 'lands YLOW on source');
  assert.ok(Math.abs((m.a * 150.17 + m.b) - 141.20) < 1e-6, 'lands YHIGH on source');
  // identities
  assert.deepEqual(lumaMap({ ylow: 66, yhigh: 141 }, { ylow: 66, yhigh: 141 }), { a: 1, b: 0 }, 'already matched');
  assert.deepEqual(lumaMap(null, { ylow: 61, yhigh: 150 }), { a: 1, b: 0 }, 'missing source');
  assert.deepEqual(lumaMap({ ylow: 120, yhigh: 125 }, { ylow: 120, yhigh: 125 }), { a: 1, b: 0 }, 'near-flat clip');
  assert.equal(lumaMap({ ylow: 10, yhigh: 240 }, { ylow: 120, yhigh: 135 }).a, 2.0, 'slope clamps to max');
});

test('chroma match measures source vs restyle and applies one hue=s gain', async () => {
  const { root, input } = await project();
  const d = fakes({ satSource: 8, satHarm: 7 });
  const res = await harmonizeVideo(root, { input }, d);
  assert.ok(Math.abs(res.chroma.gain - 8 / 7) < 1e-4);
  assert.equal(res.chroma.sourceSat, 8);
  assert.equal(res.chroma.harmonizedSat, 7);
  const m = mux(d.calls);
  const vf = m[m.indexOf('-vf') + 1];
  assert.match(vf, /^hue=s=1\.14/, 'applied the measured gain');
  assert.ok(m.includes('libx264'), 're-encodes video to apply the filter');
});

test('chroma + luma apply together in one conform pass', async () => {
  const { root, input } = await project();
  const d = fakes({ satSource: 8, satHarm: 7, lumaSource: [66.02, 141.20], lumaHarm: [61.47, 150.17] });
  const res = await harmonizeVideo(root, { input }, d);
  assert.ok(Math.abs(res.chroma.gain - 8 / 7) < 1e-4);
  assert.ok(res.luma.a < 1, 'contrast-reducing luma map');
  const vf = mux(d.calls)[mux(d.calls).indexOf('-vf') + 1];
  assert.match(vf, /hue=s=/);
  assert.match(vf, /lutyuv='y=clip\(0\.8\d+\*val/);
});

test('a matched clip keeps the stream-copy path (no re-encode)', async () => {
  const { root, input } = await project();
  const d = fakes({ satSource: 7, satHarm: 7, lumaSource: [66, 141], lumaHarm: [66, 141] });
  const res = await harmonizeVideo(root, { input }, d);
  assert.equal(res.chroma.gain, 1);
  assert.equal(res.luma.a, 1);
  const m = mux(d.calls);
  assert.ok(!m.includes('-vf'), 'no filter');
  assert.ok(m.includes('copy'), 'stream-copies the video');
});

test('chroma:false skips the gain but luma still conforms', async () => {
  const { root, input } = await project();
  const d = fakes({ satSource: 8, satHarm: 7, lumaSource: [66, 141], lumaHarm: [61, 150] });
  const res = await harmonizeVideo(root, { input, chroma: false }, d);
  assert.equal(res.chroma.gain, 1, 'no chroma gain');
  assert.ok(res.luma.a !== 1, 'luma still conformed');
  const vf = mux(d.calls)[mux(d.calls).indexOf('-vf') + 1];
  assert.doesNotMatch(vf, /hue=s=/);
  assert.match(vf, /lutyuv/);
});

test('chroma:false + luma:false skips every measurement', async () => {
  const { root, input } = await project();
  const d = fakes({ satSource: 8, satHarm: 7, lumaSource: [66, 141], lumaHarm: [61, 150] });
  const res = await harmonizeVideo(root, { input, chroma: false, luma: false }, d);
  assert.equal(res.chroma.gain, 1);
  assert.equal(res.luma.a, 1);
  assert.ok(!d.calls.ff.some((a) => a.includes('-f') && a[a.indexOf('-f') + 1] === 'null'), 'no signalstats pass');
  assert.ok(mux(d.calls).includes('copy'));
});

test('a gen span measures the source only outside the window', async () => {
  const { root, input } = await project();
  const d = fakes({ satSource: 8, satHarm: 7 });
  await harmonizeVideo(root, { input, genSpan: [48, 96] }, d);
  const srcMeas = d.calls.ff.find((a) => a.includes('-f') && a[a.indexOf('-f') + 1] === 'null'
    && a[a.indexOf('-i') + 1] === input);
  const vf = srcMeas[srcMeas.indexOf('-vf') + 1];
  assert.match(vf, /select='not\(between\(n\\,48\\,95\)\)'/);
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

test('selective grey filter desaturates only the gen span', { skip: !hasFfmpeg && 'ffmpeg not on PATH' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'selective-'));
  const src = path.join(dir, 'src.mp4');
  const out = path.join(dir, 'guidance.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x9a9a9a:s=80x64:r=24', '-frames:v', '16', '-vf', 'drawbox=x=24:y=16:w=32:h=32:color=0xdd3355@1:t=fill', '-pix_fmt', 'yuv420p', src]);
  ffmpeg(['-i', src, '-vf', selectiveGreyFilter(4, 12, 0.4), '-pix_fmt', 'yuv420p', out]);
  const [head, mid, tail] = await Promise.all([centerChroma(out, 1), centerChroma(out, 6), centerChroma(out, 14)]);
  assert.ok(head > 80, `head stayed coloured (${head})`);
  assert.ok(mid < 15, `gen span is grey (${mid})`);
  assert.ok(tail > 80, `tail stayed coloured (${tail})`);
});

function meanSat(file, vf) {
  const chain = (vf ? `${vf},` : '') + 'signalstats,metadata=print:file=-';
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', chain, '-an', '-f', 'null', '-'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${r.status}: ${r.stderr}`);
  return parseSatAvg(r.stdout);
}

test('the chroma gain lifts a washed clip onto the source saturation', { skip: !hasFfmpeg && 'ffmpeg not on PATH' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chroma-'));
  const src = path.join(dir, 'src.mp4');       // a coloured character box on a flat grey plate
  const washed = path.join(dir, 'washed.mp4'); // the same, a touch desaturated (a "washed" restyle)
  const fixed = path.join(dir, 'fixed.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x9a9a9a:s=80x64:r=24', '-frames:v', '12', '-vf', 'drawbox=x=24:y=16:w=32:h=32:color=0xdd3355@1:t=fill', '-pix_fmt', 'yuv420p', src]);
  ffmpeg(['-i', src, '-vf', 'hue=s=0.7', '-pix_fmt', 'yuv420p', washed]);

  const srcSat = meanSat(src);
  const washedSat = meanSat(washed);
  const gain = chromaGain(srcSat, washedSat);
  assert.ok(gain > 1.2 && gain <= 2.0, `a washed clip needs a real lift within the clamp (${gain})`);

  ffmpeg(['-i', washed, '-vf', `hue=s=${gain.toFixed(4)}`, '-pix_fmt', 'yuv420p', fixed]);
  const fixedSat = meanSat(fixed);
  assert.ok(Math.abs(fixedSat - srcSat) / srcSat < 0.05, `fixed (${fixedSat}) lands within 5% of source (${srcSat})`);
  assert.ok(Math.abs(fixedSat - washedSat) / washedSat > 0.3, 'and it meaningfully moved from the washed value');
});

test('the restyle prompt copies the guidance camera and does not ask for a different margin', () => {
  assert.match(FILTER_STYLE_PROMPT, /@Video1 is the camera/);
  assert.match(FILTER_STYLE_PROMPT, /scale the character larger or smaller/);
  assert.doesNotMatch(FILTER_STYLE_PROMPT, /generous margin/i);
  assert.match(STYLE_PROMPT, /scale the character up or down/);
  assert.match(PREVIS_PROMPT, /exact camera framing/);
});

test('the no-lock restyle prompt is medium-neutral — defers style to the refs, imposes no 2D look', () => {
  // The old bug: the restyle hardcoded "hand-drawn 2D cartoon", overriding a 3D character's style.
  // The generic (no style lock) prompt must NOT positively assert a 2D/cartoon target, and must say
  // to defer render style to the references.
  assert.doesNotMatch(FILTER_STYLE_PROMPT, /crisp finished hand-drawn 2D rendering/i);
  assert.doesNotMatch(FILTER_STYLE_PROMPT, /uniformly-styled 2D cartoon/i);
  assert.match(FILTER_STYLE_PROMPT, /do not force a 3D or photoreal look onto 2D references/i);
  assert.doesNotMatch(STYLE_PROMPT, /hand-drawn 2D\b/i);
  // Equality with the builders' no-lock output keeps the exported constants in sync.
  assert.equal(FILTER_STYLE_PROMPT, filterStylePrompt(''));
  assert.equal(STYLE_PROMPT, previzStylePrompt(''));
});

test('a style lock is folded verbatim into the restyle prompt (filter and previz)', () => {
  const lock = 'Polished stylized 3D render, no flat 2D, no cel-shading.';
  assert.match(filterStylePrompt(lock), /in this exact style: Polished stylized 3D render, no flat 2D, no cel-shading\./);
  assert.match(previzStylePrompt(lock), /Polished stylized 3D render, no flat 2D, no cel-shading\./);
  // With a lock present the generic anti-2D hedging is dropped (the lock is the authority).
  assert.doesNotMatch(filterStylePrompt(lock), /unless the references are themselves in that style/i);
  // Shared helper drives both this and buildTrimPrompt's design block.
  assert.match(restyleStyleClause(lock), /in this exact style: /);
});

test('spec.styleLock reaches the submitted restyle prompt', async () => {
  const { root, input } = await project();
  const d = fakes();
  await harmonizeVideo(root, { input, styleLock: 'a cobalt-blue 3D-rendered boy' }, d);
  const restyle = d.calls.batches[0][0];
  assert.match(restyle.opts.prompt, /a cobalt-blue 3D-rendered boy/);
});

test('spec.border draws a border on the guidance and appends the whitelist clause', async () => {
  const { root, input } = await project();
  const d = fakes();
  await harmonizeVideo(root, { input, padMargin: 0, border: { px: 20 } }, d);
  const boxed = d.calls.ff.find((a) => a.some((x) => typeof x === 'string' && /drawbox=.*t=20/.test(x)));
  assert.ok(boxed, 'ffmpeg drew a 20px border');
  const restyle = d.calls.batches[0][0];
  assert.match(restyle.opts.prompt, /FRAME BORDER:/);
  assert.ok(restyle.opts.prompt.includes(BORDER_PROMPT_CLAUSE));
});

test('spec.prompt overrides the composed restyle prompt entirely', async () => {
  const { root, input } = await project();
  const d = fakes();
  await harmonizeVideo(root, { input, prompt: 'OVERRIDE PROMPT', styleLock: 'ignored lock' }, d);
  assert.equal(d.calls.batches[0][0].opts.prompt, 'OVERRIDE PROMPT');
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

test('keepRaw writes the pre-conform result beside the conformed output', async () => {
  const { root, input } = await project();
  const d = fakes({ satSource: 8, satHarm: 4 }); // conform active, so raw != conformed
  const res = await harmonizeVideo(root, { input, keepRaw: true }, d);
  assert.equal(res.rawPath, path.join(root, 'clip.harmonized.raw.mp4'));
  assert.ok(await exists(res.rawPath));
  const rawMux = d.calls.ff.find((a) => a[a.length - 1] === res.rawPath);
  assert.ok(rawMux, 'raw mux call present');
  const vf = rawMux[rawMux.indexOf('-vf') + 1];
  assert.equal(vf, 'setsar=1'); // SAR normalized, but NO hue=/lutyuv conform
  assert.ok(!/hue=|lutyuv/.test(rawMux.join(' ')));
});

test('no raw output unless keepRaw is set', async () => {
  const { root, input } = await project();
  const d = fakes({ satSource: 8, satHarm: 4 });
  const res = await harmonizeVideo(root, { input }, d);
  assert.equal(res.rawPath, null);
  assert.ok(!(await exists(path.join(root, 'clip.harmonized.raw.mp4'))));
});

test('passes a margin-matched maxScale so a large pad can be undone', async () => {
  const { root, input } = await project();
  const d = fakes();
  await harmonizeVideo(root, { input, padMargin: 0.25 }, d);
  const { seedScale, maxScale } = d.calls.aligns[0].opts;
  assert.ok(Math.abs(seedScale - 2) < 1e-9, 'seedScale = 1/(1-2*0.25) = 2');
  // 2 * 1.15 = 2.3 > seedScale, so alignFraming can apply the undo instead of rejecting it.
  assert.ok(Math.abs(maxScale - 2.3) < 1e-9);
  assert.ok(maxScale > seedScale);
});

test('the default pad still gets a maxScale (>= the 1.6 floor)', async () => {
  const { root, input } = await project();
  const d = fakes();
  await harmonizeVideo(root, { input }, d); // margin 0.12 -> seedScale 1.316, below the 1.6 floor
  assert.equal(d.calls.aligns[0].opts.maxScale, 1.6);
});

test('normalizes SAR to 1:1 on the re-encode mux path', async () => {
  const { root, input } = await project();
  const d = fakes({ satSource: 8, satHarm: 4 }); // chroma gain != 1 -> filter (re-encode) branch
  await harmonizeVideo(root, { input }, d);
  const vf = mux(d.calls)[mux(d.calls).indexOf('-vf') + 1];
  assert.match(vf, /(^|,)setsar=1$/);
});

test('normalizes SAR to 1:1 on the stream-copy mux path', async () => {
  const { root, input } = await project();
  const d = fakes(); // no conform -> copy branch
  await harmonizeVideo(root, { input, chroma: false, luma: false }, d);
  const m = mux(d.calls);
  assert.ok(m.includes('copy'));
  assert.equal(m[m.indexOf('-bsf:v') + 1], 'h264_metadata=sample_aspect_ratio=1/1:video_full_range_flag=0');
});

test('tags the colour range limited/tv on every harmonize encode', async () => {
  const { root, input } = await project();
  const d = fakes({ satSource: 8, satHarm: 4 }); // conform active -> re-encode mux + keepRaw
  await harmonizeVideo(root, { input, keepRaw: true, padMargin: 0.2 }, d);
  // Every libx264 encode (guidance, padded guidance, re-encode mux, raw mux) carries -color_range tv.
  const encodes = d.calls.ff.filter((a) => a.includes('libx264'));
  assert.ok(encodes.length >= 3, 'has libx264 encodes to check');
  for (const a of encodes) {
    assert.equal(a[a.indexOf('-color_range') + 1], 'tv', `encode tagged tv: ${a.join(' ')}`);
  }
});

test('the stream-copy mux path tags the range via the bitstream filter', async () => {
  const { root, input } = await project();
  const d = fakes(); // no conform -> copy branch (no -color_range flag, range lives in the bsf)
  await harmonizeVideo(root, { input, chroma: false, luma: false }, d);
  const m = mux(d.calls);
  assert.match(m[m.indexOf('-bsf:v') + 1], /video_full_range_flag=0/);
});
