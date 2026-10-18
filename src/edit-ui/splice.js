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
  // Video only. Audio is not spliced here: the orchestrator muxes the ORIGINAL source audio over
  // the whole clip (the regenerated middle lip-syncs the same dialogue), which avoids the timbre
  // seam that splicing the generated middle's audio produced.
  const maps = ['[v]'];
  const expectedOutputFrames = (keepPre ? spanStart : 0) + segLen + (keepPost ? (origLen - spanEnd - 1) : 0);
  return { filter, expectedOutputFrames, k, maps };
}

// Split the splice into orig/gen segments (same frame math as buildSpliceFilter), so each can be
// rendered to a file and joined with a motion morph at the seams. `retimeTo` is the mid segment's
// target frame count when retiming (so the spliced length == source).
export function segmentPlan({ seam = 'mid', retime = false, inPt, outPt, origLen, genLen }) {
  const a = inPt.i, a2 = inPt.j, b = outPt.i, b2 = outPt.j;
  const genStart = seam === 'head' ? 0 : a2;
  const genEnd = seam === 'tail' ? genLen - 1 : b2;    // inclusive
  const spanStart = seam === 'head' ? 0 : a;
  const spanEnd = seam === 'tail' ? origLen - 1 : b;   // inclusive
  const segs = [];
  if (seam !== 'head') segs.push({ src: 'orig', from: 0, to: spanStart, retimeTo: null });
  segs.push({ src: 'gen', from: genStart, to: genEnd + 1, retimeTo: retime ? (spanEnd - spanStart) : null });
  if (seam !== 'tail') segs.push({ src: 'orig', from: spanEnd + 1, to: origLen, retimeTo: null });
  return segs;
}

