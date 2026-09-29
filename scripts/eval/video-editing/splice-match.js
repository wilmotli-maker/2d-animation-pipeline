#!/usr/bin/env node
// Splice a regenerated clip into the original at the best-matching frames around an edit.
//
//   node splice-match.js --orig orig.mp4 --gen gen.mp4 --out spliced.mp4 --edit 2.5 \
//        [--in-lo 0.8 --in-hi 2.0] [--out-lo 3.0 --out-hi 4.3] [--shift 0.5] [--blend 4] [--retime]
//        [--gen-in-hi S] [--gen-out-lo S] [--seam mid|head|tail] [--align none|t|tr|trs] [--ablate] [--report r.json]
//
// --seam: mid keeps original head AND tail (two seams, default); head keeps only the original
// tail (first-frame edit, one out-seam); tail keeps only the original head (last-frame edit).
//
// Picks an in-point (orig frame a <-> gen frame a') before the edit and an out-point
// (orig frame b <-> gen frame b') after it that minimise frame + previous-frame difference
// (so pose AND motion match), preferring small time offsets so the clip keeps its length.
// Result: orig[0..a) + gen[a'..b'] + orig(b..end], with an optional `blend`-frame crossfade
// at each seam (0 = hard cut, which avoids ghosting).
//
// --align fits ONE global transform of the whole generated clip (translation, +rotation,
// +uniform scale) that minimises the difference at the two seams, then re-finds the best
// frame pairs under it and iterates. Modes: t = translate, tr = +rotate, trs = +scale.
// The aligned clip is rendered to <out>-gen-aligned.mp4 and the seams re-measured from it.
// --ablate prints the seam distances for every mode. Distances are mean abs diff on 140x188 gray.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const orig = arg('orig'), gen0 = arg('gen'), out = arg('out');
if (!orig || !gen0 || !out) { console.error('usage: splice-match.js --orig f --gen f --out f --edit T [...]'); process.exit(2); }
const edit = Number(arg('edit', 2.5));
const FPS = 24, W = 140, H = 188;
const inLo = Number(arg('in-lo', edit - 1.7)), inHi = Number(arg('in-hi', edit - 0.5));
const outLo = Number(arg('out-lo', edit + 0.5)), outHi = Number(arg('out-hi', edit + 1.8));
const shift = Math.round(Number(arg('shift', 0.5)) * FPS);
const blend = Number(arg('blend', 4));
const alignMode = arg('align', 'none');
// seam: mid = two seams (keep orig head+tail), head = keep orig tail only (first-frame edit),
// tail = keep orig head only (last-frame edit).
const seam = arg('seam', 'mid');
const OFFSET_PENALTY = 1.5; // grey levels per second of orig/gen time offset
const NEIGHBOURS = 3;       // extra frame pairs on each side used to fit the transform

