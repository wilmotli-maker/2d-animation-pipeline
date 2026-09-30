#!/usr/bin/env node
// SPIKE: can Seedance 2.5 (video_edit) or Runway Aleph 2.0 "harmonize" a short
// spliced animation — making shadows / textures / highlights / line-weight
// consistent across the whole clip — WITHOUT changing the performance?
//
// The transition-pairs clips are two different animation segments spliced A->B
// and motion-aligned, so their two halves visibly mismatch in lighting and
// rendering. That mismatch is exactly what we want an editor model to iron out
// while leaving pose, motion and timing alone. A frame from the start of the
// clip is used as the appearance target for both models.
//
// Usage:
//   node harmonize.js prep [--clip <path-to-aligned.mp4>] [--prompt "..."]
//        copies the source clip and extracts ref.png (frame 0) into the work dir,
//        and writes config.json. Re-run to switch clips.
//   node harmonize.js run [--arm seedance,aleph] [--go]
//        Without --go this is a DRY RUN (no credits): prints the exact commands
//        and runs Aleph's own --dry-run + a Seedance `verify shot`.
//        With --go it spends credits on the chosen arm(s).
//   node harmonize.js report
//        builds strip.png (source / seedance / aleph at first-mid-last frames)
//        and compare.mp4 (the three stacked vertically, side by side).
//
// Seedance is driven through the real pipeline (bin/pipeline.js shot generate,
// --mode video_edit) rooted INSIDE the work dir, so nothing lands in the project
// shot tree. Aleph is driven through the existing aleph.js spike client.
//
// Work dir: evaluation/video-editing-eval/harmonize-spike/ (gitignored).

import { readFile, writeFile, mkdir, copyFile, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const work = path.join(repoRoot, 'evaluation', 'video-editing-eval', 'harmonize-spike');
const P = (f) => path.join(work, f);
const cfgPath = P('config.json');

const DEFAULT_CLIP = path.join(
  repoRoot, 'evaluation', 'video-editing-eval', 'transition-pairs',
  'art-3-v002__to__art-7-v002', 'art-3-v002__to__art-7-v002__v1-aligned.mp4',
);

const DEFAULT_PROMPT =
  'Keep the character\'s pose, movement and timing exactly as in the source video — ' +
  'do not change the performance, composition or camera. Harmonize the appearance so ' +
  'that shading, textures, highlights, line weight and colour palette are consistent ' +
  'across the whole clip, matching the look of the reference frame. Remove any mismatch ' +
  'in lighting or rendering between the first and second halves so the animation reads ' +
  'as one continuous, uniformly-styled shot.';

// Two-stage previz→restyle prompts (the `previs` command) live in prompts.mjs so
// experiment.js and the previz-blocking skill stay in sync.
import { PREVIS_PROMPT, STYLE_PROMPT } from './prompts.mjs';

// Seedance 2.5 caps at 720p; 480p is the cheap draft rate. The transition-pairs
// clips are 560x752 (~3:4 portrait). Aleph's nearest allowed ratio is 832:1104.
const SEEDANCE = { model: 'seedance_2_5', mode: 'video_edit', resolution: '480p', aspect: '3:4', duration: 4 };
const ALEPH = { model: 'aleph2', ratio: '832:1104' };

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? true); };
const has = (n) => argv.includes(`--${n}`);

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

