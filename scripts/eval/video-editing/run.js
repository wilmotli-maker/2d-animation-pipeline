#!/usr/bin/env node
// Run pending tests from tests.json against a model adapter, then analyze each.
// SPENDS CREDITS — only run on explicit go-ahead. Skips tests whose output
// already exists (and any status:"done") unless --force.
//
//   node run.js --list                 # show what would run, spend nothing
//   node run.js --only art-hands-2x     # run one test
//   node run.js --category temporal     # run a whole category
//   node run.js                         # run every pending test
//   node run.js --force --only <id>     # re-run even if output exists
//   node run.js --model wan-vace-14b    # run the suite against Wan VACE instead of Aleph
//
// Adapters: aleph (aleph.js, prompt-only) and wan-vace (wan-vace.js, masked v2v).
// Effective model = --model override, else the test's `model`, else defaults.model.
// Each model's results file under its own <cat>/<id>/<model>/ subfolder, so Aleph
// and Wan runs of the same test sit side by side.
//
// Wan needs a MASK video. run.js builds one per test with make-mask.js from the
// test's `mask` spec (box/ellipse + feather) and, for temporal tests, its
// `window`. A test with no `mask` and no `window` gets a full-frame mask
// (whole-frame regen — fine for `global`, weak for `spatial`).

import { readFile, mkdir, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? true) : undefined;
}
const flags = {
  list: process.argv.includes('--list'),
  force: process.argv.includes('--force'),
  only: arg('only'),
  category: arg('category'),
  model: arg('model'),
};

const isAleph = (m) => m === 'aleph2' || m === 'aleph';
const isWan = (m) => m === 'wan-vace-14b' || m === 'wan-22-vace-fun-a14b';
const modelOf = (t) => (typeof flags.model === 'string' ? flags.model : (t.model || manifest.defaults.model));

function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(bin, args, { stdio: 'inherit', ...opts });
    c.on('error', (e) => resolve({ code: 127, error: e.message }));
    c.on('close', (code) => resolve({ code: code ?? 0 }));
  });
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

// Source fps, so Wan output is frame-aligned with the source (Wan defaults to
// 16fps otherwise, which breaks per-frame comparison of held regions).
function probeFps(file) {
  return new Promise((resolve) => {
    const c = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=avg_frame_rate', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', () => resolve(null));
    c.on('close', () => {
      const m = out.trim().match(/^(\d+)\/(\d+)$/);
      resolve(m && Number(m[2]) ? Math.round(Number(m[1]) / Number(m[2])) : null);
    });
  });
}

const manifest = JSON.parse(await readFile(path.join(here, 'tests.json'), 'utf8'));

let tests = manifest.tests;
if (flags.only) tests = tests.filter((t) => t.id === flags.only);
if (flags.category) tests = tests.filter((t) => t.category === flags.category);

// Prefer the local, self-contained copy of the input; fall back to the origin.
async function resolveSource(t) {
  const local = path.join(repoRoot, manifest.evalRoot, manifest.localSources, t.source);
  if (await exists(local)) return local;
  return path.join(manifest.sourceOrigin, t.source);
}

const plan = [];
for (const t of tests) {
  const outDir = path.join(repoRoot, manifest.evalRoot, t.category, t.id, modelOf(t));
  const outFile = path.join(outDir, 'output.mp4');
  // `status:"done"` marks the earlier Aleph runs; honor it only for Aleph.
  // For any other model, existence of that model's own output.mp4 is the signal.
  const doneForModel = t.status === 'done' && isAleph(modelOf(t));
  const already = doneForModel || await exists(outFile);
  if (already && !flags.force) continue;
  plan.push({ t, outDir, outFile, source: await resolveSource(t) });
}

if (!plan.length) {
  console.log('Nothing to run (all selected tests are done or already have output). Use --force to re-run.');
  process.exit(0);
}

console.log(`Will run ${plan.length} test(s):`);
for (const p of plan) console.log(`  ${p.t.id.padEnd(24)} ${p.t.source}`);
if (flags.list) { console.log('\n(--list: nothing submitted, no credits spent)'); process.exit(0); }

// Build a mask video for a Wan test from its spec; returns the mask path.
// Region from t.mask.box|ellipse (+feather); time-gate from t.window (temporal).
// No region and no window -> full-frame mask (whole-frame regen).
async function buildMask(t, outDir, source) {
  const maskPath = path.join(outDir, 'mask.mp4');
  const m = t.mask || {};
  const mkArgs = ['--src', source, '--out', maskPath];
  if (Array.isArray(m.box)) mkArgs.push('--box', m.box.join(','));
  else if (Array.isArray(m.ellipse)) mkArgs.push('--ellipse', m.ellipse.join(','));
  const feather = m.feather ?? (m.box || m.ellipse ? 8 : undefined);
  if (feather !== undefined) mkArgs.push('--feather', String(feather));
  const win = m.window || t.window; // [start, end] seconds
  if (Array.isArray(win) && win.length === 2) mkArgs.push('--window', win.join(','));
  const region = m.box ? 'box' : m.ellipse ? 'ellipse' : 'full-frame';
  console.log(`  mask: ${region}${win ? ` gated ${win[0]}-${win[1]}s` : ''}`);
  const res = await run('node', [path.join(here, 'make-mask.js'), ...mkArgs]);
  return res.code === 0 ? maskPath : null;
}

for (const { t, outDir, source } of plan) {
  const model = modelOf(t);
  await mkdir(outDir, { recursive: true });
  console.log(`\n=== ${t.id} (${model}) ===`);

  let submit;
  if (isAleph(model)) {
    submit = await run('node', [
      path.join(here, 'aleph.js'), 'submit',
      '--video', source, '--prompt', t.prompt,
      '--model', model, '--ratio', t.ratio || manifest.defaults.ratio,
      '--out', outDir,
    ]);
  } else if (isWan(model)) {
    const mask = await buildMask(t, outDir, source);
    if (!mask) { console.error(`[${t.id}] mask build failed; skipping.`); continue; }
    const fps = await probeFps(source);
    const wanArgs = [
      path.join(here, 'wan-vace.js'), 'submit',
      '--video', source, '--mask', mask, '--prompt', t.prompt,
      '--model', model, '--out', outDir,
    ];
    if (fps) wanArgs.push('--fps', String(fps));
    if (t.resolution) wanArgs.push('--resolution', String(t.resolution));
    submit = await run('node', wanArgs);
  } else {
    console.error(`\n[${t.id}] no adapter for model "${model}" — skipping.`);
    continue;
  }
  if (submit.code !== 0) { console.error(`[${t.id}] submit failed (exit ${submit.code}); continuing.`); continue; }

  const analyze = await run('node', [
    path.join(here, 'analyze.js'),
    '--src', source, '--out', path.join(outDir, 'output.mp4'), '--dir', outDir,
  ]);
  if (analyze.code !== 0) console.error(`[${t.id}] analyze failed (exit ${analyze.code}).`);
}
console.log('\nDone. Review compare.mp4 / diff-heatmap.mp4 / summary.json in each test dir.');