function run(bin, args, collect) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: ['ignore', collect ? 'pipe' : 'inherit', 'pipe'] });
    const chunks = []; let err = '';
    if (collect) c.stdout.on('data', (d) => chunks.push(d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${bin} exit ${code}\n${err.slice(-600)}`))));
  });
}
async function frames(file) {
  const buf = await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `fps=${FPS},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], true);
  const n = Math.floor(buf.length / (W * H));
  return Array.from({ length: n }, (_, i) => buf.subarray(i * W * H, (i + 1) * W * H));
}
async function probe(file) {
  const o = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], true)).toString().trim();
  const [w, h] = o.split(',').map(Number);
  return { w, h };
}
async function cornerColor(file) {
  const b = await run('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'format=rgb24,crop=1:1:5:5', '-f', 'rawvideo', '-'], true);
  return '0x' + [...b.subarray(0, 3)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function mad(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

// p_out = c + t + s*R(theta)*(p_in - c); R is clockwise on a y-down image (matches ffmpeg's rotate).
function warp(src, P) {
  if (!P.tx && !P.ty && P.s === 1 && !P.rot) return src;
  const out = new Float32Array(W * H);
  const cx = (W - 1) / 2, cy = (H - 1) / 2, th = P.rot * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx - P.tx, dy = y - cy - P.ty;
      let sx = (c * dx + sn * dy) / P.s + cx, sy = (-sn * dx + c * dy) / P.s + cy;
      sx = Math.min(Math.max(sx, 0), W - 1); sy = Math.min(Math.max(sy, 0), H - 1);
      const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
      const fx = sx - x0, fy = sy - y0;
      out[y * W + x] = (src[y0 * W + x0] * (1 - fx) + src[y0 * W + x1] * fx) * (1 - fy) +
                       (src[y1 * W + x0] * (1 - fx) + src[y1 * W + x1] * fx) * fy;
    }
  }
  return out;
}

const [O, G0] = await Promise.all([frames(orig), frames(gen0)]);
const rng = (lo, hi) => [Math.max(1, Math.round(lo * FPS)), Math.round(hi * FPS)];
const genInHi = arg('gen-in-hi'), genOutLo = arg('gen-out-lo');
const jInMax = genInHi !== undefined ? Math.round(Number(genInHi) * FPS) : undefined;
const jOutMin = genOutLo !== undefined ? Math.round(Number(genOutLo) * FPS) : undefined;

function best(Gw, dist, lo, hi, jMin, jMax) {
  let b = null;
  const [a0, a1] = rng(lo, hi);
  for (let i = a0; i <= Math.min(a1, O.length - 1); i++) {
    for (let j = Math.max(1, i - shift, jMin ?? 0); j <= Math.min(i + shift, Gw.length - 1, jMax ?? Infinity); j++) {
      const d = dist(i, j), score = d + OFFSET_PENALTY * Math.abs(i - j) / FPS;
      if (!b || score < b.score) b = { i, j, d, score };
    }
  }
  return b;
}
function findPairs(Gw) {
  const dist = (i, j) => mad(O[i], Gw[j]) + (i > 0 && j > 0 ? mad(O[i - 1], Gw[j - 1]) : 0);
  return { inPt: best(Gw, dist, inLo, inHi, undefined, jInMax), outPt: best(Gw, dist, outLo, outHi, jOutMin, undefined) };
}

const IDENT = { tx: 0, ty: 0, s: 1, rot: 0 };
const MODES = { none: [], t: ['tx', 'ty'], tr: ['tx', 'ty', 'rot'], trs: ['tx', 'ty', 'rot', 's'] };
const STEP = { tx: 3, ty: 3, rot: 1.5, s: 0.02 };

function pairSet({ inPt, outPt }) {
  const ps = [];
  for (let m = 0; m <= NEIGHBOURS; m++) {
    if (seam !== 'head' && inPt.i - m >= 0 && inPt.j - m >= 0) ps.push([inPt.i - m, inPt.j - m]);
    if (seam !== 'tail' && outPt.i + m < O.length && outPt.j + m < G0.length) ps.push([outPt.i + m, outPt.j + m]);
  }
  return ps;
}
function cost(P, ps) {
  const cache = new Map(); let s = 0;
  for (const [i, j] of ps) {
    if (!cache.has(j)) cache.set(j, warp(G0[j], P));
    s += mad(O[i], cache.get(j));
  }
  return s / ps.length;
}
function optimise(P0, ps, active) {
  let P = { ...P0 }, best_ = cost(P, ps);
  for (const f of [1, 0.5, 0.25, 0.125, 0.0625]) {
    for (let improved = true, guard = 0; improved && guard < 30; guard++) {
      improved = false;
      for (const k of active) {
        for (const sign of [1, -1]) {
          const Q = { ...P, [k]: P[k] + sign * STEP[k] * f };
          const c = cost(Q, ps);
          if (c < best_ - 1e-6) { P = Q; best_ = c; improved = true; break; }
        }
      }
    }
  }
  return P;
}
function fit(mode) {
  const active = MODES[mode];
  let P = { ...IDENT };
  let pairs = findPairs(G0);
  if (!active.length) return { P, pairs };
  for (let it = 0; it < 3; it++) {
    P = optimise(P, pairSet(pairs), active);
    pairs = findPairs(G0.map((g) => warp(g, P)));
  }
  return { P, pairs };
}

const fits = {};
for (const m of argv.includes('--ablate') ? Object.keys(MODES) : [alignMode]) fits[m] = fit(m);
const fmtP = (P) => `tx=${(P.tx * 4).toFixed(1)}px ty=${(P.ty * 4).toFixed(1)}px rot=${P.rot.toFixed(2)}deg scale=${P.s.toFixed(4)} (px at 560x752)`;
if (argv.includes('--ablate')) {
  console.log('mode  in-seam  out-seam   transform');
  for (const [m, f] of Object.entries(fits)) console.log(`${m.padEnd(5)} ${f.pairs.inPt.d.toFixed(2).padStart(7)}  ${f.pairs.outPt.d.toFixed(2).padStart(8)}   ${fmtP(f.P)}`);
}
if (!fits[alignMode]) fits[alignMode] = fit(alignMode);
const { P, pairs } = fits[alignMode];
let { inPt, outPt } = pairs;
// For single-seam edits, pin the absent seam to the clip boundary.
if (seam === 'head') inPt = { i: 0, j: 0, d: 0 };
if (seam === 'tail') outPt = { i: O.length - 1, j: G0.length - 1, d: 0 };
if (!inPt || !outPt || outPt.j <= inPt.j + blend) { console.error('no valid in/out points found; widen the search ranges'); process.exit(1); }
const { i: a, j: a2 } = inPt, { i: b, j: b2 } = outPt;

// Render the aligned generated clip, then splice from it.
let gen = gen0;
const { w: W0, h: H0 } = await probe(orig);
if (alignMode !== 'none') {
  gen = out.replace(/\.mp4$/, '') + '-gen-aligned.mp4';
  const fill = await cornerColor(gen0);
  const sx = W0 / W, sy = H0 / H;
  const th = (P.rot * Math.PI / 180).toFixed(6);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', gen0, '-filter_complex',
    `[0:v]rotate=${th}:ow=iw:oh=ih:c=${fill},scale=iw*${P.s}:ih*${P.s}:flags=bicubic[g];` +
    `color=c=${fill}:s=${W0}x${H0}:r=${FPS}[cv];[cv][g]overlay=x=(W-w)/2+${(P.tx * sx).toFixed(3)}:y=(H-h)/2+${(P.ty * sy).toFixed(3)}:shortest=1:format=auto[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', gen]);
}

let verified = null;
if (alignMode !== 'none') {
  const Ga = await frames(gen);
  const d = (i, j) => mad(O[i], Ga[j]) + (i > 0 && j > 0 ? mad(O[i - 1], Ga[j - 1]) : 0);
  verified = { inSeam: +d(a, a2).toFixed(2), outSeam: +d(b, b2).toFixed(2) };
}

let adj = 0; for (let i = 1; i < O.length; i++) adj += mad(O[i], O[i - 1]); adj /= (O.length - 1);

const t = (f) => (f / FPS).toFixed(4);
const N = blend;
const retime = argv.includes('--retime');
// gen material used, and the original-timeline span it must fill:
const genStart = seam === 'head' ? 0 : a2;
const genEnd = seam === 'tail' ? G0.length - 1 : b2;   // inclusive
const spanStart = seam === 'head' ? 0 : a;
const spanEnd = seam === 'tail' ? O.length - 1 : b;    // inclusive
const k = retime ? (spanEnd - spanStart) / (genEnd - genStart) : 1;
const segLen = retime ? (spanEnd - spanStart) : (genEnd - genStart);
const keepPre = seam !== 'head';   // keep original frames before the edit
const keepPost = seam !== 'tail';  // keep original frames after the edit
const stretch = (start, end, keep) => `[1:v]trim=start_frame=${start}:end_frame=${end},setpts=${k}*(PTS-STARTPTS),fps=${FPS}` +
  (retime ? `,trim=end_frame=${keep}` : '') + ',setpts=PTS-STARTPTS';
let fc;
if (N > 0 && keepPre && keepPost) {
  // two-seam crossfade (mid)
  fc = `[0:v]trim=end_frame=${spanStart + N},setpts=PTS-STARTPTS,fps=${FPS}[s1];` +
    `${stretch(genStart, genEnd + N, segLen + N)}[s2];` +
    `[0:v]trim=start_frame=${spanEnd},setpts=PTS-STARTPTS,fps=${FPS}[s3];` +
    `[s1][s2]xfade=transition=fade:duration=${t(N)}:offset=${t(spanStart)}[x1];` +
    `[x1][s3]xfade=transition=fade:duration=${t(N)}:offset=${t(spanStart + segLen)}[v]`;
} else {
  // hard-cut concat; drop the absent side for head/tail
  const parts = [];
  if (keepPre) parts.push(`[0:v]trim=end_frame=${spanStart},setpts=PTS-STARTPTS,fps=${FPS}[s1]`);
  parts.push(`${stretch(genStart, genEnd + 1, segLen + 1)}[s2]`);
  if (keepPost) parts.push(`[0:v]trim=start_frame=${spanEnd + 1},setpts=PTS-STARTPTS,fps=${FPS}[s3]`);
  const labels = [keepPre ? '[s1]' : '', '[s2]', keepPost ? '[s3]' : ''].join('');
  const n = (keepPre ? 1 : 0) + 1 + (keepPost ? 1 : 0);
  fc = parts.join(';') + `;${labels}concat=n=${n}:v=1:a=0[v]`;
}
await run('ffmpeg', ['-v', 'error', '-y', '-i', orig, '-i', gen, '-filter_complex', fc, '-map', '[v]',
  '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', out]);

const report = {
  edit, seam, blendFrames: N, retimeFactor: +k.toFixed(3), align: alignMode,
  transform: alignMode === 'none' ? null : { txPx: +(P.tx * 4).toFixed(2), tyPx: +(P.ty * 4).toFixed(2), rotDeg: +P.rot.toFixed(3), scale: +P.s.toFixed(4) },
  inPoint: { origFrame: a, origT: +(a / FPS).toFixed(3), genFrame: a2, genT: +(a2 / FPS).toFixed(3), dist: +inPt.d.toFixed(2) },
  outPoint: { origFrame: b, origT: +(b / FPS).toFixed(3), genFrame: b2, genT: +(b2 / FPS).toFixed(3), dist: +outPt.d.toFixed(2) },
  verifiedFromRenderedClip: verified,
  typicalAdjacentFrameDiffInOriginal: +adj.toFixed(2),
  originalFrames: O.length,
  expectedOutputFrames: (keepPre ? spanStart : 0) + segLen + (keepPost ? (O.length - spanEnd - 1) : 0),
};
console.log(JSON.stringify(report, null, 2));
if (arg('report')) await writeFile(arg('report'), JSON.stringify(report, null, 2) + '\n');
