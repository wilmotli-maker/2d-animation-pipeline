#!/usr/bin/env node
// LARGE EXPERIMENT: two-stage previz→restyle harmonization across a sample of the
// transition-pairs, testing how many appearance-reference frames the restyle needs.
//
// For each sampled *-aligned.mp4 clip:
//   stage 1  source -> neutral greybox previz (Seedance video_edit, PREVIS_PROMPT)
//   stage 2  previz -> restyled, in THREE variants that differ only by how many
//            source frames are handed in as the appearance reference:
//              v1  first frame only                        (t≈0)
//              v2  first frame + a pre-transition frame     (t≈0, 1.5s)
//              v3  first + pre-transition + end frame       (t≈0, 1.5s, end)
//
// 15 clips × (1 previz + 3 styled) = 60 Seedance generations (~15 cr each ≈ 900 cr).
// Sampled 5/5/5 across all three characters (ai / art / monster), spread over pairs.
//
// Everything is RESUMABLE: a stage whose output already exists is skipped, so the
// run can be stopped and restarted, and you can inspect early clips before the rest
// finish. Dry run by default; --go spends credits.
//
//   node experiment.js list                 # planned clips + est. credits
//   node experiment.js run [--go] [--only <clipId>] [--limit N]
//   node experiment.js report               # contact sheet per clip + index
//
// Work dir: evaluation/video-editing-eval/harmonize-experiment/ (gitignored).

import { readFile, writeFile, mkdir, copyFile, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREVIS_PROMPT, STYLE_PROMPT } from './prompts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const pairsRoot = path.join(repoRoot, 'evaluation', 'video-editing-eval', 'transition-pairs');
const expRoot = path.join(repoRoot, 'evaluation', 'video-editing-eval', 'harmonize-experiment');
const pipeline = path.join(repoRoot, 'bin', 'pipeline.js');

const SEEDANCE = { model: 'seedance_2_5', mode: 'video_edit', resolution: '480p', aspect: '3:4', duration: 4 };
const CREDITS_PER_GEN = 15; // observed ballpark for 480p 4s

// Sample: 5 ai pairs, 5 art pairs, 4 monster pairs (+1 monster variant) = 15 clips,
// one take per pair (v1) except the extra monster take, spreading coverage over the
// distinct A->B pairings rather than near-duplicate versions of one pair.
const SAMPLE = [
  ['ai-1-v003__to__ai-13-v003', 'v1'],
  ['ai-12-v006__to__ai-4-v006', 'v1'],
  ['ai-13-v003__to__ai-5-v005', 'v1'],
  ['ai-2-v003__to__ai-8-v006', 'v1'],
  ['ai-6-v002__to__ai-9-v002', 'v1'],
  ['art-10-v002__to__art-9-v003', 'v1'],
  ['art-11-v002__to__art-5-v003', 'v1'],
  ['art-12-v002__to__art-4-v002', 'v1'],
  ['art-3-v002__to__art-7-v002', 'v1'],
  ['art-4-v002__to__art-12-v002', 'v1'],
  ['monster-1-v006__to__monster-4-v002', 'v1'],
  ['monster-2-v006__to__monster-3-v001', 'v1'],
  ['monster-3-v001__to__monster-2-v006', 'v1'],
  ['monster-4-v002__to__monster-1-v006', 'v1'],
  ['monster-1-v006__to__monster-4-v002', 'v2'],
];

const CLIPS = SAMPLE.map(([pair, ver]) => ({
  id: `${pair}__${ver}`,
  src: path.join(pairsRoot, pair, `${pair}__${ver}-aligned.mp4`),
}));

// Restyle variants: which extracted source frames feed the appearance reference.
const VARIANTS = [
  { tag: 'v1', frames: ['f0'] },
  { tag: 'v2', frames: ['f0', 'fmid'] },
  { tag: 'v3', frames: ['f0', 'fmid', 'fend'] },
];

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? true); };
const has = (n) => argv.includes(`--${n}`);
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

