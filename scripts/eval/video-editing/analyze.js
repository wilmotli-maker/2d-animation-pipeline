#!/usr/bin/env node
// THROWAWAY SPIKE — measures how close an Aleph output stays to its source draft.
// Produces viewable artifacts (matching the eyeball-comparison style already in
// evaluation/) plus two summary numbers.
//
// Usage:
//   node analyze.js --src path/to/draft.mp4 --out path/to/output.mp4 [--dir <resultdir>]
//
// Writes into <dir> (default: alongside --out):
//   norm-out.mp4      Aleph output rescaled to the source's WxH and fps (so the
//                     comparison is apples-to-apples).
//   compare.mp4       source | aleph, side by side.
//   diff-heatmap.mp4  per-pixel difference, amplified and false-coloured (turbo).
//                     Cool/dark = unchanged, hot = Aleph altered it. THIS is the
//                     stability answer: hot areas outside your intended edit = drift.
//   ssim.log/psnr.log per-frame metrics from ffmpeg.
//   summary.json      mean SSIM, mean PSNR, and the worst (least-similar) frame.
//
// SSIM ~1.0 / high PSNR (>40dB) => output nearly identical to source. Lower
// values mean Aleph changed more. Since these are WHOLE-FRAME metrics, a big
// intended edit lowers them too — read them together with the heatmap, which
// shows WHERE the change is.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function run(bin, args) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const c = spawn(bin, args);
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('error', (e) => resolve({ code: 127, stdout, stderr: String(e.message) }));
    c.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function probe(file) {
  const { code, stdout, stderr } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate',
    '-of', 'json', file,
  ]);
  if (code !== 0) throw new Error(`ffprobe ${file} failed: ${stderr.trim()}`);
  const s = JSON.parse(stdout).streams[0];
  const [num, den] = String(s.r_frame_rate).split('/').map(Number);
  return { width: s.width, height: s.height, fps: den ? num / den : num };
}

// Parse ffmpeg's ssim/psnr per-frame stats logs.
function parseStats(text, key) {
  const vals = [];
  for (const line of text.split('\n')) {
    const m = new RegExp(`${key}:([-0-9.]+|inf)`).exec(line);
    if (m) {
      const n = m[1] === 'inf' ? Infinity : Number(m[1]);
      const nf = /n:(\d+)/.exec(line);
      vals.push({ frame: nf ? Number(nf[1]) : vals.length, value: n });
    }
  }
  return vals;
}

function mean(nums) {
  const finite = nums.filter((n) => Number.isFinite(n));
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = args.src && args.src !== true ? String(args.src) : null;
  const out = args.out && args.out !== true ? String(args.out) : null;
  if (!src || !out) {
    console.error('usage: node analyze.js --src <draft.mp4> --out <output.mp4> [--dir <resultdir>]');
    process.exit(2);
  }
  const dir = args.dir && args.dir !== true ? String(args.dir) : path.dirname(out);
  await mkdir(dir, { recursive: true });

  const meta = await probe(src);
  const { width: W, height: H, fps: F } = meta;
  console.log(`source: ${W}x${H} @ ${F.toFixed(2)}fps`);

  // 1) Normalize the Aleph output to the source geometry so every comparison is
  //    aligned frame-for-frame.
  const norm = path.join(dir, 'norm-out.mp4');
  console.log('normalizing aleph output to source geometry…');
  let r = await run('ffmpeg', ['-y', '-i', out,
    '-vf', `scale=${W}:${H}:flags=bicubic,fps=${F}`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-an', norm]);
  if (r.code !== 0) throw new Error(`normalize failed: ${r.stderr.slice(-500)}`);

  // 2) Side-by-side compare video.
  const compare = path.join(dir, 'compare.mp4');
  console.log('building compare.mp4 (source | aleph)…');
  r = await run('ffmpeg', ['-y', '-i', src, '-i', norm,
    '-filter_complex', '[0:v][1:v]hstack=inputs=2[v]', '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-an', compare]);
  if (r.code !== 0) throw new Error(`compare failed: ${r.stderr.slice(-500)}`);

  // 3) Difference heatmap: |src - out|, amplified, false-coloured turbo.
  const heat = path.join(dir, 'diff-heatmap.mp4');
  console.log('building diff-heatmap.mp4…');
  const heatFilter =
    "[0:v][1:v]blend=all_mode=difference,format=gray," +
    "curves=all='0/0 0.08/0.5 0.25/0.9 1/1',pseudocolor=preset=turbo[hm]";
  r = await run('ffmpeg', ['-y', '-i', src, '-i', norm,
    '-filter_complex', heatFilter, '-map', '[hm]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-an', heat]);
  if (r.code !== 0) {
    console.warn('pseudocolor heatmap failed (older ffmpeg?); falling back to grayscale diff.');
    const gray = "[0:v][1:v]blend=all_mode=difference,format=gray,curves=all='0/0 0.08/0.5 1/1'[hm]";
    r = await run('ffmpeg', ['-y', '-i', src, '-i', norm,
      '-filter_complex', gray, '-map', '[hm]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-an', heat]);
    if (r.code !== 0) throw new Error(`heatmap failed: ${r.stderr.slice(-500)}`);
  }

  // 4) SSIM + PSNR per frame (norm-out measured against src reference).
  const ssimLog = path.join(dir, 'ssim.log');
  const psnrLog = path.join(dir, 'psnr.log');
  console.log('computing ssim + psnr…');
  r = await run('ffmpeg', ['-y', '-i', norm, '-i', src,
    '-lavfi', `[0:v][1:v]ssim=stats_file=${ssimLog};[0:v][1:v]psnr=stats_file=${psnrLog}`,
    '-f', 'null', '-']);
  if (r.code !== 0) throw new Error(`ssim/psnr failed: ${r.stderr.slice(-500)}`);

  const ssim = parseStats(await readFile(ssimLog, 'utf8'), 'All');
  const psnr = parseStats(await readFile(psnrLog, 'utf8'), 'psnr_avg');
  const meanSsim = mean(ssim.map((v) => v.value));
  const meanPsnr = mean(psnr.map((v) => v.value));
  const worst = ssim.slice().sort((a, b) => a.value - b.value)[0] || null;

  const summary = {
    source: { file: src, width: W, height: H, fps: Number(F.toFixed(3)) },
    alephOutput: out,
    frames: ssim.length,
    meanSSIM: meanSsim != null ? Number(meanSsim.toFixed(4)) : null,
    meanPSNR_dB: meanPsnr != null ? Number(meanPsnr.toFixed(2)) : null,
    worstFrame: worst ? { frame: worst.frame, ssim: Number(worst.value.toFixed(4)) } : null,
    artifacts: { compare, diffHeatmap: heat, normalizedOutput: norm },
  };
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  console.log('\n=== stability summary ===');
  console.log(`frames:      ${summary.frames}`);
  console.log(`mean SSIM:   ${summary.meanSSIM}   (1.0 = identical)`);
  console.log(`mean PSNR:   ${summary.meanPSNR_dB} dB   (>40 = near-identical)`);
  if (worst) console.log(`worst frame: #${worst.frame}  SSIM ${summary.worstFrame.ssim}`);
  console.log(`\nartifacts in ${dir}:`);
  console.log(`  compare.mp4       (source | aleph)`);
  console.log(`  diff-heatmap.mp4  (hot = Aleph changed it — look for hot OUTSIDE your edit)`);
  console.log(`  summary.json`);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
