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
//
// Currently the only adapter is aleph (aleph.js). Model comes from the test's
// `model` or defaults.model; a non-aleph model errors until an adapter is added.

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
};

function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(bin, args, { stdio: 'inherit', ...opts });
    c.on('error', (e) => resolve({ code: 127, error: e.message }));
    c.on('close', (code) => resolve({ code: code ?? 0 }));
  });
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

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
  const outDir = path.join(repoRoot, manifest.evalRoot, t.category, t.id, t.model || manifest.defaults.model);
  const outFile = path.join(outDir, 'output.mp4');
  const already = t.status === 'done' || await exists(outFile);
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

for (const { t, outDir, source } of plan) {
  const model = t.model || manifest.defaults.model;
  if (model !== 'aleph2' && model !== 'aleph') {
    console.error(`\n[${t.id}] no adapter for model "${model}" — skipping.`);
    continue;
  }
  await mkdir(outDir, { recursive: true });

  console.log(`\n=== ${t.id} (${model}) ===`);
  const submit = await run('node', [
    path.join(here, 'aleph.js'), 'submit',
    '--video', source, '--prompt', t.prompt,
    '--model', model, '--ratio', t.ratio || manifest.defaults.ratio,
    '--out', outDir,
  ]);
  if (submit.code !== 0) { console.error(`[${t.id}] submit failed (exit ${submit.code}); continuing.`); continue; }

  const analyze = await run('node', [
    path.join(here, 'analyze.js'),
    '--src', source, '--out', path.join(outDir, 'output.mp4'), '--dir', outDir,
  ]);
  if (analyze.code !== 0) console.error(`[${t.id}] analyze failed (exit ${analyze.code}).`);
}
console.log('\nDone. Review compare.mp4 / diff-heatmap.mp4 / summary.json in each test dir.');