function exec(bin, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    if (capture) { c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d)); }
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} ${args.slice(0, 3).join(' ')}… exit ${code}\n${out.slice(-1200)}`))));
  });
}
const ff = (args, o) => exec('ffmpeg', ['-v', 'error', '-y', ...args], o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeDuration(file) {
  const o = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { capture: true });
  return Number(o.trim());
}
async function probeDims(file) {
  const o = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height', '-of', 'csv=p=0', file], { capture: true });
  const [w, h] = o.trim().split(',').map(Number);
  return { w, h };
}

// One Seedance video_edit generation under `work/shots/<shotId>`, with a couple of
// retries for the transient Higgsfield HTTP 520 upload errors. Returns output path.
async function seedanceGen({ work, shotId, video, images, prompt, label }) {
  const s = SEEDANCE;
  const base = ['--root', work];
  const out = path.join(work, 'shots', shotId, 'drafts', 'v001', 'output.mp4');
  const genArgs = [
    pipeline, 'shot', 'generate', '--id', shotId, '--version', '1',
    '--model', s.model, '--mode', s.mode,
    '--resolution', s.resolution, '--aspect-ratio', s.aspect, '--duration', String(s.duration),
    '--generate-audio', 'false', '--video', video,
    ...images.flatMap((im) => ['--image', im]),
    '--prompt', prompt, ...base,
  ];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await rm(path.join(work, 'shots', shotId), { recursive: true, force: true });
    await exec('node', [pipeline, 'shot', 'create', '--id', shotId, ...base]);
    await exec('node', [pipeline, 'shot', 'draft', '--id', shotId, ...base]);
    try {
      console.log(`    ${label} (attempt ${attempt})…`);
      await exec('node', genArgs);
      if (await exists(out)) return out;
      throw new Error('no output produced');
    } catch (e) {
      const msg = String(e.message || e);
      const transient = /520|upload|timed out|ECONN|HTTP 5/.test(msg);
      if (attempt < 3 && transient) { console.log(`    transient failure, retrying: ${msg.split('\n')[0]}`); await sleep(4000); continue; }
      throw e;
    }
  }
  throw new Error('unreachable');
}

async function prepClip(clip) {
  const work = path.join(expRoot, clip.id);
  await mkdir(work, { recursive: true });
  const source = path.join(work, 'source.mp4');
  if (!(await exists(source))) await copyFile(clip.src, source);
  const dur = await probeDuration(source);
  const frames = {
    f0: path.join(work, 'f0.png'),
    fmid: path.join(work, 'fmid.png'),
    fend: path.join(work, 'fend.png'),
  };
  const times = { f0: 0.05, fmid: Math.min(1.5, dur - 0.2), fend: Math.max(0, dur - 0.1) };
  for (const [k, p] of Object.entries(frames)) {
    if (!(await exists(p))) await ff(['-ss', String(times[k]), '-i', source, '-vframes', '1', p]);
  }
  return { work, source, frames, dur };
}

async function runClip(clip, go) {
  console.log(`\n=== ${clip.id} ===`);
  if (!(await exists(clip.src))) { console.error(`  missing source: ${clip.src}`); return; }
  const { work, source, frames } = await prepClip(clip);
  const previz = path.join(work, 'previz.mp4');

  // Stage 1: previz (once per clip).
  if (await exists(previz)) console.log('  previz: exists, skip');
  else if (!go) console.log('  previz: [dry-run] would generate');
  else {
    const out = await seedanceGen({ work, shotId: 'previz', video: source, images: [], prompt: PREVIS_PROMPT, label: 'previz' });
    await copyFile(out, previz);
    console.log('  previz -> previz.mp4');
  }

  // Stage 2: the three reference-count variants.
  for (const v of VARIANTS) {
    const styled = path.join(work, `styled-${v.tag}.mp4`);
    if (await exists(styled)) { console.log(`  styled-${v.tag}: exists, skip`); continue; }
    if (!go) { console.log(`  styled-${v.tag}: [dry-run] refs=${v.frames.join('+')}`); continue; }
    if (!(await exists(previz))) { console.error(`  styled-${v.tag}: no previz, skip`); continue; }
    const images = v.frames.map((f) => frames[f]);
    const out = await seedanceGen({ work, shotId: `styled-${v.tag}`, video: previz, images, prompt: STYLE_PROMPT, label: `styled-${v.tag} (refs=${v.frames.join('+')})` });
    await copyFile(out, styled);
    console.log(`  styled-${v.tag} -> styled-${v.tag}.mp4`);
  }
}

// Prompt-iteration harness: regenerate ONLY the previz for the three known failure
// cases with the current PREVIS_PROMPT, into <clip>/previz-test.mp4 (the original
// previz.mp4 is left untouched for comparison). --go spends credits (~15 cr each).
const PREVIZ_TEST_CLIPS = [
  'ai-6-v002__to__ai-9-v002__v1',        // was: humanised head, wrong proportions
  'art-10-v002__to__art-9-v003__v1',     // was: kept source colours/costume (+ hair-colour leak)
  'monster-4-v002__to__monster-1-v006__v1', // was: generic wooden human mannequin
  'ai-2-v003__to__ai-8-v006__v1',        // was: missing mouth / facial features
  'art-3-v002__to__art-7-v002__v1',      // was: missing mouth / facial features
];
async function previztest() {
  const go = has('go');
  const only = arg('only');
  let ids = PREVIZ_TEST_CLIPS;
  if (only && only !== true) ids = ids.filter((id) => id === String(only));
  if (!go) { console.log(`DRY RUN — ${ids.length} previz regenerations ≈ ${ids.length * CREDITS_PER_GEN} cr. Add --go.`); return; }
  for (const id of ids) {
    const work = path.join(expRoot, id);
    const source = path.join(work, 'source.mp4');
    if (!(await exists(source))) { console.error(`  missing source: ${id}`); continue; }
    console.log(`\n=== ${id} ===`);
    const out = await seedanceGen({ work, shotId: 'previz-test', video: source, images: [], prompt: PREVIS_PROMPT, label: 'previz-test' });
    await copyFile(out, path.join(work, 'previz-test.mp4'));
    console.log(`  -> ${id}/previz-test.mp4`);
  }
  console.log('\nprevz-test complete. Compare previz.mp4 (old) vs previz-test.mp4 (new).');
}

// Restyle the IMPROVED previz (previz-test.mp4) for the three refined test clips,
// producing two finals each: 2-ref (first + pre-transition) and 3-ref (+ end), the
// higher-adherence configs. Outputs: styled-new-2ref.mp4 / styled-new-3ref.mp4.
const FINAL_TEST_CLIPS = [
  'monster-4-v002__to__monster-1-v006__v1',
  'ai-2-v003__to__ai-8-v006__v1',
  'art-3-v002__to__art-7-v002__v1',
];
const FINAL_VARIANTS = [
  { tag: '2ref', frames: ['f0', 'fmid'] },
  { tag: '3ref', frames: ['f0', 'fmid', 'fend'] },
];
async function finaltest() {
  const go = has('go');
  const only = arg('only');
  let ids = FINAL_TEST_CLIPS;
  if (only && only !== true) ids = ids.filter((id) => id === String(only));
  const total = ids.length * FINAL_VARIANTS.length;
  if (!go) { console.log(`DRY RUN — ${total} restyles ≈ ${total * CREDITS_PER_GEN} cr. Add --go.`); return; }
  for (const id of ids) {
    const work = path.join(expRoot, id);
    const previz = path.join(work, 'previz-test.mp4');
    if (!(await exists(previz))) { console.error(`  missing previz-test: ${id}`); continue; }
    console.log(`\n=== ${id} ===`);
    for (const v of FINAL_VARIANTS) {
      const dest = path.join(work, `styled-new-${v.tag}.mp4`);
      if (await exists(dest)) { console.log(`  styled-new-${v.tag}: exists, skip`); continue; }
      const images = v.frames.map((f) => path.join(work, `${f}.png`));
      const out = await seedanceGen({ work, shotId: `styled-new-${v.tag}`, video: previz, images, prompt: STYLE_PROMPT, label: `styled-new-${v.tag} (refs=${v.frames.join('+')})` });
      await copyFile(out, dest);
      console.log(`  -> ${id}/styled-new-${v.tag}.mp4`);
    }
  }
  console.log('\nfinaltest complete.');
}

async function run() {
  const go = has('go');
  const only = arg('only');
  const limit = arg('limit') ? Number(arg('limit')) : Infinity;
  let clips = CLIPS;
  if (only && only !== true) clips = clips.filter((c) => c.id === String(only));
  clips = clips.slice(0, limit);
  if (!go) console.log(`DRY RUN — no credits spent. ${clips.length} clips × 4 gens ≈ ${clips.length * 4 * CREDITS_PER_GEN} cr. Add --go to execute.`);
  for (const clip of clips) await runClip(clip, go);
  console.log(go ? '\nexperiment run complete.' : '\nDry run complete. Re-run with --go to execute.');
}

// Per-clip contact sheet: rows source / previz / styled-v1 / styled-v2 / styled-v3,
// columns first/mid/last, all normalized to source dims. Writes <clip>/sheet.png.
async function grabRow(file, tag, dims, dir) {
  const dur = await probeDuration(file);
  const times = [0.05, dur / 2, Math.max(0, dur - 0.1)];
  const fr = [];
  for (let i = 0; i < 3; i++) {
    const o = path.join(dir, `${tag}-${i}.png`);
    await ff(['-ss', String(times[i]), '-i', file, '-vframes', '1', '-vf', `scale=${dims.w}:${dims.h}`, o]);
    fr.push(o);
  }
  const row = path.join(dir, `row-${tag}.png`);
  await ff(['-i', fr[0], '-i', fr[1], '-i', fr[2], '-filter_complex', '[0][1][2]hstack=inputs=3', row]);
  return row;
}

async function report() {
  const made = [];
  for (const clip of CLIPS) {
    const work = path.join(expRoot, clip.id);
    const source = path.join(work, 'source.mp4');
    if (!(await exists(source))) continue;
    const layers = [['source', source]];
    for (const name of ['previz', 'styled-v1', 'styled-v2', 'styled-v3']) {
      const f = path.join(work, name.startsWith('styled') ? `${name}.mp4` : `${name}.mp4`);
      if (await exists(f)) layers.push([name, f]);
    }
    if (layers.length === 1) continue;
    const dims = await probeDims(source);
    const framesDir = path.join(work, 'sheet-frames');
    await mkdir(framesDir, { recursive: true });
    const rows = [];
    for (const [tag, file] of layers) rows.push(await grabRow(file, tag, dims, framesDir));
    const inputs = rows.flatMap((r) => ['-i', r]);
    await ff([...inputs, '-filter_complex', `${rows.map((_, i) => `[${i}]`).join('')}vstack=inputs=${rows.length}`, path.join(work, 'sheet.png')]);
    made.push({ id: clip.id, rows: layers.map((l) => l[0]) });
    console.log(`  ${clip.id}: sheet.png (${layers.map((l) => l[0]).join(' / ')})`);
  }
  await writeFile(path.join(expRoot, 'index.json'), JSON.stringify(made, null, 2) + '\n');
  console.log(`\n${made.length} sheets. index -> ${path.relative(repoRoot, path.join(expRoot, 'index.json'))}`);
}

// Stage a flat folder the pipeline's `review shots --folder` understands (files
// named "<shotId>-vNNN.ext") and build the review page. Each experiment clip is one
// "shot"; its stages become versions. v006 (improved-prompt previz) only exists for
// the clips re-run via `previztest`, so it simply appears where available.
//   v001 source · v002 previz · v003/4/5 styled (1/2/3 ref) · v006 previz (new prompt)
const STAGES = [
  ['source.mp4', 'v001'], ['previz.mp4', 'v002'],
  ['styled-v1.mp4', 'v003'], ['styled-v2.mp4', 'v004'], ['styled-v3.mp4', 'v005'],
  ['previz-test.mp4', 'v006'],
  ['styled-new-2ref.mp4', 'v007'], ['styled-new-3ref.mp4', 'v008'],
];
async function review() {
  const srcDir = path.join(expRoot, 'review-src');
  await rm(srcDir, { recursive: true, force: true });
  await mkdir(srcDir, { recursive: true });
  let staged = 0;
  for (const clip of CLIPS) {
    for (const [file, ver] of STAGES) {
      const from = path.join(expRoot, clip.id, file);
      if (await exists(from)) { await copyFile(from, path.join(srcDir, `${clip.id}-${ver}.mp4`)); staged++; }
    }
  }
  console.log(`staged ${staged} clips into ${path.relative(repoRoot, srcDir)}`);
  const legend = 'Versions:  v001 source  ·  v002 previz (old prompt)  ·  v003 styled (1 ref)  ·  v004 styled (2 refs)  ·  v005 styled (3 refs)  ·  v006 previz (new prompt)  ·  v007 final from new previz (2 refs)  ·  v008 final from new previz (3 refs)';
  console.log(legend + '\n');
  const out = await exec('node', [pipeline, 'review', 'shots', '--folder', srcDir,
    '--slug', 'harmonize-experiment', '--layout', 'side-by-side', '--update'], { capture: true });
  process.stdout.write(out);

  // The pipeline page has no legend field, so inject one under the subtitle. Path
  // comes from the "review page: <dir>" line it printed.
  const m = /review page:\s*(\S+)/.exec(out);
  const indexPath = m ? path.join(m[1], 'index.html') : null;
  if (indexPath && (await exists(indexPath))) {
    let html = await readFile(indexPath, 'utf8');
    if (!html.includes('class="legend"')) {
      html = html.replace(/(<p class="sub">[\s\S]*?<\/p>)/,
        `$1\n        <p class="legend" style="margin:.25rem 0 0;font-size:.85rem;opacity:.8">${legend}</p>`);
      await writeFile(indexPath, html);
      console.log('injected version legend into the review page');
    }
  } else {
    console.warn('could not locate index.html to inject the legend');
  }
}

function list() {
  const byChar = {};
  for (const c of CLIPS) { const ch = c.id.split('-')[0]; (byChar[ch] ||= []).push(c.id); }
  for (const [ch, ids] of Object.entries(byChar)) { console.log(`${ch} (${ids.length}):`); for (const id of ids) console.log(`  ${id}`); }
  console.log(`\ntotal ${CLIPS.length} clips × (1 previz + ${VARIANTS.length} styled) = ${CLIPS.length * (1 + VARIANTS.length)} generations ≈ ${CLIPS.length * (1 + VARIANTS.length) * CREDITS_PER_GEN} credits`);
}

const main = { list, run, report, review, previztest, finaltest }[cmd];
if (typeof main === 'function') Promise.resolve(main()).catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
else { console.log('usage: node experiment.js <list|run|report|review> [--go] [--only <clipId>] [--limit N]'); process.exit(cmd ? 2 : 0); }