// ffmpeg args to render one segment (from orig/gen) to a file, optionally retimed to retimeTo frames.
export function segmentRenderArgs(seg, { orig, gen, fps, out }) {
  const input = seg.src === 'orig' ? orig : gen;
  const vf = [`trim=start_frame=${seg.from}:end_frame=${seg.to}`, 'setpts=PTS-STARTPTS'];
  if (seg.retimeTo && seg.retimeTo !== (seg.to - seg.from)) {
    const k = seg.retimeTo / (seg.to - seg.from);
    vf.push(`setpts=${k.toFixed(4)}*(PTS-STARTPTS)`, `fps=${fps}`);
  }
  return ['-y', '-i', input, '-vf', vf.join(','), '-an', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', out];
}

// filter_complex joining input 0 (left, `leftFrames` frames) and input 1 (right) with an N-frame
// motion-compensated morph (minterpolate) built from left's last frame and right's first frame.
export function morphJoinFilter({ leftFrames, morph, fps }) {
  const N = morph;
  const tgt = Math.max(fps + 1, Math.round(fps * (N + 2) / 2)); // ~N+2 frames across the 1-frame gap
  const filter =
    `[0:v]trim=start_frame=0:end_frame=${leftFrames - 1},setpts=PTS-STARTPTS[a];` +
    `[0:v]trim=start_frame=${leftFrames - 1}:end_frame=${leftFrames},setpts=PTS-STARTPTS,fps=${fps}[la];` +
    `[1:v]trim=start_frame=0:end_frame=1,setpts=PTS-STARTPTS,fps=${fps}[rb];` +
    `[1:v]trim=start_frame=1,setpts=PTS-STARTPTS[b];` +
    `[la][rb]concat=n=2[pair];` +
    `[pair]minterpolate=fps=${tgt}:mi_mode=mci:me_mode=bidir:mc_mode=aobmc:scd=none,` +
    `trim=start_frame=1:end_frame=${N + 1},setpts=PTS-STARTPTS[m];` +
    `[a][m][b]concat=n=3[v]`;
  return { filter, map: '[v]' };
}

// Seam-search windows that HUG the gen clip's boundaries, so the whole gen (and its edited gesture)
// is kept and we only hunt the least-visible cut within a small margin of each boundary. The old
// default searched a wide band around `edit`, and because the seam objective minimizes gen↔source
// difference it collapsed onto the pre-/post-gesture (low-difference) frames — cutting the gesture out.
// in-seam ∈ [windowStart, windowStart+margin] (gen 0..margin); out-seam ∈ [windowEnd-margin, windowEnd]
// (gen genDur-margin..genDur). Endpoints (gen frame 0 and the last frame) are valid rejoin points.
export function seamWindows({ genOffset = 0, genDur, margin = 0.35 }) {
  const m = Math.min(margin, genDur / 2);
  return {
    inRange: [genOffset, genOffset + m],
    outRange: [genOffset + genDur - m, genOffset + genDur],
    genInHi: m,
    genOutLo: genDur - m,
  };
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
import { flowMorphJoin } from './flow-morph.js';

// Pick the flow-morph mode for a seam so the GEN side is left untouched: warp whichever side is the
// source. One-sided-left warps the left clip (source head → gen); one-sided-right warps the right
// clip (gen → source tail); balanced only when neither side is source (shouldn't happen here).
export function flowModeForSeam(leftSrc, rightSrc) {
  if (leftSrc === 'orig') return 'one-sided-left';
  if (rightSrc === 'orig') return 'one-sided-right';
  return 'balanced';
}

// How the morph path joins consecutive segments. 'flow' = dense optical-flow morph (python/cv2,
// default); 'minterpolate' = ffmpeg's block-motion interpolation (fallback, set EDIT_UI_MORPH).
export function resolveMorphEngine(opt) {
  const e = opt || process.env.EDIT_UI_MORPH || 'flow';
  if (e !== 'flow' && e !== 'minterpolate') throw new Error(`unknown morphEngine: ${e}`);
  return e;
}

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
export async function probeHasAudio(file, { ffprobe = defaultFfprobe }) {
  return /audio/.test(await ffprobe(['-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]));
}

export async function spliceClip(opts, deps = {}) {
  const { orig, gen, out, edit, seam = 'mid', blend = 0, retime = false, align = 'trs', fps = 24,
    size = { W: 140, H: 188 }, shift = 0.5, genInHi, genOutLo, genOffset = 0, morph = 0 } = opts;
  const morphEngine = resolveMorphEngine(opts.morphEngine);
  // Injectable so tests can assert the join calls without shelling ffmpeg or python. The flow engine
  // is frame-count-NEUTRAL (output == leftFrames + rightFrames) so the retimed, audio-aligned timeline
  // is preserved; it returns the actual frame count. The minterpolate engine inserts its (near-zero)
  // morph between the two clips and reports no count, so its caller falls back to the old formula.
  const joinSeam = deps.joinSeam || (async ({ left, right, out: jOut, leftFrames, mode }) => {
    if (morphEngine === 'flow') return flowMorphJoin(left, right, { out: jOut, frames: morph, fps, mode });
    const { filter, map } = morphJoinFilter({ leftFrames, morph, fps });
    await ffmpeg(['-y', '-i', left, '-i', right, '-filter_complex', filter, '-map', map, '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', jOut]);
    return { out: jOut };
  });
  const { W, H } = size;
  const ffmpeg = deps.ffmpeg || defaultFfmpeg;
  const ffmpegOut = deps.ffmpegOut || defaultFfmpegOut;
  const ffprobe = deps.ffprobe || defaultFfprobe;
  const decode = deps.decode || ((f) => decodeGrayFrames(f, { fps, W, H, ffmpeg: ffmpegOut }));

  const [O, G] = await Promise.all([decode(orig), decode(gen)]);
  // Default the seam search to hug the gen-window boundaries so the whole gen (and its gesture) is
  // kept (see seamWindows). Explicit opts override. `edit` is no longer used for the default band.
  const genDur = G.length / fps;
  const usingDefaultWindow = !opts.inRange && !opts.outRange;
  const win = seamWindows({ genOffset, genDur, margin: opts.seamMargin ?? 0.35 });
  const inRange = opts.inRange || win.inRange;
  const outRange = opts.outRange || win.outRange;
  // Apply the boundary gen caps only on the default-window path; explicit ranges keep the old
  // "no cap unless the caller asked" behavior.
  const useGenInHi = genInHi ?? (usingDefaultWindow ? win.genInHi : undefined);
  const useGenOutLo = genOutLo ?? (usingDefaultWindow ? win.genOutLo : undefined);
  // Audio: play the ORIGINAL source audio across the whole clip (the regenerated middle lip-syncs
  // the same dialogue), so there is no timbre seam. To keep it aligned 1:1 we retime the middle so
  // the spliced video is exactly the source length. Only the source's audio matters.
  const useAudio = opts.audio ?? (await probeHasAudio(orig, { ffprobe }));
  const useRetime = useAudio ? true : retime;
  const find = { inRange, outRange, fps, shift, genInHi: useGenInHi, genOutLo: useGenOutLo, genOffset };
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

  const commonReport = {
    output: out, seam, align, blendFrames: blend, morph, audio: useAudio, retime: useRetime,
    transform: align === 'none' ? null : { tx: +P.tx.toFixed(3), ty: +P.ty.toFixed(3), rot: +P.rot.toFixed(3), s: +P.s.toFixed(4) },
    inPoint: { origFrame: inPt.i, genFrame: inPt.j }, outPoint: { origFrame: outPt.i, genFrame: outPt.j },
    originalFrames: O.length,
  };

  if (morph > 0) {
    // Render each segment to a file, then join with an N-frame motion morph at each seam, then mux
    // the original audio. Avoids the hard-cut jump without a dissolve's ghosting.
    const segs = segmentPlan({ seam, retime: useRetime, inPt, outPt, origLen: O.length, genLen: G.length });
    const base = out.replace(/\.mp4$/, '');
    const rendered = [];
    for (let i = 0; i < segs.length; i++) {
      const f = `${base}-seg${i}.mp4`;
      await ffmpeg(segmentRenderArgs(segs[i], { orig, gen: genFile, fps, out: f }));
      rendered.push({ file: f, frames: segs[i].retimeTo || (segs[i].to - segs[i].from) });
    }
    let cur = rendered[0];
    const joins = [];
    for (let i = 1; i < rendered.length; i++) {
      const j = `${base}-join${i}.mp4`;
      // Left side's boundary frame comes from segment i-1; right from segment i. Warp the source side.
      const mode = flowModeForSeam(segs[i - 1].src, segs[i].src);
      const r = await joinSeam({ left: cur.file, right: rendered[i].file, out: j, leftFrames: cur.frames, rightFrames: rendered[i].frames, mode });
      // Flow returns the actual (neutral) count; minterpolate reports none, so keep its old formula.
      const frames = r && r.frames != null ? r.frames : (cur.frames - 1) + morph + (rendered[i].frames - 1);
      cur = { file: j, frames };
      joins.push({ mode });
    }
    if (useAudio) await ffmpeg(['-y', '-i', cur.file, '-i', orig, '-map', '0:v', '-map', '1:a?', '-c:v', 'copy', '-c:a', 'aac', '-shortest', out]);
    else await ffmpeg(['-y', '-i', cur.file, '-c', 'copy', out]);
    return { ...commonReport, morphEngine, segments: segs.length, joins, expectedOutputFrames: cur.frames };
  }

  const { filter, expectedOutputFrames } = buildSpliceFilter({ seam, blend, retime: useRetime, inPt, outPt, origLen: O.length, genLen: G.length, fps });
  const renderArgs = ['-y', '-i', orig, '-i', genFile, '-filter_complex', filter, '-map', '[v]'];
  if (useAudio) renderArgs.push('-map', '0:a?');            // original source audio, whole clip
  renderArgs.push('-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p');
  if (useAudio) renderArgs.push('-c:a', 'aac', '-shortest');
  await ffmpeg([...renderArgs, out]);

  return { ...commonReport, expectedOutputFrames };
}
