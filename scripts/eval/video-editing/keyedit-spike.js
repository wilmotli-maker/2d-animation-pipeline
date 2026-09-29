#!/usr/bin/env node
// SPIKE: can Aleph 2.0 turn a crude, hand-warped keyframe into a clean pose at a
// specific moment while preserving the surrounding motion?
//
//   node keyedit-spike.js prep --start 1 --end 3 --t 2.0 [--prompt "..."]
//        trims the window, extracts frame.png at t for you to warp -> save as keyframe.png
//   node keyedit-spike.js bake [--ease 0.35] [--hold 0.15]
//        builds baked.mp4: original -> warped keyframe (held) -> original
//   node keyedit-spike.js run [--arm A,B,C] [--go]
//        A = window + native keyframe    B = baked guidance, no keyframe
//        C = baked guidance + native keyframe.   Without --go this is a dry run (no credits).
//   node keyedit-spike.js report
//        keyframe-hit scores + strip.png comparing original / baked / A / B / C
//
// Work dir: evaluation/video-editing-eval/keyedit-spike/ (gitignored).

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const work = path.join(repoRoot, 'evaluation', 'video-editing-eval', 'keyedit-spike');
const P = (f) => path.join(work, f);
const cfgPath = P('spike.json');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? true); };

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
const loadCfg = async () => JSON.parse(await readFile(cfgPath, 'utf8'));

