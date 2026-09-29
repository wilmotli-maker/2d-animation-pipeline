#!/usr/bin/env node
// Scaffold the transition eval: extract each pair's A (shot1 last frame) and B (shot2 first
// frame), build the [A,A,B,B] keyframe set, emit prompts, create scratch shots, write manifest.
// Spends NO credits.  Run:  node scaffold.js
// Then:  pipeline shot generate-batch --manifest <EVAL_ROOT>/manifest.json --root <EVAL_ROOT>/scratch

import { spawn } from 'node:child_process';
import { mkdir, writeFile, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './config.mjs';
import { recolorBg, cornerRGB } from './bg-recolor.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(C.REPO_ROOT, 'bin', 'pipeline.js');
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
function run(bin, args) {
  return new Promise((res, rej) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`${bin} ${args.slice(0, 3).join(' ')} exit ${code}\n${(err || out).slice(-400)}`))));
  });
}
const ff = (a) => run('ffmpeg', ['-v', 'error', '-y', ...a]);

await mkdir(C.EVAL_ROOT, { recursive: true });
await mkdir(C.SCRATCH, { recursive: true });
await mkdir(path.join(C.EVAL_ROOT, 'sources'), { recursive: true });

const manifest = [];
const tests = [];
// extract A/B endpoint frames once per pair
for (const [a, b] of C.PAIRS) {
  const dir = C.caseDir(a, b);
  await mkdir(dir, { recursive: true });
  const srcA = path.join(C.CANDIDATES, `${a}.mp4`), srcB = path.join(C.CANDIDATES, `${b}.mp4`);
  for (const [s, f] of [[a, srcA], [b, srcB]]) {
    const local = path.join(C.EVAL_ROOT, 'sources', `${s}.mp4`);
    if (!(await exists(local))) await copyFile(f, local);
  }
  const A = path.join(dir, 'A-endShot1.png'), B = path.join(dir, 'B-startShot2.png');
  const Araw = path.join(dir, 'A-endShot1-orig.png');
  await ff(['-sseof', '-0.1', '-i', srcA, '-frames:v', '1', Araw]);
  await ff(['-i', srcB, '-frames:v', '1', B]);
  // match A's background to B's grey (background only; character untouched)
  const aBg = await cornerRGB(Araw), bBg = await cornerRGB(B);
  await recolorBg(Araw, A, aBg, bBg);
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ a, b, aBg, bBg }, null, 2) + '\n');
  const images = [A, A, B, B];
  const prompt = C.buildPrompt(C.charOf(a));
  const promptFile = path.join(dir, 'prompt.md');
  await writeFile(promptFile, prompt + '\n');
  for (let v = 1; v <= C.VARIATIONS; v++) {
    const id = `${C.pairId(a, b)}__v${v}`;
    await run('node', [PIPELINE, 'shot', 'create', '--id', id, '--description', `transition ${id}`, '--root', C.SCRATCH]).catch(() => {});
    if (!(await exists(path.join(C.SCRATCH, 'shots', id, 'drafts', 'v001')))) await run('node', [PIPELINE, 'shot', 'draft', '--id', id, '--root', C.SCRATCH]);
    manifest.push({
      id, version: 1, model: 'seedance_2_5', 'prompt-file': promptFile, images,
      resolution: '480p', duration: 4, 'aspect-ratio': '3:4', 'generate-audio': false, mode: 'omni_reference',
      task: 'transition-eval',
    });
    tests.push({ id, a, b, variation: v, char: C.charOf(a), output: `scratch/shots/${id}/drafts/v001/output.mp4` });
  }
  console.log(`prepared ${a} -> ${b}`);
}
await writeFile(path.join(C.EVAL_ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(here, 'tests.json'), JSON.stringify({ suite: 'transition-eval', cases: tests }, null, 2) + '\n');
console.log(`\nwrote ${manifest.length} cases -> manifest.json`);
