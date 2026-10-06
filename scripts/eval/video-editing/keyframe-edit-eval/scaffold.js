#!/usr/bin/env node
// Scaffold the keyframe-edit eval: extract source keyframes, matte + register each injected
// pose onto the shot's gray, assemble the swapped reference sets, emit prompts, create the
// scratch pipeline project, and write tests.json + manifest.json. Spends NO credits.
//
//   node scaffold.js [--shot <name>] [--force]
//
// After it runs, generate with:
//   pipeline shot generate-batch --manifest <EVAL_ROOT>/manifest.json --root <EVAL_ROOT>/scratch

import { spawn } from 'node:child_process';
import { mkdir, writeFile, copyFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(C.REPO_ROOT, 'bin', 'pipeline.js');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : (process.argv[i + 1] ?? true); };
const FORCE = process.argv.includes('--force');
const ONLY = arg('shot');

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
async function probe(f, entries) { return (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'csv=p=0', f])).trim(); }
// binary-safe raw RGBA read
function rawBin(png) {
  return new Promise((res, rej) => {
    const c = spawn('ffmpeg', ['-v', 'error', '-i', png, '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ch = []; let err = '';
    c.stdout.on('data', (d) => ch.push(d)); c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => (code === 0 ? res(Buffer.concat(ch)) : rej(new Error(err.slice(-300)))));
  });
}

// measure character extent. isAlpha: use alpha>128; else diff from bg>thresh.
function measure(buf, w, h, { isAlpha, bg }) {
  let minX = w, maxX = -1, minY = h, maxY = -1, sx = 0, n = 0;
  const colTop = new Int32Array(w).fill(-1), colBot = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let on;
    if (isAlpha) on = buf[i + 3] > 128;
    else on = Math.abs(buf[i] - bg[0]) + Math.abs(buf[i + 1] - bg[1]) + Math.abs(buf[i + 2] - bg[2]) > 60;
    if (!on) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    sx += x; n++;
    if (colTop[x] === -1) colTop[x] = y; colBot[x] = y;
  }
  if (n === 0) return null;
  const centroidX = Math.round(sx / n);
  const band = Math.round(0.08 * w);
  let bandTop = h, bandBot = -1;
  for (let x = centroidX - band; x <= centroidX + band; x++) {
    if (x < 0 || x >= w || colTop[x] === -1) continue;
    if (colTop[x] < bandTop) bandTop = colTop[x];
    if (colBot[x] > bandBot) bandBot = colBot[x];
  }
  return { centroidX, bandTop, bandBottom: bandBot, minX, maxX, minY, maxY };
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function main() {
  await mkdir(C.EVAL_ROOT, { recursive: true });
  await mkdir(path.join(C.EVAL_ROOT, 'sources'), { recursive: true });
  await mkdir(C.SCRATCH, { recursive: true });
  const shots = C.SHOTS.filter((s) => !ONLY || s.shot === ONLY);
  const manifest = [];
  const tests = [];

  for (const s of shots) {
    const src = path.join(C.CANDIDATES, `${s.shot}.mp4`);
    const localSrc = path.join(C.EVAL_ROOT, 'sources', `${s.shot}.mp4`);
    if (!(await exists(localSrc)) || FORCE) await copyFile(src, localSrc);
    const D = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', localSrc])).trim());
    const shotDir = path.join(C.EVAL_ROOT, s.shot);
    await mkdir(path.join(shotDir, 'poses'), { recursive: true });
    // helper: extract a source frame at a fraction of the clip
    const grab = async (frac, out) => {
      const seek = frac >= 0.999 ? ['-sseof', '-0.1'] : ['-ss', (frac * D).toFixed(3)];
      if (!(await exists(out)) || FORCE) await ff([...seek, '-i', localSrc, '-frames:v', '1', out]);
      return out;
    };
    // --- measurement frames (9 uniform) for registration + bg color
    const measDir = path.join(shotDir, '_measure');
    await mkdir(measDir, { recursive: true });
    const measFrames = [];
    for (let i = 0; i < 9; i++) measFrames.push(await grab(i / 8, path.join(measDir, `${i}.png`)));
    const f0 = measFrames[0];
    const cbuf = await rawBin(f0); const cw = (await probe(f0, 'stream=width,height')).split(',').map(Number);
    const bg = [cbuf[(5 * cw[0] + 5) * 4], cbuf[(5 * cw[0] + 5) * 4 + 1], cbuf[(5 * cw[0] + 5) * 4 + 2]];
    const [W, H] = cw;
    const bgColor = '0x' + bg.map((v) => v.toString(16).padStart(2, '0')).join('');

    // --- source registration target (median over the measurement frames)
    const ms = [];
    for (const fp of measFrames) { const b = await rawBin(fp); const m = measure(b, W, H, { isAlpha: false, bg }); if (m) ms.push(m); }
    const tgt = {
      centerX: median(ms.map((m) => m.centroidX)),
      feetY: median(ms.map((m) => m.bandBottom)),
      headY: median(ms.map((m) => m.bandTop)),
    };
    tgt.height = tgt.feetY - tgt.headY;

    // --- matte + register each of the 3 poses
    const poseStill = {};
    for (const pos of C.POSITIONS) {
      const name = s.edits[pos];
      const dst = path.join(shotDir, 'poses', `${pos}-${name}.png`);
      poseStill[pos] = dst;
      if ((await exists(dst)) && !FORCE) continue;
      const pfile = C.poseFile(s.char, name);
      // matte via pipeline (chroma cutout)
      const mid = `pm-${s.shot}-${pos}`;
      await rm(path.join(C.SCRATCH, 'shots', mid), { recursive: true, force: true });
      await run('node', [PIPELINE, 'shot', 'create', '--id', mid, '--description', 'pose matte', '--root', C.SCRATCH]);
      await run('node', [PIPELINE, 'shot', 'draft', '--id', mid, '--root', C.SCRATCH]);
      await run('node', [PIPELINE, 'shot', 'matte', '--id', mid, '--input', pfile, '--method', 'plate', '--matte', 'chroma', '--refine', 'closed-form', '--format', 'png', '--root', C.SCRATCH]);
      const cut = path.join(C.SCRATCH, 'shots', mid, 'final', 'alpha', '00001.png');
      // measure cutout
      const [pw, ph] = (await probe(cut, 'stream=width,height')).split(',').map(Number);
      const pb = await rawBin(cut);
      const pm = measure(pb, pw, ph, { isAlpha: true });
      const scale = tgt.height / (pm.bandBottom - pm.bandTop);
      const x = Math.round(tgt.centerX - pm.centroidX * scale);
      const y = Math.round(tgt.feetY - pm.bandBottom * scale);
      // composite scaled cutout onto WxH gray
      await ff(['-f', 'lavfi', '-i', `color=${bgColor}:s=${W}x${H}`, '-i', cut, '-filter_complex',
        `[1:v]scale=iw*${scale}:ih*${scale}[p];[0:v][p]overlay=${x}:${y}:format=auto`, '-frames:v', '1', dst]);
      await rm(path.join(C.SCRATCH, 'shots', mid), { recursive: true, force: true });
    }

    // --- assemble cases (per variant x position)
    for (const variant of C.VARIANTS) for (const pos of C.POSITIONS) {
      const spec = C.keyframeSpec(variant, pos);
      const idx = spec.editIndex;
      const caseId = `${s.shot}__${variant}__${pos}`;
      const cdir = C.caseDir(C.EVAL_ROOT, s.shot, variant, pos);
      const refsDir = path.join(cdir, 'refs');
      await mkdir(refsDir, { recursive: true });
      // extract the source frames at this case's times; swap the edit index for the pose still
      const refs = [];
      for (let i = 0; i < spec.times.length; i++) {
        if (i === idx) { refs.push(poseStill[pos]); continue; }
        refs.push(await grab(spec.times[i], path.join(refsDir, `${String(i).padStart(2, '0')}.png`)));
      }
      const prompt = C.buildPrompt({ char: s.char, times: spec.times, index: idx, pose: s.edits[pos] });
      const promptFile = path.join(cdir, 'prompt.md');
      await writeFile(promptFile, prompt + '\n');
      await run('node', [PIPELINE, 'shot', 'create', '--id', caseId, '--description', `keyframe-edit ${caseId}`, '--root', C.SCRATCH]).catch(() => {});
      if (!(await exists(path.join(C.SCRATCH, 'shots', caseId, 'drafts', 'v001')))) await run('node', [PIPELINE, 'shot', 'draft', '--id', caseId, '--root', C.SCRATCH]);
      manifest.push({
        id: caseId, version: 1, model: 'seedance_2_5', 'prompt-file': promptFile, images: refs,
        resolution: '480p', duration: Math.round(D), 'aspect-ratio': '3:4', 'generate-audio': false, mode: 'omni_reference',
        task: 'keyframe-edit-eval',
      });
      tests.push({ id: caseId, shot: s.shot, char: s.char, variant, position: pos, index: idx, times: spec.times, seam: C.posSeam(pos), pose: s.edits[pos], source: `sources/${s.shot}.mp4`, output: `scratch/shots/${caseId}/drafts/v001/output.mp4` });
    }
    console.log(`prepared ${s.shot} (dur ${D.toFixed(2)}s, bg ${bgColor}, target h=${tgt.height} feetY=${tgt.feetY} cx=${tgt.centerX})`);
  }

  await writeFile(path.join(C.EVAL_ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(here, 'tests.json'), JSON.stringify({ suite: 'keyframe-edit-eval', evalRoot: path.relative(C.REPO_ROOT, C.EVAL_ROOT), cases: tests }, null, 2) + '\n');
  console.log(`\nwrote ${manifest.length} cases -> manifest.json + tests.json`);
  console.log(`generate: node bin/pipeline.js shot generate-batch --manifest ${path.relative(C.REPO_ROOT, path.join(C.EVAL_ROOT, 'manifest.json'))} --root ${path.relative(C.REPO_ROOT, C.SCRATCH)}`);
}
main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
