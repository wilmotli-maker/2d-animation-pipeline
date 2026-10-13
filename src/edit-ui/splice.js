// src/edit-ui/splice.js
// Reusable video splicer, ported from scripts/eval/video-editing/splice-match.js: splice a
// regenerated clip into the original at the least-visible frames around an edit, with an optional
// global transform (translate/rotate/scale) fitted to hide the seams. The matching/transform/filter
// helpers are pure (operate on decoded W*H gray frames); the orchestrator shells ffmpeg (injected).
export const OFFSET_PENALTY = 1.5;   // grey levels per second of orig/gen time offset
export const NEIGHBOURS = 3;         // extra frame pairs each side used to fit the transform
const STEP = { tx: 3, ty: 3, rot: 1.5, s: 0.02 };
const MODES = { none: [], t: ['tx', 'ty'], tr: ['tx', 'ty', 'rot'], trs: ['tx', 'ty', 'rot', 's'] };
export const IDENT = { tx: 0, ty: 0, s: 1, rot: 0 };

export function mad(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

// p_out = c + t + s*R(theta)*(p_in - c); R clockwise on a y-down image (matches ffmpeg rotate).
export function warp(src, P, { W, H }) {
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

const frameRange = (lo, hi, fps) => [Math.max(1, Math.round(lo * fps)), Math.round(hi * fps)];

// `offsetFrames` is the expected orig→gen frame offset: gen frame j corresponds to orig frame
// j + offsetFrames (0 when orig and gen share a timeline, as in the original eval script; for the
// edit-ui case it is sourceSpan.start*fps, since the de-padded gen clip starts at that source time).
export function bestPair(O, G, { lo, hi, fps, shift, jMin, jMax, offsetFrames = 0, offsetPenalty = OFFSET_PENALTY }) {
  const sh = Math.round(shift * fps);
  const dist = (i, j) => mad(O[i], G[j]) + (i > 0 && j > 0 ? mad(O[i - 1], G[j - 1]) : 0);
  let b = null;
  const [a0, a1] = frameRange(lo, hi, fps);
  for (let i = a0; i <= Math.min(a1, O.length - 1); i++) {
    const centre = i - offsetFrames;
    for (let j = Math.max(1, centre - sh, jMin ?? 0); j <= Math.min(centre + sh, G.length - 1, jMax ?? Infinity); j++) {
      const d = dist(i, j), score = d + offsetPenalty * Math.abs(i - j - offsetFrames) / fps;
      if (!b || score < b.score) b = { i, j, d, score };
    }
  }
  return b;
}

export function findPairs(O, G, { inRange, outRange, fps, shift, offsetPenalty = OFFSET_PENALTY, genInHi, genOutLo, genOffset = 0 } = {}) {
  const jInMax = genInHi !== undefined ? Math.round(genInHi * fps) : undefined;
  const jOutMin = genOutLo !== undefined ? Math.round(genOutLo * fps) : undefined;
  const offsetFrames = Math.round((genOffset || 0) * fps);
  return {
    inPt: bestPair(O, G, { lo: inRange[0], hi: inRange[1], fps, shift, jMax: jInMax, offsetFrames, offsetPenalty }),
    outPt: bestPair(O, G, { lo: outRange[0], hi: outRange[1], fps, shift, jMin: jOutMin, offsetFrames, offsetPenalty }),
  };
}

function pairSet({ inPt, outPt }, { seam, origLen, genLen }) {
  const ps = [];
  for (let m = 0; m <= NEIGHBOURS; m++) {
    if (seam !== 'head' && inPt.i - m >= 0 && inPt.j - m >= 0) ps.push([inPt.i - m, inPt.j - m]);
    if (seam !== 'tail' && outPt.i + m < origLen && outPt.j + m < genLen) ps.push([outPt.i + m, outPt.j + m]);
  }
  return ps;
}
function cost(P, ps, O, G, size) {
  const cache = new Map(); let s = 0;
  for (const [i, j] of ps) { if (!cache.has(j)) cache.set(j, warp(G[j], P, size)); s += mad(O[i], cache.get(j)); }
  return s / ps.length;
}
function optimise(P0, ps, active, O, G, size) {
  let P = { ...P0 }, best_ = cost(P, ps, O, G, size);
  for (const f of [1, 0.5, 0.25, 0.125, 0.0625]) {
    for (let improved = true, guard = 0; improved && guard < 30; guard++) {
      improved = false;
      for (const k of active) {
        for (const sign of [1, -1]) {
          const Q = { ...P, [k]: P[k] + sign * STEP[k] * f };
          const c = cost(Q, ps, O, G, size);
          if (c < best_ - 1e-6) { P = Q; best_ = c; improved = true; break; }
        }
      }
    }
  }
  return P;
}

// Build the ffmpeg filter_complex that composes orig_head + gen_middle + orig_tail (ported from
// splice-match.js). Returns { filter, expectedOutputFrames, k }. seam mid=two seams, head=keep tail
// only, tail=keep head only. blend>0 (mid only) crossfades; retime stretches the gen segment.
export function buildSpliceFilter({ seam = 'mid', blend = 0, retime = false, inPt, outPt, origLen, genLen, fps }) {
  const N = blend;
  const t = (f) => (f / fps).toFixed(4);
  const a = inPt.i, a2 = inPt.j, b = outPt.i, b2 = outPt.j;
  const genStart = seam === 'head' ? 0 : a2;
  const genEnd = seam === 'tail' ? genLen - 1 : b2;    // inclusive
  const spanStart = seam === 'head' ? 0 : a;
  const spanEnd = seam === 'tail' ? origLen - 1 : b;   // inclusive
  const k = retime ? (spanEnd - spanStart) / (genEnd - genStart) : 1;
  const segLen = retime ? (spanEnd - spanStart) : (genEnd - genStart);
  const keepPre = seam !== 'head';
  const keepPost = seam !== 'tail';
  const stretch = (start, end, keep) => `[1:v]trim=start_frame=${start}:end_frame=${end},setpts=${k}*(PTS-STARTPTS),fps=${fps}` +
    (retime ? `,trim=end_frame=${keep}` : '') + ',setpts=PTS-STARTPTS';
  let filter;
  if (N > 0 && keepPre && keepPost) {
    filter = `[0:v]trim=end_frame=${spanStart + N},setpts=PTS-STARTPTS,fps=${fps}[s1];` +
      `${stretch(genStart, genEnd + N, segLen + N)}[s2];` +
      `[0:v]trim=start_frame=${spanEnd},setpts=PTS-STARTPTS,fps=${fps}[s3];` +
      `[s1][s2]xfade=transition=fade:duration=${t(N)}:offset=${t(spanStart)}[x1];` +
      `[x1][s3]xfade=transition=fade:duration=${t(N)}:offset=${t(spanStart + segLen)}[v]`;
  } else {
    const parts = [];
    if (keepPre) parts.push(`[0:v]trim=end_frame=${spanStart},setpts=PTS-STARTPTS,fps=${fps}[s1]`);
    parts.push(`${stretch(genStart, genEnd + 1, segLen + 1)}[s2]`);
    if (keepPost) parts.push(`[0:v]trim=start_frame=${spanEnd + 1},setpts=PTS-STARTPTS,fps=${fps}[s3]`);
    const labels = [keepPre ? '[s1]' : '', '[s2]', keepPost ? '[s3]' : ''].join('');
    const n = (keepPre ? 1 : 0) + 1 + (keepPost ? 1 : 0);
    filter = parts.join(';') + `;${labels}concat=n=${n}:v=1:a=0[v]`;
  }
  const expectedOutputFrames = (keepPre ? spanStart : 0) + segLen + (keepPost ? (origLen - spanEnd - 1) : 0);
  return { filter, expectedOutputFrames, k };
}

export function fitTransform(O, G, { mode = 'trs', seam = 'mid', W, H, ...find }) {
  const size = { W, H };
  const active = MODES[mode] || [];
  let P = { ...IDENT };
  let pairs = findPairs(O, G, find);
  if (!active.length) return { P, pairs };
  const origLen = O.length, genLen = G.length;
  for (let it = 0; it < 3; it++) {
    P = optimise(P, pairSet(pairs, { seam, origLen, genLen }), active, O, G, size);
    pairs = findPairs(O, G.map((g) => warp(g, P, size)), find);
  }
  return { P, pairs };
}

// --- I/O (ffmpeg/ffprobe shelled; injectable) + orchestrator ---------------------------------
import { spawn } from 'node:child_process';

function runFf(bin, args, collect) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: ['ignore', collect ? 'pipe' : 'inherit', 'pipe'] });
    const chunks = []; let err = '';
    if (collect) c.stdout.on('data', (x) => chunks.push(x));
    c.stderr.on('data', (x) => { err += x; });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${bin} exit ${code}\n${err.slice(-600)}`))));
  });
}
const defaultFfmpeg = (args) => runFf('ffmpeg', ['-v', 'error', ...args], false);
const defaultFfmpegOut = (args) => runFf('ffmpeg', ['-v', 'error', ...args], true);
const defaultFfprobe = (args) => runFf('ffprobe', ['-v', 'error', ...args], true).then((b) => b.toString().trim());

export async function decodeGrayFrames(file, { fps, W, H, ffmpeg = defaultFfmpegOut }) {
  const buf = await ffmpeg(['-i', file, '-vf', `fps=${fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-']);
  const n = Math.floor(buf.length / (W * H));
  return Array.from({ length: n }, (_, i) => buf.subarray(i * W * H, (i + 1) * W * H));
}
export async function probeSize(file, { ffprobe = defaultFfprobe }) {
  const [w, h] = (await ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])).split(',').map(Number);
  return { w, h };
}

