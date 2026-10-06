#!/usr/bin/env node
// Scaffold the TWO-STAGE lip-sync variant (kf5 / middle). Stage 1 is the existing SILENT
// keyframe-edit generation (`<shot>__kf5__middle`, 5 refs incl. injected pose) — that already
// works. This script builds stage 2: a Seedance `video_edit` lip-sync pass over each silent
// output, driven by the shot's original speech.
//
// Why two stages: in one omni_reference pass, a speech-ref video + >1 image ref deterministically
// trips nsfw moderation (see keyframe-lipsync-nsfw-ceiling in memory). `video_edit` carries 0
// image refs and allows exactly ONE video reference, so we mux the silent visuals + the speech
// wav into a single combined clip and edit only the mouth.
//
//   node scaffold-lipsync-stage2.js [--shot <name>] [--force]
//
// Prereq: the silent kf5/middle outputs exist (run scaffold.js + the silent generate-batch).
// After it runs, generate with:
//   pipeline shot generate-batch --manifest <EVAL_ROOT>/manifest-lipsync-stage2.json --root <EVAL_ROOT>/scratch
// Then splice (keeps the original head/tail, splices the lip-synced middle):
//   node splice.js --lipsync2

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(C.REPO_ROOT, 'bin', 'pipeline.js');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : (process.argv[i + 1] ?? true); };
const FORCE = process.argv.includes('--force');
const ONLY = arg('shot');
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
const ff = (a) => run('ffmpeg', ['-v', 'error', '-y', ...a]);
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
async function dur(f) { return Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).trim()); }

async function main() {
  const manifest = [];
  const tests = [];
  const shots = C.SHOTS.filter((s) => !ONLY || s.shot === ONLY);

  for (const s of shots) {
    const silent = path.join(C.SCRATCH, 'shots', `${s.shot}__${VARIANT}__${POSITION}`, 'drafts', 'v001', 'output.mp4');
    if (!(await exists(silent))) { console.warn(`skip ${s.shot}: no silent stage-1 output at ${silent} (run the silent generate-batch first)`); continue; }

    // speech-ref: prefer the local copy stage-1 scaffold-lipsync made, else the source project
    let speech = path.join(C.EVAL_ROOT, s.shot, 'speech-ref.mp4');
    if (!(await exists(speech))) {
      const src = C.speechRefSource(s.shot);
      if (!(await exists(src))) { console.warn(`skip ${s.shot}: speech-ref missing (${src})`); continue; }
      await mkdir(path.join(C.EVAL_ROOT, s.shot), { recursive: true });
      await copyFile(src, speech);
    }
    const line = C.SPEECH_LINE[s.shot];
    if (!line) { console.warn(`skip ${s.shot}: no SPEECH_LINE`); continue; }

    const cdir = C.caseDir(C.EVAL_ROOT, s.shot, VARIANT, POSITION);
    await mkdir(cdir, { recursive: true });

    // mux the silent visuals + speech audio into ONE clip (audio padded to video length so the
    // mouth animates during speech then holds still). video_edit allows exactly one video ref.
    const combined = path.join(cdir, 'silent+speech.mp4');
    if (!(await exists(combined)) || FORCE) {
      await ff(['-i', silent, '-i', speech, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-af', 'apad', '-shortest', combined]);
    }
    const D = await dur(silent);

    const promptFile = path.join(cdir, 'prompt-lipsync-stage2.md');
    await writeFile(promptFile, C.buildLipsyncStage2Prompt({ line }) + '\n');

    const caseId = `${s.shot}__${VARIANT}__${POSITION}__lipsync2`;
    await run('node', [PIPELINE, 'shot', 'create', '--id', caseId, '--description', `keyframe-edit lipsync stage2 ${caseId}`, '--root', C.SCRATCH]).catch(() => {});
    if (!(await exists(path.join(C.SCRATCH, 'shots', caseId, 'drafts', 'v001')))) {
      await run('node', [PIPELINE, 'shot', 'draft', '--id', caseId, '--root', C.SCRATCH]);
    }

    manifest.push({
      id: caseId, version: 1, model: 'seedance_2_5', 'prompt-file': promptFile,
      videos: [combined], resolution: '480p', duration: Math.round(D), 'aspect-ratio': '3:4',
      'generate-audio': true, mode: 'video_edit', task: 'keyframe-edit-lipsync-stage2',
    });
    tests.push({
      id: caseId, shot: s.shot, char: s.char, variant: VARIANT, position: POSITION,
      seam: C.posSeam(POSITION), pose: s.edits[POSITION], line,
      source: `sources/${s.shot}.mp4`, stage1: `scratch/shots/${s.shot}__${VARIANT}__${POSITION}/drafts/v001/output.mp4`,
      combined: path.relative(C.EVAL_ROOT, combined), output: `scratch/shots/${caseId}/drafts/v001/output.mp4`,
    });
    console.log(`prepared ${caseId} (dur ${Math.round(D)}s, line "${line.slice(0, 40)}${line.length > 40 ? '…' : ''}")`);
  }

  await writeFile(path.join(C.EVAL_ROOT, 'manifest-lipsync-stage2.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(here, 'tests-lipsync-stage2.json'), JSON.stringify({ suite: 'keyframe-edit-lipsync-stage2', evalRoot: path.relative(C.REPO_ROOT, C.EVAL_ROOT), cases: tests }, null, 2) + '\n');
  const creds = manifest.reduce((a, m) => a + m.duration * 3, 0);
  console.log(`\nwrote ${manifest.length} stage-2 cases -> manifest-lipsync-stage2.json + tests-lipsync-stage2.json`);
  console.log(`estimated stage-2 cost: ${creds} credits (480p, 3 cr/s). Stage 1 (silent) was generated separately.`);
  console.log(`generate: node bin/pipeline.js shot generate-batch --manifest ${path.relative(C.REPO_ROOT, path.join(C.EVAL_ROOT, 'manifest-lipsync-stage2.json'))} --root ${path.relative(C.REPO_ROOT, C.SCRATCH)}`);
}
main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