function exec(bin, args, { capture = false, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { cwd, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    if (capture) { c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d)); }
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} ${args.join(' ')}\nexit ${code}\n${out.slice(-1200)}`))));
  });
}
const ff = (args, o) => exec('ffmpeg', ['-v', 'error', '-y', ...args], o);

async function probeDuration(file) {
  const o = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { capture: true });
  return Number(o.trim());
}

async function prep() {
  const clip = String(arg('clip', DEFAULT_CLIP));
  if (!(await exists(clip))) { console.error(`error: clip not found: ${clip}`); process.exit(2); }
  const prompt = arg('prompt') && arg('prompt') !== true ? String(arg('prompt')) : DEFAULT_PROMPT;

  await mkdir(work, { recursive: true });
  await copyFile(clip, P('source.mp4'));
  // ref.png = the very first frame, the appearance target for both models.
  await ff(['-i', P('source.mp4'), '-vf', 'select=eq(n\\,0)', '-vframes', '1', P('ref.png')]);
  // Aleph takes the appearance anchor as a timed keyframe at t=0.
  await writeFile(P('aleph-keyframes.json'), JSON.stringify([{ path: P('ref.png'), seconds: 0 }], null, 2) + '\n');

  const dur = await probeDuration(P('source.mp4'));
  const cfg = { clip, prompt, sourceDuration: dur, seedance: SEEDANCE, aleph: ALEPH };
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

  console.log(`prepped work dir: ${work}`);
  console.log(`  source.mp4  <- ${path.relative(repoRoot, clip)}  (${dur.toFixed(2)}s)`);
  console.log(`  ref.png     first frame (appearance target)`);
  console.log(`  prompt: ${prompt}`);
}

async function loadCfg() {
  if (!(await exists(cfgPath))) { console.error('error: run `prep` first'); process.exit(2); }
  return JSON.parse(await readFile(cfgPath, 'utf8'));
}

// One Seedance video_edit generation, scaffolded under `shotId` inside the work
// dir. Returns the output path (or null on a dry run / missing output). `image`
// is optional (omit for a pure appearance-stripping pass).
async function seedanceGen({ cfg, shotId, video, image, prompt, label, go }) {
  const s = cfg.seedance;
  const pipeline = path.join(repoRoot, 'bin', 'pipeline.js');
  const base = ['--root', work];
  const genArgs = [
    pipeline, 'shot', 'generate', '--id', shotId, '--version', '1',
    '--model', s.model, '--mode', s.mode,
    '--resolution', s.resolution, '--aspect-ratio', s.aspect, '--duration', String(s.duration),
    '--generate-audio', 'false',
    '--video', video, ...(image ? ['--image', image] : []),
    '--prompt', prompt, ...base,
  ];
  if (!go) {
    console.log(`\n[dry-run] ${label}: would run\n  node ${genArgs.join(' ')}`);
    return null;
  }
  // Fresh scaffold each run so the output is always v001.
  await rm(P(path.join('shots', shotId)), { recursive: true, force: true });
  await exec('node', [pipeline, 'shot', 'create', '--id', shotId, ...base]);
  await exec('node', [pipeline, 'shot', 'draft', '--id', shotId, ...base]);
  console.log(`\n[go] ${label}…`);
  await exec('node', genArgs);
  const out = P(path.join('shots', shotId, 'drafts', 'v001', 'output.mp4'));
  return (await exists(out)) ? out : null;
}

async function runSeedance(cfg, go) {
  const out = await seedanceGen({
    cfg, shotId: 'harmonize', video: P('source.mp4'), image: P('ref.png'),
    prompt: cfg.prompt, label: 'generating Seedance video_edit', go,
  });
  if (!go) return;
  if (out) { await copyFile(out, P('seedance.mp4')); console.log(`  -> ${path.relative(repoRoot, P('seedance.mp4'))}`); }
  else console.error('  warning: expected seedance output not found');
}

// Two-stage previs restyle: source -> neutral greybox previs -> restyled by ref.png.
async function previs() {
  const cfg = await loadCfg();
  const go = has('go');
  if (!go) console.log('DRY RUN — no credits spent. Add --go to execute.');

  const stage1 = await seedanceGen({
    cfg, shotId: 'previs', video: P('source.mp4'), image: null,
    prompt: PREVIS_PROMPT, label: 'stage 1 — source -> greybox previs', go,
  });
  if (go) {
    if (!stage1) { console.error('  stage 1 produced no output; aborting'); process.exit(1); }
    await copyFile(stage1, P('previs.mp4'));
    console.log(`  -> ${path.relative(repoRoot, P('previs.mp4'))}`);
  }

  // On a dry run previs.mp4 doesn't exist yet; the path is only printed, not read.
  const stage2 = await seedanceGen({
    cfg, shotId: 'styled', video: P('previs.mp4'), image: P('ref.png'),
    prompt: STYLE_PROMPT, label: 'stage 2 — previs restyled by ref.png', go,
  });
  if (go) {
    if (stage2) { await copyFile(stage2, P('styled.mp4')); console.log(`  -> ${path.relative(repoRoot, P('styled.mp4'))}`); }
    else console.error('  warning: expected styled output not found');
  } else {
    console.log('\nDry run complete. Re-run with --go to spend credits (2 Seedance generations).');
  }
}

async function runAleph(cfg, go) {
  const alephJs = path.join(here, '..', 'aleph.js');
  const outDir = P('aleph');
  const args = [alephJs, 'submit', '--video', P('source.mp4'), '--prompt', cfg.prompt,
    '--model', cfg.aleph.model, '--ratio', cfg.aleph.ratio,
    '--keyframes', P('aleph-keyframes.json'), '--out', outDir];
  if (!go) args.push('--dry-run');
  console.log(`\n[${go ? 'go' : 'dry-run'}] aleph submit…`);
  await exec('node', args);
  if (go) {
    const out = path.join(outDir, 'output.mp4');
    if (await exists(out)) { await copyFile(out, P('aleph.mp4')); console.log(`  -> ${path.relative(repoRoot, P('aleph.mp4'))}`); }
    else console.error(`  warning: expected output not found at ${out}`);
  }
}

async function run() {
  const cfg = await loadCfg();
  const arms = String(arg('arm', 'seedance,aleph')).split(',').map((a) => a.trim()).filter(Boolean);
  const go = has('go');
  if (!go) console.log('DRY RUN — no credits spent. Add --go to execute.');
  if (arms.includes('seedance')) await runSeedance(cfg, go);
  if (arms.includes('aleph')) await runAleph(cfg, go);
  if (!go) console.log('\nDry run complete. Re-run with --go to spend credits.');
}

async function probeDims(file) {
  const o = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { capture: true });
  const [w, h] = o.trim().split(',').map(Number);
  return { w, h };
}

// Grab first / middle / last frame of a clip as PNGs into work/frames/<tag>-{0,1,2}.png,
// scaled to `dims` so rows from different-resolution models still stack cleanly.
async function grabFrames(file, tag, dur, dims) {
  const dir = P('frames');
  await mkdir(dir, { recursive: true });
  const times = [0.05, dur / 2, Math.max(0, dur - 0.1)];
  const outs = [];
  for (let i = 0; i < times.length; i++) {
    const o = path.join(dir, `${tag}-${i}.png`);
    await ff(['-ss', String(times[i]), '-i', file, '-vframes', '1',
      '-vf', `scale=${dims.w}:${dims.h}`, o]);
    outs.push(o);
  }
  return outs;
}

async function report() {
  const cfg = await loadCfg();
  const clips = [['source', P('source.mp4')]];
  if (await exists(P('seedance.mp4'))) clips.push(['seedance', P('seedance.mp4')]);
  if (await exists(P('aleph.mp4'))) clips.push(['aleph', P('aleph.mp4')]);
  if (await exists(P('previs.mp4'))) clips.push(['previs', P('previs.mp4')]);
  if (await exists(P('styled.mp4'))) clips.push(['styled', P('styled.mp4')]);
  if (clips.length === 1) { console.error('nothing to compare yet — run an arm with --go first'); process.exit(2); }

  const dur = cfg.sourceDuration || (await probeDuration(P('source.mp4')));
  const dims = await probeDims(P('source.mp4'));   // normalize every row to source size
  // Build one row per clip (first|mid|last), then stack rows -> strip.png.
  const rows = [];
  for (const [tag, file] of clips) {
    const fr = await grabFrames(file, tag, dur, dims);
    const row = P(`frames/row-${tag}.png`);
    await ff(['-i', fr[0], '-i', fr[1], '-i', fr[2], '-filter_complex',
      '[0][1][2]hstack=inputs=3', row]);
    rows.push([tag, row]);
  }
  const inputs = rows.flatMap(([, r]) => ['-i', r]);
  const stack = `${rows.map((_, i) => `[${i}]`).join('')}vstack=inputs=${rows.length}`;
  await ff([...inputs, '-filter_complex', stack, P('strip.png')]);
  console.log(`strip.png -> ${path.relative(repoRoot, P('strip.png'))}  (rows: ${rows.map((r) => r[0]).join(' / ')})`);

  // compare.mp4: the clips scaled to equal height, laid out horizontally.
  const vids = clips.map(([, f]) => f);
  const vin = vids.flatMap((f) => ['-i', f]);
  const n = vids.length;
  const scale = vids.map((_, i) => `[${i}:v]scale=-2:480,setpts=PTS-STARTPTS[v${i}]`).join(';');
  const hstack = `${vids.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${n}[out]`;
  await ff([...vin, '-filter_complex', `${scale};${hstack}`, '-map', '[out]', P('compare.mp4')]);
  console.log(`compare.mp4 -> ${path.relative(repoRoot, P('compare.mp4'))}  (${clips.map((c) => c[0]).join(' | ')})`);
}

const main = { prep, run, previs, report }[cmd];
if (main) main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
else {
  console.log('usage: node harmonize.js <prep|run|previs|report> [...]\n' +
    '  prep   [--clip <mp4>] [--prompt "..."]\n' +
    '  run    [--arm seedance,aleph] [--go]      single-pass harmonize\n' +
    '  previs [--go]                             two-stage: source -> greybox previs -> restyle by ref.png\n' +
    '  report');
  process.exit(cmd ? 2 : 0);
}
