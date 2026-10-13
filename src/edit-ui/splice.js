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

export function bestPair(O, G, { lo, hi, fps, shift, jMin, jMax, offsetPenalty = OFFSET_PENALTY }) {
  const sh = Math.round(shift * fps);
  const dist = (i, j) => mad(O[i], G[j]) + (i > 0 && j > 0 ? mad(O[i - 1], G[j - 1]) : 0);
  let b = null;
  const [a0, a1] = frameRange(lo, hi, fps);
  for (let i = a0; i <= Math.min(a1, O.length - 1); i++) {
    for (let j = Math.max(1, i - sh, jMin ?? 0); j <= Math.min(i + sh, G.length - 1, jMax ?? Infinity); j++) {
      const d = dist(i, j), score = d + offsetPenalty * Math.abs(i - j) / fps;
      if (!b || score < b.score) b = { i, j, d, score };
    }
  }
  return b;
}

export function findPairs(O, G, { inRange, outRange, fps, shift, offsetPenalty = OFFSET_PENALTY, genInHi, genOutLo } = {}) {
  const jInMax = genInHi !== undefined ? Math.round(genInHi * fps) : undefined;
  const jOutMin = genOutLo !== undefined ? Math.round(genOutLo * fps) : undefined;
  return {
    inPt: bestPair(O, G, { lo: inRange[0], hi: inRange[1], fps, shift, jMax: jInMax, offsetPenalty }),
    outPt: bestPair(O, G, { lo: outRange[0], hi: outRange[1], fps, shift, jMin: jOutMin, offsetPenalty }),
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