export async function spliceClip(opts, deps = {}) {
  const { orig, gen, out, edit, seam = 'mid', blend = 0, retime = false, align = 'trs', fps = 24,
    size = { W: 140, H: 188 }, shift = 0.5, genInHi, genOutLo, genOffset = 0 } = opts;
  const { W, H } = size;
  const ffmpeg = deps.ffmpeg || defaultFfmpeg;
  const ffmpegOut = deps.ffmpegOut || defaultFfmpegOut;
  const ffprobe = deps.ffprobe || defaultFfprobe;
  const decode = deps.decode || ((f) => decodeGrayFrames(f, { fps, W, H, ffmpeg: ffmpegOut }));
  const inRange = opts.inRange || [edit - 1.7, edit - 0.5];
  const outRange = opts.outRange || [edit + 0.5, edit + 1.8];

  const [O, G] = await Promise.all([decode(orig), decode(gen)]);
  const find = { inRange, outRange, fps, shift, genInHi, genOutLo, genOffset };
  const { P, pairs } = fitTransform(O, G, { mode: align, seam, W, H, ...find });
  let { inPt, outPt } = pairs;
  if (seam === 'head') inPt = { i: 0, j: 0, d: 0 };
  if (seam === 'tail') outPt = { i: O.length - 1, j: G.length - 1, d: 0 };
  if (!inPt || !outPt || outPt.j <= inPt.j + blend) throw new Error('no valid in/out points found; widen the search ranges');

  let genFile = gen;
  if (align !== 'none' && (P.tx || P.ty || P.rot || P.s !== 1)) {
    const { w: W0, h: H0 } = await probeSize(orig, { ffprobe });
    genFile = out.replace(/\.mp4$/, '') + '-gen-aligned.mp4';
    const cbuf = await ffmpegOut(['-i', gen, '-frames:v', '1', '-vf', 'format=rgb24,crop=1:1:5:5', '-f', 'rawvideo', '-']);
    const fill = '0x' + [...cbuf.subarray(0, 3)].map((x) => x.toString(16).padStart(2, '0')).join('');
    const sx = W0 / W, th = (P.rot * Math.PI / 180).toFixed(6);
    await ffmpeg(['-y', '-i', gen, '-filter_complex',
      `[0:v]rotate=${th}:ow=iw:oh=ih:c=${fill},scale=iw*${P.s}:ih*${P.s}:flags=bicubic[g];` +
      `color=c=${fill}:s=${W0}x${H0}:r=${fps}[cv];[cv][g]overlay=x=(W-w)/2+${(P.tx * sx).toFixed(3)}:y=(H-h)/2+${(P.ty * (H0 / H)).toFixed(3)}:shortest=1:format=auto[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', genFile]);
  }

  const { filter, expectedOutputFrames } = buildSpliceFilter({ seam, blend, retime, inPt, outPt, origLen: O.length, genLen: G.length, fps });
  await ffmpeg(['-y', '-i', orig, '-i', genFile, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', out]);

  return {
    output: out, seam, align, blendFrames: blend,
    transform: align === 'none' ? null : { tx: +P.tx.toFixed(3), ty: +P.ty.toFixed(3), rot: +P.rot.toFixed(3), s: +P.s.toFixed(4) },
    inPoint: { origFrame: inPt.i, genFrame: inPt.j }, outPoint: { origFrame: outPt.i, genFrame: outPt.j },
    expectedOutputFrames, originalFrames: O.length,
  };
}
