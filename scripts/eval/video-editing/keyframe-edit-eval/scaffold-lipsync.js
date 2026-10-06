#!/usr/bin/env node
// Scaffold the LIP-SYNC variant of the keyframe-edit eval — the "hybrid splice with lip
// sync" experiment. For each of the 8 shots, reuse the already-prepared kf5 / middle case
// (its 5 keyframe image refs, with the injected pose at the centre) and additionally attach
// the ORIGINAL speech-ref.mp4 used to generate the source clip, with generate-audio on, so
// the raw (pre-splice) Seedance output carries the source lip sync in ADDITION to the edited
// key pose. Splice semantics are unchanged (middle → keep original head + tail).
//
// Scope: kf5 / middle only, all 8 shots ⇒ 8 generations. Spends NO credits.
//
//   node scaffold-lipsync.js [--force]
//
// Prereq: scaffold.js has already run (produces manifest.json + the kf5/middle refs).
// After it runs, generate with:
//   pipeline shot generate-batch --manifest <EVAL_ROOT>/manifest-lipsync.json --root <EVAL_ROOT>/scratch

import { spawn } from 'node:child_process';
import { mkdir, writeFile, copyFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(C.REPO_ROOT, 'bin', 'pipeline.js');
const FORCE = process.argv.includes('--force');
const VARIANT = 'kf5';
const POSITION = 'middle';

function run(bin, args) {
  return new Promise((res, rej) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    c.on('error', rej);
    c.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`${bin} ${args.slice(0, 3).join(' ')} exit ${code}\n${(err || out).slice(-500)}`))));
  });
}
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

async function main() {
  const mainManifestPath = path.join(C.EVAL_ROOT, 'manifest.json');
  if (!(await exists(mainManifestPath))) {
    console.error(`missing ${mainManifestPath} — run scaffold.js first (it preps the kf5/middle refs this variant reuses).`);
    process.exit(1);
  }
  const mainManifest = JSON.parse(await readFile(mainManifestPath, 'utf8'));
  const byId = new Map(mainManifest.map((m) => [m.id, m]));

  const manifest = [];
  const tests = [];

  for (const s of C.SHOTS) {
    const baseId = `${s.shot}__${VARIANT}__${POSITION}`;
    const base = byId.get(baseId);
    if (!base) { console.warn(`skip ${s.shot}: no ${baseId} in manifest.json`); continue; }

    // duration matches the source clip (as the base case computed it)
    const duration = base.duration;

    // copy the original speech-ref video into the eval dir so the case is self-contained
    const srcSpeech = C.speechRefSource(s.shot);
    if (!(await exists(srcSpeech))) { console.warn(`skip ${s.shot}: speech-ref missing at ${srcSpeech}`); continue; }
    const localSpeech = path.join(C.EVAL_ROOT, s.shot, 'speech-ref.mp4');
    if (!(await exists(localSpeech)) || FORCE) await copyFile(srcSpeech, localSpeech);

    // lip-sync prompt (reuses the kf5/middle keyframe timing + injected pose)
    const spec = C.keyframeSpec(VARIANT, POSITION);
    const line = C.SPEECH_LINE[s.shot];
    if (!line) { console.warn(`skip ${s.shot}: no SPEECH_LINE`); continue; }
    const prompt = C.buildLipsyncPrompt({ char: s.char, times: spec.times, index: spec.editIndex, pose: s.edits[POSITION], line });
    const cdir = C.caseDir(C.EVAL_ROOT, s.shot, VARIANT, POSITION);
    const promptFile = path.join(cdir, 'prompt-lipsync.md');
    await writeFile(promptFile, prompt + '\n');

    const caseId = `${baseId}__lipsync`;
    await run('node', [PIPELINE, 'shot', 'create', '--id', caseId, '--description', `keyframe-edit lipsync ${caseId}`, '--root', C.SCRATCH]).catch(() => {});
    if (!(await exists(path.join(C.SCRATCH, 'shots', caseId, 'drafts', 'v001')))) {
      await run('node', [PIPELINE, 'shot', 'draft', '--id', caseId, '--root', C.SCRATCH]);
    }

    manifest.push({
      id: caseId, version: 1, model: 'seedance_2_5', 'prompt-file': promptFile,
      images: base.images,           // same 5 keyframes (pose injected at centre)
      videos: [localSpeech],         // original speech-ref → lip sync
      resolution: base.resolution, duration, 'aspect-ratio': base['aspect-ratio'],
      'generate-audio': true,        // required for the speech-ref video to drive audio/lips
      mode: 'omni_reference', task: 'keyframe-edit-lipsync',
    });
    tests.push({
      id: caseId, shot: s.shot, char: s.char, variant: VARIANT, position: POSITION,
      index: spec.editIndex, times: spec.times, seam: C.posSeam(POSITION), pose: s.edits[POSITION],
      line, source: `sources/${s.shot}.mp4`, speechRef: `${s.shot}/speech-ref.mp4`,
      output: `scratch/shots/${caseId}/drafts/v001/output.mp4`,
    });
    console.log(`prepared ${caseId} (dur ${duration}s, line "${line.slice(0, 40)}${line.length > 40 ? '…' : ''}")`);
  }

  await writeFile(path.join(C.EVAL_ROOT, 'manifest-lipsync.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(here, 'tests-lipsync.json'), JSON.stringify({ suite: 'keyframe-edit-lipsync', evalRoot: path.relative(C.REPO_ROOT, C.EVAL_ROOT), cases: tests }, null, 2) + '\n');

  const creds = manifest.reduce((a, m) => a + m.duration * 3, 0); // 480p ≈ 3 cr/s
  console.log(`\nwrote ${manifest.length} lip-sync cases -> manifest-lipsync.json + tests-lipsync.json`);
  console.log(`estimated cost: ${creds} credits (480p, 3 cr/s; audio + video ref do not add cost)`);
  console.log(`generate: node bin/pipeline.js shot generate-batch --manifest ${path.relative(C.REPO_ROOT, path.join(C.EVAL_ROOT, 'manifest-lipsync.json'))} --root ${path.relative(C.REPO_ROOT, C.SCRATCH)}`);
}
main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