function exec(bin, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    if (capture) { c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d)); }
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} exit ${code}\n${out.slice(-800)}`))));
  });
}
const ff = (args, o) => exec('ffmpeg', ['-v', 'error', '-y', ...args], o);

async function dims(file) {
  const o = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', file], { capture: true });
  const [w, h] = o.trim().split(',').map(Number);
  return { w, h };
}

async function prep() {
  const start = Number(arg('start')), end = Number(arg('end')), t = Number(arg('t'));
  if (![start, end, t].every(Number.isFinite) || !(start < t && t < end)) {
    console.error('usage: prep --start S --end E --t T   (S < T < E, seconds in the source clip)');
    process.exit(2);
  }
  const source = path.join(repoRoot, 'evaluation', 'video-editing-eval', 'sources', 'art-4-v002.mp4');
  const prompt = arg('prompt', 'Keep the character, style, background and motion exactly as in the video, ' +
    'but at the keyframe timestamp match the pose in the keyframe image. Clean up any warping, stretching or blur artifacts.');
  await mkdir(work, { recursive: true });
  // Re-encode (not stream-copy) so the cut is frame-accurate.
  await ff(['-ss', String(start), '-i', source, '-t', String(end - start), '-an', '-r', '24',
    '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', P('window.mp4')]);
  const tr = +(t - start).toFixed(3);
  await ff(['-i', P('window.mp4'), '-ss', String(tr), '-frames:v', '1', P('frame.png')]);
  const cfg = { source: path.relative(repoRoot, source), start, end, t, tr, prompt, ease: 0.35, hold: 0.15 };
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  const { size } = await (await import('node:fs/promises')).stat(P('window.mp4'));
  console.log(`window.mp4 ${(size / 1e6).toFixed(2)}MB (${end - start}s), keyframe time within window = ${tr}s`);
  console.log(`edit ${path.relative(repoRoot, P('frame.png'))} and save the result as ${path.relative(repoRoot, P('keyframe.png'))}`);
}

async function bake() {
  const cfg = await loadCfg();
  if (!(await exists(P('keyframe.png')))) { console.error('missing keyframe.png in ' + work); process.exit(2); }
  const ease = Number(arg('ease', cfg.ease)), hold = Number(arg('hold', cfg.hold));
  const { w, h } = await dims(P('window.mp4'));
  const kd = await dims(P('keyframe.png'));
  if (kd.w !== w || kd.h !== h) console.warn(`note: keyframe is ${kd.w}x${kd.h}, window is ${w}x${h}; scaling keyframe.`);
  const dur = cfg.end - cfg.start;
  const t0 = cfg.tr - hold / 2, t1 = cfg.tr + hold / 2;
  const clip = (x) => `min(max(${x},0),1)`;
  const a = `${clip(`(T-(${t0}-${ease}))/${ease}`)}*${clip(`((${t1}+${ease})-T)/${ease}`)}`;
  await ff(['-i', P('window.mp4'), '-loop', '1', '-framerate', '24', '-t', String(dur), '-i', P('keyframe.png'),
    '-filter_complex',
    `[0:v]setpts=PTS-STARTPTS,format=yuv420p[s];[1:v]scale=${w}:${h},setpts=PTS-STARTPTS,format=yuv420p[k];` +
    `[s][k]blend=all_expr='A*(1-(${a}))+B*(${a})':shortest=1[v]`,
    '-map', '[v]', '-r', '24', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', P('baked.mp4')]);
  await writeFile(cfgPath, JSON.stringify({ ...cfg, ease, hold }, null, 2) + '\n');
  console.log(`baked.mp4 written (ease ${ease}s, hold ${hold}s around ${cfg.tr}s)`);
}

const ARMS = {
  A: { video: 'window.mp4', keyframe: true, desc: 'original window + native keyframe' },
  B: { video: 'baked.mp4', keyframe: false, desc: 'baked guidance, no keyframe' },
  C: { video: 'baked.mp4', keyframe: true, desc: 'baked guidance + native keyframe' },
};

async function run() {
  const cfg = await loadCfg();
  const go = argv.includes('--go');
  const arms = String(arg('arm', 'A,B,C')).split(',').map((s) => s.trim().toUpperCase());
  const seedArg = arg('seed');
  const secs = cfg.end - cfg.start;
  console.log(`${go ? 'RUN' : 'DRY RUN'}: arms ${arms.join(',')}, ~${arms.length * secs * 28} credits (~$${(arms.length * secs * 0.28).toFixed(2)})`);
  for (const name of arms) {
    const arm = ARMS[name];
    if (!arm) { console.error(`unknown arm ${name}`); process.exit(2); }
    if (!(await exists(P(arm.video)))) { console.error(`missing ${arm.video} (run prep/bake first)`); process.exit(2); }
    const outDir = P(name);
    await mkdir(outDir, { recursive: true });
    const args = [path.join(here, 'aleph.js'), 'submit', '--video', P(arm.video), '--prompt', cfg.prompt,
      '--ratio', '832:1104', '--out', outDir];
    if (arm.keyframe) {
      const kf = path.join(outDir, 'keyframes.json');
      await writeFile(kf, JSON.stringify([{ path: P('keyframe.png'), seconds: cfg.tr }], null, 2) + '\n');
      args.push('--keyframes', kf);
    }
    if (seedArg && seedArg !== true) args.push('--seed', String(seedArg));
    if (!go) args.push('--dry-run');
    console.log(`\n--- arm ${name}: ${arm.desc}`);
    await exec('node', args);
  }
  if (!go) console.log('\n(dry run: pass --go to submit and spend credits)');
}

async function ssim(a, b, size) {
  const o = await exec('ffmpeg', ['-v', 'info', '-i', a, '-i', b, '-filter_complex',
    `[0:v]scale=${size},setsar=1[a];[1:v]scale=${size},setsar=1[b];[a][b]ssim`, '-f', 'null', '-'], { capture: true });
  const m = o.match(/All:([0-9.]+)/);
  return m ? Number(m[1]) : null;
}

async function report() {
  const cfg = await loadCfg();
  const { w, h } = await dims(P('window.mp4'));
  const size = `${w}:${h}`;
  const frameAt = async (video, s, dest) =>
    ff(['-i', video, '-ss', String(Math.max(0, s)), '-frames:v', '1', '-vf', `scale=${size}`, dest]);
  const rows = [['original', P('window.mp4')]];
  if (await exists(P('baked.mp4'))) rows.push(['baked', P('baked.mp4')]);
  for (const n of Object.keys(ARMS)) if (await exists(P(`${n}/output.mp4`))) rows.push([n, P(`${n}/output.mp4`)]);

  const offs = [-0.5, 0, 0.5];
  const scores = {};
  const strips = [];
  for (const [name, video] of rows) {
    const cells = [];
    for (const o of offs) {
      const f = P(`.cell-${name}-${o}.png`);
      await frameAt(video, cfg.tr + o, f);
      cells.push(f);
    }
    const strip = P(`.row-${name}.png`);
    await ff([...cells.flatMap((c) => ['-i', c]), '-filter_complex', `hstack=inputs=${cells.length}`, '-frames:v', '1', strip]);
    strips.push(strip);
    const at = P(`.cell-${name}-0.png`);
    scores[name] = { ssim_to_keyframe_at_t: await ssim(at, P('keyframe.png'), size) };
    if (name !== 'original' && name !== 'baked') {
      scores[name].mean_ssim_vs_original_window = await ssim(video, P('window.mp4'), size);
    }
  }
  await ff([...strips.flatMap((s) => ['-i', s]), '-filter_complex', `vstack=inputs=${strips.length}`, '-frames:v', '1', P('strip.png')]);
  await writeFile(P('report.json'), JSON.stringify({ tr: cfg.tr, offsets: offs, rows: rows.map((r) => r[0]), scores }, null, 2) + '\n');
  console.log(`strip.png rows top->bottom: ${rows.map((r) => r[0]).join(', ')}; columns t${offs.map((o) => (o >= 0 ? '+' : '') + o).join(', t')}`);
  console.log(JSON.stringify(scores, null, 2));
  console.log('For per-arm heatmaps run analyze.js: node analyze.js --src window.mp4 --out <arm>/output.mp4 --dir <arm>');
}

const cmds = { prep, bake, run, report };
if (!cmds[cmd]) { console.log(__usage()); process.exit(cmd ? 2 : 0); }
function __usage() { return 'usage: keyedit-spike.js <prep|bake|run|report> — see header comment'; }
cmds[cmd]().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
