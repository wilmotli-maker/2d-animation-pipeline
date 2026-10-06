#!/usr/bin/env node
// Splice each generated transition into a full edit: shot1 (bg recolored to match) + the ~1s
// morph (aligned) + shot2. Runs only on cases whose generation output exists. No credits.
//   node splice.js [--pair <a__to__b>] [--only <caseId>]
import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as C from './config.mjs';
import { recolorBg } from './bg-recolor.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };
const ONLY = arg('only'), PAIR = arg('pair');
const FPS = 24, W = 140, H = 188;
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
function run(bin, a, cap) {
  return new Promise((res, rej) => {
    const c = spawn(bin, a, { stdio: ['ignore', cap ? 'pipe' : 'inherit', 'pipe'] });
    const o = []; let e = ''; if (cap) c.stdout.on('data', (d) => o.push(d)); c.stderr.on('data', (d) => (e += d));
    c.on('close', (code) => (code === 0 ? res(Buffer.concat(o)) : rej(new Error(`${bin} exit ${code}\n${e.slice(-300)}`))));
  });
}
const ff = (a, cap) => run('ffmpeg', ['-v', 'error', '-y', ...a], cap);
async function grayFrames(file) {
  const buf = await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `fps=${FPS},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], true);
  const n = Math.floor(buf.length / (W * H));
  return Array.from({ length: n }, (_, i) => buf.subarray(i * W * H, (i + 1) * W * H));
}
async function grayImage(file) { return (await grayFrames(file))[0]; }
async function probe(f, e) { return (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', e, '-of', 'csv=p=0', f], true)).toString().trim(); }
const mad = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
function warp(src, P) {
  if (!P.tx && !P.ty && P.s === 1 && !P.rot) return src;
  const out = new Float32Array(W * H), cx = (W - 1) / 2, cy = (H - 1) / 2, th = P.rot * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - cx - P.tx, dy = y - cy - P.ty;
    let sx = (c * dx + sn * dy) / P.s + cx, sy = (-sn * dx + c * dy) / P.s + cy;
    sx = Math.min(Math.max(sx, 0), W - 1); sy = Math.min(Math.max(sy, 0), H - 1);
    const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1), fx = sx - x0, fy = sy - y0;
    out[y * W + x] = (src[y0 * W + x0] * (1 - fx) + src[y0 * W + x1] * fx) * (1 - fy) + (src[y1 * W + x0] * (1 - fx) + src[y1 * W + x1] * fx) * fy;
  }
  return out;
}
const STEP = { tx: 3, ty: 3, rot: 1.5, s: 0.02 };
function fit(pairs) {
  let P = { tx: 0, ty: 0, rot: 0, s: 1 }, best = pairs.reduce((a, [g, t]) => a + mad(warp(g, P), t), 0);
  for (const f of [4, 2, 1, 0.5, 0.25, 0.125]) for (let imp = true, gu = 0; imp && gu < 40; gu++) {
    imp = false;
    for (const k of ['tx', 'ty', 'rot', 's']) for (const sg of [1, -1]) {
      const Q = { ...P, [k]: P[k] + sg * STEP[k] * f }, c = pairs.reduce((a, [g, t]) => a + mad(warp(g, Q), t), 0);
      if (c < best - 1e-6) { P = Q; best = c; imp = true; break; }
    }
  }
  return P;
}

const recoloredShot1 = new Map(); // pair -> path
async function shot1Recolored(a, b, meta) {
  const key = C.pairId(a, b);
  if (recoloredShot1.has(key)) return recoloredShot1.get(key);
  const out = path.join(C.caseDir(a, b), 'shot1-bgmatched.mp4');
  if (!(await exists(out))) await recolorBg(path.join(C.EVAL_ROOT, 'sources', `${a}.mp4`), out, meta.aBg, meta.bBg, { video: true });
  recoloredShot1.set(key, out); return out;
}

for (const cs of C.cases()) {
  if (ONLY && cs.id !== ONLY) continue;
  if (PAIR && C.pairId(cs.a, cs.b) !== PAIR) continue;
  const dir = C.caseDir(cs.a, cs.b);
  const gen = path.join(C.SCRATCH, 'shots', cs.id, 'drafts', 'v001', 'output.mp4');
  if (!(await exists(gen))) { console.log(`skip ${cs.id} (no output)`); continue; }
  const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
  const Atar = await grayImage(path.join(dir, 'A-endShot1.png'));
  const Btar = await grayImage(path.join(dir, 'B-startShot2.png'));
  const G = await grayFrames(gen);
  // cut points: closest gen frame to A (first ~60%) and to B (last ~60%)
  let cs0 = 0, cs0d = Infinity, ce = G.length - 1, ced = Infinity;
  for (let i = 0; i < G.length; i++) {
    if (i <= G.length * 0.62) { const d = mad(G[i], Atar); if (d < cs0d) { cs0d = d; cs0 = i; } }
    if (i >= G.length * 0.38) { const d = mad(G[i], Btar); if (d < ced) { ced = d; ce = i; } }
  }
  if (ce <= cs0 + 2) {
    // model morphed almost instantly / endpoints too close: fall back to the designed morph
    // window (1.5s..2.5s of the 4s clip) so the pair still yields a full edit.
    cs0 = Math.round(G.length * 0.375); ce = Math.round(G.length * 0.625);
    console.log(`${cs.id}: degenerate content cut -> fixed window ${cs0}->${ce}`);
  }
  const P = fit([[G[cs0], Atar], [G[ce], Btar]]);
  // render aligned gen on the shared bg colour
  const { w: W0, h: H0 } = { w: Number((await probe(gen, 'stream=width')).split('\n')[0]), h: Number((await probe(gen, 'stream=height')).split('\n')[0]) };
  const fill = '0x' + meta.bBg.map((v) => v.toString(16).padStart(2, '0')).join('');
  const aligned = path.join(dir, `${cs.id}-aligned.mp4`);
  const sx = W0 / W, sy = H0 / H, th = (P.rot * Math.PI / 180).toFixed(6);
  await ff(['-i', gen, '-filter_complex',
    `[0:v]rotate=${th}:ow=iw:oh=ih:c=${fill},scale=iw*${P.s}:ih*${P.s}:flags=bicubic[g];color=c=${fill}:s=${W0}x${H0}:r=${FPS}[cv];` +
    `[cv][g]overlay=x=(W-w)/2+${(P.tx * sx).toFixed(2)}:y=(H-h)/2+${(P.ty * sy).toFixed(2)}:shortest=1:format=auto[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', aligned]);
  // morph = aligned gen (cs0+1 .. ce-1)
  const shot1c = await shot1Recolored(cs.a, cs.b, meta);
  const shot2 = path.join(C.EVAL_ROOT, 'sources', `${cs.b}.mp4`);
  const out = path.join(dir, `${cs.id}-edit.mp4`);
  const fc =
    `[0:v]scale=${W0}:${H0},fps=${FPS},format=yuv420p[s1];` +
    `[1:v]trim=start_frame=${cs0 + 1}:end_frame=${ce},setpts=PTS-STARTPTS,scale=${W0}:${H0},fps=${FPS},format=yuv420p[m];` +
    `[2:v]scale=${W0}:${H0},fps=${FPS},format=yuv420p[s2];[s1][m][s2]concat=n=3:v=1:a=0[v]`;
  await ff(['-i', shot1c, '-i', aligned, '-i', shot2, '-filter_complex', fc, '-map', '[v]', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', out]);
  const rep = { id: cs.id, cutStart: cs0, cutEnd: ce, morphFrames: ce - cs0 - 1, transform: { txPx: +(P.tx * 4).toFixed(1), tyPx: +(P.ty * 4).toFixed(1), rot: +P.rot.toFixed(2), s: +P.s.toFixed(4) } };
  await writeFile(path.join(dir, `${cs.id}-splice.json`), JSON.stringify(rep, null, 2) + '\n');
  console.log(`${cs.id}: morph ${rep.morphFrames}f (gen ${cs0}->${ce}), tx=${rep.transform.txPx} ty=${rep.transform.tyPx} s=${rep.transform.s}`);
}
