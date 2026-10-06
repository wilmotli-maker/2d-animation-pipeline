#!/usr/bin/env node
// Build the transition review page. Each row (a pair) contains, as versions:
//   v001 source shot1 · v002 source shot2 · then per variation: raw transition + spliced edit.
// All videos, so the pipeline review tool handles it directly. No credits.
//   node review-build.js
import { spawn } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as C from './config.mjs';

const PIPELINE = path.join(C.REPO_ROOT, 'bin', 'pipeline.js');
const REVIEW = path.join(C.EVAL_ROOT, 'review');
const SLUG = 'transitions';
function run(bin, args) { return new Promise((res, rej) => { const c = spawn(bin, args, { stdio: 'inherit' }); c.on('close', (x) => (x === 0 ? res() : rej(new Error(`${bin} ${x}`)))); }); }

const rawT = (id) => path.join(C.SCRATCH, 'shots', id, 'drafts', 'v001', 'output.mp4');
let made = 0, pairs = 0;
for (const [a, b] of C.PAIRS) {
  const id = C.pairId(a, b);
  const dir = C.caseDir(a, b);
  const layers = [
    ['source-shot1', path.join(C.EVAL_ROOT, 'sources', `${a}.mp4`)],
    ['source-shot2', path.join(C.EVAL_ROOT, 'sources', `${b}.mp4`)],
  ];
  for (let v = 1; v <= C.VARIATIONS; v++) {
    layers.push([`v${v}-raw`, rawT(`${id}__v${v}`)]);
    layers.push([`v${v}-edit`, path.join(dir, `${id}__v${v}-edit.mp4`)]);
  }
  // only build the row if at least one edit exists
  if (!layers.slice(2).some(([, f]) => existsSync(f))) continue;
  pairs++;
  let vi = 0; const labels = [];
  for (const [label, f] of layers) {
    if (!existsSync(f)) continue;
    vi++;
    const vd = path.join(REVIEW, 'shots', id, 'drafts', `v${String(vi).padStart(3, '0')}`);
    mkdirSync(vd, { recursive: true }); copyFileSync(f, path.join(vd, 'output.mp4')); made++;
    labels.push(`v${String(vi).padStart(3, '0')}=${label}`);
  }
  writeFileSync(path.join(REVIEW, 'shots', id, 'shot.yaml'),
    `shotId: ${id}\ndescription: "${a} → ${b}. ${labels.join(' · ')}"\nduration: 12\nelements: []\n`);
}
console.log(`review project: ${made} clips across ${pairs} pairs`);
await run('node', [PIPELINE, 'review', 'shots', '--slug', SLUG, '--root', REVIEW,
  '--title', 'Shot-to-shot transitions — source1 · source2 · (raw · edit) x6', '--update']);
console.log(`page -> ${path.join(REVIEW, 'web', SLUG, 'index.html')}`);
