// Background-only recolor: replace the flat grey background (border-connected region near
// `from`) with `to`, leaving the character untouched even where it is grey. Flood-fills from
// the frame edges so interior character pixels are never recolored. Works on a still or a clip.
import { spawn } from 'node:child_process';

const TOL = 42; // sum-abs RGB distance to count as background

export function cornerRGB(file) {
  return new Promise((res, rej) => {
    const c = spawn('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'format=rgb24,crop=1:1:5:5', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const ch = []; c.stdout.on('data', (d) => ch.push(d));
    c.on('close', () => { const b = Buffer.concat(ch); b.length >= 3 ? res([b[0], b[1], b[2]]) : rej(new Error('no pixel')); });
  });
}
async function dims(file) {
  const o = await new Promise((res) => { const c = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'ignore'] }); let s = ''; c.stdout.on('data', (d) => (s += d)); c.on('close', () => res(s.trim())); });
  const [w, h, rate] = o.split(',');
  const [n, d] = (rate || '24/1').split('/'); return { W: +w, H: +h, fps: d ? +n / +d : +n };
}
function readRaw(file) {
  return new Promise((res, rej) => {
    const c = spawn('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const ch = []; c.stdout.on('data', (d) => ch.push(d)); c.on('error', rej);
    c.on('close', () => res(Buffer.concat(ch)));
  });
}
function writeRaw(buf, W, H, fps, out, isVideo) {
  return new Promise((res, rej) => {
    const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`];
    if (isVideo) args.push('-r', String(fps));
    args.push('-i', '-');
    if (isVideo) args.push('-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p');
    else args.push('-frames:v', '1');
    args.push(out);
    const c = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('error', rej); c.on('close', (code) => (code === 0 ? res() : rej(new Error('encode failed'))));
    c.stdin.write(buf); c.stdin.end();
  });
}
function recolorFrame(buf, off, W, H, from, to) {
  const N = W * H; const bg = new Uint8Array(N); const stack = [];
  const near = (i) => { const p = off + i * 3; return Math.abs(buf[p] - from[0]) + Math.abs(buf[p + 1] - from[1]) + Math.abs(buf[p + 2] - from[2]) < TOL; };
  const seed = (i) => { if (!bg[i] && near(i)) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % W, y = (i / W) | 0;
    if (x > 0) seed(i - 1); if (x < W - 1) seed(i + 1); if (y > 0) seed(i - W); if (y < H - 1) seed(i + W);
  }
  for (let i = 0; i < N; i++) if (bg[i]) { const p = off + i * 3; buf[p] = to[0]; buf[p + 1] = to[1]; buf[p + 2] = to[2]; }
}

export async function recolorBg(inFile, outFile, from, to, { video = false } = {}) {
  const { W, H, fps } = await dims(inFile);
  const buf = await readRaw(inFile);
  const frameBytes = W * H * 3;
  const frames = Math.floor(buf.length / frameBytes);
  for (let f = 0; f < frames; f++) recolorFrame(buf, f * frameBytes, W, H, from, to);
  await writeRaw(buf, W, H, fps, outFile, video);
  return { W, H, fps, frames };
}
