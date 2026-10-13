# Edit-UI Splice-Back (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual action that splices a run's regenerated edit window(s) back into the full source clip, producing one full-length `spliced.mp4` with seams hidden by frame-matching + global alignment.

**Architecture:** Port `scripts/eval/video-editing/splice-match.js` into a reusable `src/edit-ui/splice.js` (pure matching/transform/filter fns + injected-ffmpeg orchestrator). A `src/edit-ui/splice-run.js` maps a run's phase-1 window metadata (de-pad, seam-from-pad, right-to-left chaining) onto `spliceClip`. Exposed via a CLI command, a `POST /api/splice` endpoint mirroring `/api/generate`, and a Splice button in the Results list.

**Tech Stack:** Node ESM, `node --test`, ffmpeg/ffprobe (shelled, injected for tests), existing edit-ui server/workspace.

**Spec:** [docs/superpowers/specs/2026-10-13-edit-ui-splice-design.md](../specs/2026-10-13-edit-ui-splice-design.md)

## Global Constraints

- Node ESM; no new runtime deps.
- All ffmpeg/ffprobe/decode side effects in `splice.js` and `splice-run.js` are injectable, with real defaults, so tests never shell out.
- Match grid is `W=140, H=188` gray; `fps` is a parameter (generalises splice-match's hardcoded 24) — default 24, real runs pass the source fps.
- Ported numeric constants, verbatim: `OFFSET_PENALTY = 1.5`, `NEIGHBOURS = 3`, `STEP = { tx:3, ty:3, rot:1.5, s:0.02 }`, align modes `{ none:[], t:['tx','ty'], tr:['tx','ty','rot'], trs:['tx','ty','rot','s'] }`, `IDENT = { tx:0, ty:0, s:1, rot:0 }`.
- Defaults: `align:'trs'`, `blend:0` (hard cut), `shift:0.5`s. Seam supplied by caller.
- Manifest writes via `updateRun`; workspace-relative paths use `/`.
- `spliceClip` fails (throw) when `!inPt || !outPt || outPt.j <= inPt.j + blend` (message mentions widening search ranges) — same guard as the script.

## Review Focus

- **A window whose generated clip is a different fps than the source:** decode/render use `fps`; if gen fps ≠ source fps the de-padded clip's frame count drifts from its source span. `spliceRun` must pass the source fps and re-encode the de-pad at that fps so frame indices line up. (Task 4 test asserts the de-pad re-encodes at the source fps.)
- **Edit at frame 0 / last frame (seam head/tail):** the absent seam is pinned to the clip boundary (`inPt={i:0,j:0}` / `outPt={i:O-1,j:G-1}`); `buildSpliceFilter` must emit only the present seam and drop the absent side, and `expectedOutputFrames` must stay ≤ source length. (Task 2 tests head and tail.)
- **A window covering the whole source (both pads > 0):** `spliceRun` must short-circuit to the de-padded clip with NO `spliceClip` call (otherwise seam search runs with no original footage and throws). (Task 4 test.)
- **Two windows right-to-left:** the left window must splice into the *output* of the right window's splice, and its edit/search range (original-timeline) must be unchanged by the right splice. (Task 4 test asserts chaining order + that orig for the left call is the right call's output.)
- **`outPt` not strictly after `inPt`** (degenerate / too-short gen): `spliceClip` throws rather than emitting a bad filter. (Task 3 test.)

---

### Task 1: `splice.js` — frame matching + transform (pure)

**Files:**
- Create: `src/edit-ui/splice.js`
- Test: `test/edit-ui-splice.test.js`

**Interfaces:**
- Produces: `mad(a,b)`, `warp(src,P,{W,H})`, `bestPair(O,G,{lo,hi,fps,shift,jMin,jMax,offsetPenalty})`, `findPairs(O,G,{inRange,outRange,fps,shift,offsetPenalty,genInHi,genOutLo})`, `fitTransform(O,G,{mode,seam,inPt,outPt,W,H,fps,shift,offsetPenalty,inRange,outRange})`. Frames are `Uint8Array|Buffer` length `W*H`.

- [ ] **Step 1: Write failing tests**

```javascript
// test/edit-ui-splice.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mad, warp, findPairs } from '../src/edit-ui/splice.js';

const W = 4, H = 4;
const frame = (fill) => Uint8Array.from({ length: W * H }, () => fill);

test('mad is the mean absolute difference', () => {
  assert.equal(mad(Uint8Array.from([0, 0, 10, 10]), Uint8Array.from([0, 10, 10, 20])), (0 + 10 + 0 + 10) / 4);
});

test('warp returns the same buffer for the identity transform (fast path)', () => {
  const src = frame(50);
  assert.equal(warp(src, { tx: 0, ty: 0, s: 1, rot: 0 }, { W, H }), src);
});

test('warp by a whole-pixel translation shifts content', () => {
  // a single bright pixel at (1,1); translate +1 in x should sample it at (2,1)
  const src = new Uint8Array(W * H); src[1 * W + 1] = 200;
  const out = warp(src, { tx: 1, ty: 0, s: 1, rot: 0 }, { W, H });
  assert.ok(out[1 * W + 2] > 100, 'bright pixel moved one column right');
});

test('findPairs picks the orig/gen frames that match, within the search ranges', () => {
  // 6 frames each; gen[j] equals orig[j] except gen is identical content, so the min-diff
  // pair at each range is i===j. Ranges in seconds at fps=6 -> frames.
  const O = [0, 40, 80, 120, 160, 200].map(frame);
  const G = [0, 40, 80, 120, 160, 200].map(frame);
  const { inPt, outPt } = findPairs(O, G, { inRange: [0, 0.5], outRange: [0.5, 0.9], fps: 6, shift: 0.5, offsetPenalty: 1.5 });
  assert.equal(inPt.i, inPt.j);
  assert.equal(outPt.i, outPt.j);
  assert.ok(outPt.i > inPt.i);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/edit-ui-splice.test.js` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement the pure matching + transform (ported from splice-match.js)**

```javascript
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
    pairs = findPairs(O.map((_, i) => O[i]), G.map((g) => warp(g, P, size)), find);
  }
  return { P, pairs };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test test/edit-ui-splice.test.js` — Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/edit-ui/splice.js test/edit-ui-splice.test.js
git commit -m "feat(edit-ui): splice frame-matching + transform (pure, ported)"
```

---

### Task 2: `buildSpliceFilter` (pure)

**Files:**
- Modify: `src/edit-ui/splice.js`
- Test: `test/edit-ui-splice.test.js`

**Interfaces:**
- Produces: `buildSpliceFilter({ seam, blend, retime, inPt, outPt, origLen, genLen, fps }) → { filter, expectedOutputFrames, k }`.

- [ ] **Step 1: Write failing tests**

```javascript
// append to test/edit-ui-splice.test.js
import { buildSpliceFilter } from '../src/edit-ui/splice.js';

const pts = { inPt: { i: 24, j: 24 }, outPt: { i: 72, j: 72 } };

test('mid hard-cut keeps both original sides and concats three segments', () => {
  const { filter, expectedOutputFrames } = buildSpliceFilter({ seam: 'mid', blend: 0, retime: false, ...pts, origLen: 96, genLen: 96, fps: 24 });
  assert.match(filter, /concat=n=3:v=1:a=0/);
  assert.match(filter, /trim=end_frame=24/);          // orig head up to in-seam
  assert.match(filter, /trim=start_frame=73/);        // orig tail after out-seam (spanEnd+1)
  assert.equal(expectedOutputFrames, 24 + (72 - 24) + (96 - 72 - 1)); // head + gen seg + tail
});

test('head seam drops the original head (one out-seam) and keeps the tail', () => {
  const { filter } = buildSpliceFilter({ seam: 'head', blend: 0, retime: false, ...pts, origLen: 96, genLen: 96, fps: 24 });
  assert.match(filter, /concat=n=2:v=1:a=0/);
  assert.doesNotMatch(filter, /\[s1\]/);              // no original head segment
});

test('tail seam keeps the original head and drops the tail', () => {
  const { filter } = buildSpliceFilter({ seam: 'tail', blend: 0, retime: false, ...pts, origLen: 96, genLen: 96, fps: 24 });
  assert.match(filter, /concat=n=2:v=1:a=0/);
  assert.doesNotMatch(filter, /\[s3\]/);              // no original tail segment
});

test('a positive blend produces an xfade graph for a mid edit', () => {
  const { filter } = buildSpliceFilter({ seam: 'mid', blend: 4, retime: false, ...pts, origLen: 96, genLen: 96, fps: 24 });
  assert.match(filter, /xfade=transition=fade/);
});

test('retime stretches the gen segment to the original span length', () => {
  const { k } = buildSpliceFilter({ seam: 'mid', blend: 0, retime: true, inPt: { i: 24, j: 20 }, outPt: { i: 72, j: 60 }, origLen: 96, genLen: 96, fps: 24 });
  assert.ok(Math.abs(k - (72 - 24) / (60 - 20)) < 1e-9);
});
```

- [ ] **Step 2: Run** `node --test test/edit-ui-splice.test.js` — Expected: FAIL (`buildSpliceFilter` undefined).

- [ ] **Step 3: Implement (ported from splice-match.js lines 197–228, 240)**

```javascript
// add to src/edit-ui/splice.js
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
```

- [ ] **Step 4: Run** `node --test test/edit-ui-splice.test.js` — Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/edit-ui/splice.js test/edit-ui-splice.test.js
git commit -m "feat(edit-ui): splice filter_complex builder (pure, ported)"
```

---

### Task 3: `spliceClip` orchestrator + I/O helpers

**Files:**
- Modify: `src/edit-ui/splice.js`
- Test: `test/edit-ui-splice.test.js`

**Interfaces:**
- Produces: `decodeGrayFrames`, `probeSize`, `cornerColor`, `renderAlignedGen`, `renderSplice` (injected-ffmpeg I/O), and `spliceClip({ orig, gen, out, edit, seam, blend, retime, align, fps, size, inRange, outRange, shift, genInHi, genOutLo }, { ffmpeg, ffprobe, decode }) → report`.
- Consumes: Task 1/2 pure fns.

- [ ] **Step 1: Write failing tests (injected fakes; no ffmpeg)**

```javascript
// append to test/edit-ui-splice.test.js
import { spliceClip } from '../src/edit-ui/splice.js';

const W2 = 4, H2 = 4;
const gray = (v) => Uint8Array.from({ length: W2 * H2 }, () => v);
// orig & gen: 8 identical frames so the obvious pair is i===j.
const FR = [0, 30, 60, 90, 120, 150, 180, 210].map(gray);

function fakeDeps() {
  const calls = [];
  return {
    calls,
    ffmpeg: async (args) => { calls.push(args); },
    ffprobe: async () => '560,752',
    decode: async () => FR,
  };
}

test('spliceClip finds pairs and renders a splice (align none)', async () => {
  const d = fakeDeps();
  const rep = await spliceClip({ orig: 'o.mp4', gen: 'g.mp4', out: 'out.mp4', edit: 0.5, seam: 'mid',
    align: 'none', fps: 8, size: { W: W2, H: H2 }, inRange: [0.1, 0.5], outRange: [0.5, 0.9] }, d);
  assert.ok(rep.inPoint && rep.outPoint);
  assert.ok(rep.outPoint.genFrame > rep.inPoint.genFrame);
  // the last ffmpeg call renders the splice to out.mp4 with a filter_complex
  const last = d.calls.at(-1).join(' ');
  assert.match(last, /filter_complex/);
  assert.match(last, /out\.mp4/);
});

test('spliceClip throws when no valid in/out points (out not after in)', async () => {
  const d = fakeDeps();
  await assert.rejects(() => spliceClip({ orig: 'o.mp4', gen: 'g.mp4', out: 'out.mp4', edit: 0.5, seam: 'mid',
    align: 'none', fps: 8, size: { W: W2, H: H2 }, inRange: [0.5, 0.9], outRange: [0.1, 0.4] }, d), /widen/i);
});
```

- [ ] **Step 2: Run** — Expected: FAIL (`spliceClip` undefined).

- [ ] **Step 3: Implement (ported orchestration + I/O)**

```javascript
// add to src/edit-ui/splice.js
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
    size = { W: 140, H: 188 }, shift = 0.5, genInHi, genOutLo } = opts;
  const { W, H } = size;
  const ffmpeg = deps.ffmpeg || defaultFfmpeg;
  const ffmpegOut = deps.ffmpegOut || defaultFfmpegOut;
  const ffprobe = deps.ffprobe || defaultFfprobe;
  const decode = deps.decode || ((f) => decodeGrayFrames(f, { fps, W, H, ffmpeg: ffmpegOut }));
  const inRange = opts.inRange || [edit - 1.7, edit - 0.5];
  const outRange = opts.outRange || [edit + 0.5, edit + 1.8];

  const [O, G] = await Promise.all([decode(orig), decode(gen)]);
  const find = { inRange, outRange, fps, shift, genInHi, genOutLo };
  const { P, pairs } = fitTransform(O, G, { mode: align, seam, W, H, ...find });
  let { inPt, outPt } = pairs;
  if (seam === 'head') inPt = { i: 0, j: 0, d: 0 };
  if (seam === 'tail') outPt = { i: O.length - 1, j: G.length - 1, d: 0 };
  if (!inPt || !outPt || outPt.j <= inPt.j + blend) throw new Error('no valid in/out points found; widen the search ranges');

  // Render aligned gen (if any), then the splice.
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
```

- [ ] **Step 4: Run** `node --test test/edit-ui-splice.test.js` — Expected: PASS (11 tests). (align 'none' path skips probe/aligned render; the fake still returns frames.)

- [ ] **Step 5: Commit**

```bash
git add src/edit-ui/splice.js test/edit-ui-splice.test.js
git commit -m "feat(edit-ui): spliceClip orchestrator + ffmpeg I/O (ported)"
```

---

### Task 4: `spliceRun` — windows → full-length spliced output

**Files:**
- Create: `src/edit-ui/splice-run.js`
- Test: `test/edit-ui-splice-run.test.js`

**Interfaces:**
- Consumes: `spliceClip` (Task 3), `updateRun`/`videoDirs` (workspace.js).
- Produces: `createSpliceRunner(deps?) → spliceRun(workspace, meta, manifest) → { output, windows }` with injected `ffmpeg`, `ffprobe`, `splice` (defaults to `spliceClip`).

- [ ] **Step 1: Write failing tests (injected fakes)**

```javascript
// test/edit-ui-splice-run.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSpliceRunner } from '../src/edit-ui/splice-run.js';

async function scaffold(fn, windows, { duration = 12, fps = 24 } = {}) {
  const ws = await mkdtemp(path.join(tmpdir(), 'splice-'));
  const id = '0123456789abcdef';
  const runDir = path.join(ws, id, 'runs', 'v001');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(ws, id, 'source.mp4'), 'v');
  for (const w of windows) { await mkdir(path.join(runDir, 'windows', w.name), { recursive: true }); await writeFile(path.join(runDir, 'windows', w.name, 'out.mp4'), 'g'); }
  const manifest = { run: 'v001', kind: 'video', source: { id, file: 'source.mp4', duration, fps }, windows, inputs: [], warnings: [] };
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));
  const spliceCalls = []; const ff = [];
  const runner = createSpliceRunner({
    ffmpeg: async (a) => { ff.push(a); }, ffprobe: async () => '560,752',
    splice: async (o) => { spliceCalls.push(o); await writeFile(o.out, 's'); return { output: o.out, seam: o.seam }; },
  });
  const meta = { id, file: 'source.mp4' };
  try { return await fn({ ws, runDir, runner, meta, manifest, spliceCalls, ff }); } finally { await rm(ws, { recursive: true, force: true }); }
}

const win = (name, s, e, pad, editCenter) => ({ name, window: [s - pad.start, e + pad.end], sourceSpan: [s, e], pad, clipDuration: (e + pad.end) - (s - pad.start), editCenters: [editCenter], status: 'done', output: `0123456789abcdef/runs/v001/windows/${name}/out.mp4` });

test('a single interior window de-pads and splices with seam mid', async () => {
  await scaffold(async ({ runner, meta, manifest, runDir, spliceCalls, ff }) => {
    const res = await runner(path.dirname(path.dirname(path.dirname(runDir))), meta, manifest);
    assert.equal(spliceCalls.length, 1);
    assert.equal(spliceCalls[0].seam, 'mid');
    assert.equal(spliceCalls[0].edit, 6);
    assert.ok(ff.some((a) => a.join(' ').includes('splice-src.mp4')), 'de-pad ffmpeg ran');
    assert.match(res.output, /spliced\.mp4$/);
    const m = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
    assert.ok(m.spliced && m.spliced.output);
  }, [win('w01', 4, 8, { start: 0, end: 0 }, 6)]);
});

test('seam comes from pad: head when pad.start>0, tail when pad.end>0', async () => {
  await scaffold(async ({ runner, meta, manifest, runDir, spliceCalls }) => {
    await runner(path.dirname(path.dirname(path.dirname(runDir))), meta, manifest);
    assert.deepEqual(spliceCalls.map((c) => c.seam), ['tail', 'head']); // right-to-left: w02 (tail) first
  }, [win('w01', 0, 3, { start: 1, end: 0 }, 1), win('w02', 9, 12, { start: 0, end: 1 }, 11)]);
});

test('a window covering the whole source short-circuits to de-pad (no splice call)', async () => {
  await scaffold(async ({ runner, meta, manifest, spliceCalls, ff }) => {
    await runner(manifest.__ws, meta, manifest); // ws passed via closure below
  }, [win('w01', 0, 12, { start: 1, end: 1 }, 6)]).catch(() => {});
  // Re-run with explicit ws capture for the assertion:
  await scaffold(async ({ ws, runner, meta, manifest, spliceCalls }) => {
    await runner(ws, meta, manifest);
    assert.equal(spliceCalls.length, 0, 'no seam matching for a whole-clip window');
  }, [win('w01', 0, 12, { start: 1, end: 1 }, 6)]);
});

test('two windows splice right-to-left, the left into the right output', async () => {
  await scaffold(async ({ ws, runner, meta, manifest, spliceCalls }) => {
    await runner(ws, meta, manifest);
    assert.equal(spliceCalls.length, 2);
    assert.equal(spliceCalls[0].edit, 9);                       // right window first
    assert.equal(spliceCalls[1].edit, 3);                       // then left
    assert.equal(spliceCalls[1].orig, spliceCalls[0].out);      // left splices into right's output
  }, [win('w01', 1, 5, { start: 0, end: 0 }, 3), win('w02', 7, 11, { start: 0, end: 0 }, 9)]);
});

test('a run with no usable windows throws', async () => {
  await scaffold(async ({ ws, runner, meta, manifest }) => {
    await assert.rejects(() => runner(ws, meta, manifest), /no .*window/i);
  }, [{ name: 'w01', status: 'error', output: null, window: [0, 4], sourceSpan: [0, 4], pad: { start: 0, end: 0 }, clipDuration: 4, editCenters: [2] }]);
});
```

- [ ] **Step 2: Run** `node --test test/edit-ui-splice-run.test.js` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```javascript
// src/edit-ui/splice-run.js
// Map a run's phase-1 edit windows onto spliceClip: de-pad each window's generated clip, pick the
// seam from the pad, and splice right-to-left into the source so each splice leaves the frames that
// windows further left depend on untouched. Produces one full-length runs/vNNN/spliced.mp4.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { updateRun } from './workspace.js';

function defaultFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}: ${err.slice(-300)}`))));
  });
}
const t3 = (n) => Number(n).toFixed(3);

export function createSpliceRunner(deps = {}) {
  return async function spliceRun(workspace, meta, manifest) {
    const ffmpeg = deps.ffmpeg || defaultFfmpeg;
    const ffprobe = deps.ffprobe;
    const splice = deps.splice || (async (o) => { const { spliceClip } = await import('./splice.js'); return spliceClip(o, { ffmpeg, ffprobe }); });
    const fps = (manifest.source && manifest.source.fps) || 24;
    const duration = (manifest.source && manifest.source.duration) || 0;
    const runDir = path.join(workspace, meta.id, 'runs', manifest.run);
    const abs = (rel) => path.resolve(workspace, rel);
    const source = path.join(workspace, meta.id, meta.file);

    const usable = (manifest.windows || []).filter((w) => w.status === 'done' && w.output);
    if (!usable.length) throw new Error('no usable edit window to splice');
    const sorted = [...usable].sort((a, b) => b.sourceSpan[0] - a.sourceSpan[0]); // right-to-left

    let working = source;
    const outWindows = [];
    for (let idx = 0; idx < sorted.length; idx++) {
      const w = sorted[idx];
      const wDir = path.join(runDir, 'windows', w.name);
      // de-pad: trim [pad.start, clipDuration - pad.end] at the source fps
      const depadded = path.join(wDir, 'splice-src.mp4');
      const dur = w.clipDuration - w.pad.start - w.pad.end;
      await ffmpeg(['-ss', t3(w.pad.start), '-t', t3(dur), '-i', abs(w.output), '-r', String(fps), '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-y', depadded]);

      const wholeClip = (w.pad.start > 0 && w.pad.end > 0) || (w.sourceSpan[0] <= 0 && w.sourceSpan[1] >= duration);
      const target = sorted.length === 1 ? path.join(runDir, 'spliced.mp4') : path.join(wDir, 'spliced-step.mp4');
      if (wholeClip) {
        await ffmpeg(['-i', depadded, '-c', 'copy', '-y', target]);
        outWindows.push({ name: w.name, seam: 'whole', report: null });
        working = target;
        continue;
      }
      const seam = w.pad.start > 0 ? 'head' : w.pad.end > 0 ? 'tail' : 'mid';
      const edit = (w.editCenters && w.editCenters.length) ? w.editCenters[0] : (w.sourceSpan[0] + w.sourceSpan[1]) / 2;
      const report = await splice({ orig: working, gen: depadded, out: target, edit, seam, fps, align: 'trs' });
      outWindows.push({ name: w.name, seam, report });
      working = target;
    }

    const finalOut = path.join(runDir, 'spliced.mp4');
    if (working !== finalOut) await ffmpeg(['-i', working, '-c', 'copy', '-y', finalOut]);
    const rel = path.relative(workspace, finalOut).split(path.sep).join('/');
    await updateRun(runDir, { spliced: { output: rel, windows: outWindows, at: new Date().toISOString() } });
    return { output: rel, windows: outWindows };
  };
}
```

- [ ] **Step 4: Run** `node --test test/edit-ui-splice-run.test.js` — Expected: PASS (5 tests). Fix the whole-clip test's first (throwaway) block if it interferes; the assertion is in the second block.

- [ ] **Step 5: Commit**

```bash
git add src/edit-ui/splice-run.js test/edit-ui-splice-run.test.js
git commit -m "feat(edit-ui): spliceRun maps windows to a full-length spliced clip"
```

---

### Task 5: CLI `pipeline edit-ui-splice`

**Files:**
- Modify: `bin/pipeline.js`

**Interfaces:**
- Consumes: `createSpliceRunner` (Task 4), edit-ui server exports (`DEFAULT_WORKSPACE`, `readMeta`-equivalent).

- [ ] **Step 1: Add the command (ported pattern from the `edit-ui` block)**

In `bin/pipeline.js`, after the `edit-ui` branch, add:

```javascript
  } else if (cmd === 'edit-ui-splice') {
    const f = parseFlags([sub, ...rest].filter((x) => x != null));
    if (!f.id || !f.run) fail('usage: pipeline edit-ui-splice --id <videoId> --run <vNNN> [--workspace <dir>]');
    const { DEFAULT_WORKSPACE } = await import('../src/edit-ui/server.js');
    const { readMeta, videoDirs } = await import('../src/edit-ui/workspace.js');
    const { createSpliceRunner } = await import('../src/edit-ui/splice-run.js');
    const { readFile } = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const workspace = f.workspace ? nodePath.resolve(f.workspace) : DEFAULT_WORKSPACE;
    const meta = await readMeta(workspace, f.id);
    if (!meta) fail(`edit-ui-splice: unknown video "${f.id}"`);
    const runDir = nodePath.join(videoDirs(workspace, meta.id).runs, f.run);
    let manifest;
    try { manifest = JSON.parse(await readFile(nodePath.join(runDir, 'manifest.json'), 'utf8')); } catch { fail(`edit-ui-splice: unknown run "${f.run}"`); }
    const res = await createSpliceRunner()(workspace, meta, manifest);
    console.log(`spliced: ${nodePath.join(workspace, res.output)}`);
```

(Confirm `readMeta` and `videoDirs` are exported from `workspace.js`; if `readMeta` lives in `server.js`, import it from there. Adjust imports to the real export sites — the test in Task 6 and a manual `node bin/pipeline.js edit-ui-splice` with a bad id both exercise this.)

- [ ] **Step 2: Add help text** — extend the help block with:
`'  pipeline edit-ui-splice --id <videoId> --run <vNNN> [--workspace <dir>]   # splice a run\'s edited window(s) back into the source'`

- [ ] **Step 3: Smoke test**

Run: `node bin/pipeline.js edit-ui-splice` — Expected: usage error (exit non-zero).
Run: `node bin/pipeline.js edit-ui-splice --id nope --run v001` — Expected: `unknown video "nope"`.

- [ ] **Step 4: Commit**

```bash
git add bin/pipeline.js
git commit -m "feat(edit-ui): pipeline edit-ui-splice command"
```

---

### Task 6: Server `POST /api/splice`

**Files:**
- Modify: `src/edit-ui/server.js`
- Test: `test/edit-ui-server.test.js`

**Interfaces:**
- Consumes: `createSpliceRunner`; `ctx.splice` injectable (defaults to `createSpliceRunner()`).

- [ ] **Step 1: Write a failing server test** (mirror the existing generate test; inject a stub splice via `createEditServer({ splice })`)

```javascript
// append to test/edit-ui-server.test.js (follow the file's existing harness/helpers)
test('POST /api/splice validates the run and runs the splice job', async () => {
  await withServer(async ({ base, workspace, id, runWithWindows }) => {
    // 404 for a bad run
    const bad = await post(base, '/api/splice', { id, run: 'vZZZ' });
    assert.equal(bad.status, 404);
    // happy path: stub splice returns an output; poll the job to done
    const r = await post(base, '/api/splice', { id, run: runWithWindows });
    assert.equal(r.status, 202);
    const done = await pollJob(base, r.body.jobId);
    assert.equal(done.status, 'done');
    assert.match(done.output, /spliced\.mp4$/);
  }, { splice: async () => ({ output: `${'x'.repeat(16)}/runs/v001/spliced.mp4` }) });
});
```
*(Adapt helper names to whatever `test/edit-ui-server.test.js` already defines — `withServer`, `post`, `pollJob`, and a fixture that creates a run with a `windows[]` manifest. If no such fixture exists, create the run dir + manifest inline as the generate test does.)*

- [ ] **Step 2: Run** — Expected: FAIL (route missing / 404 on happy path).

- [ ] **Step 3: Implement the route + ctx wiring**

In `createEditServer({ ... })` accept `splice` and put it on `ctx` (default `createSpliceRunner()`), importing `createSpliceRunner` at the top. Add, alongside `/api/generate`:

```javascript
  if (req.method === 'POST' && p === '/api/splice') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const m = await readMeta(workspace, body && body.id);
    if (!m) return sendJson(res, 404, { error: 'unknown video' });
    const base = videoDirs(workspace, m.id);
    const runDir = resolveWithin(base.runs, String(body.run || ''));
    if (!runDir || !(await realWithin(base.dir, runDir))) return sendJson(res, 404, { error: 'unknown run' });
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8')); } catch { return sendJson(res, 404, { error: 'unknown run' }); }
    const jobId = `splice-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    const job = { id: jobId, kind: 'splice', status: 'running', createdAt: new Date().toISOString() };
    ctx.jobs.set(jobId, job);
    ctx.splice(workspace, m, manifest)
      .then((result) => Object.assign(job, { status: 'done', ...result }))
      .catch((err) => Object.assign(job, { status: 'error', error: err.message }));
    return sendJson(res, 202, { jobId });
  }
```

(Confirm `resolveWithin`/`realWithin`/`videoDirs`/`readFile` are already imported in server.js — the reveal route uses them.)

- [ ] **Step 4: Run** `node --test test/edit-ui-server.test.js` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edit-ui/server.js test/edit-ui-server.test.js
git commit -m "feat(edit-ui): POST /api/splice endpoint"
```

---

### Task 7: UI Splice button

**Files:**
- Modify: `src/edit-ui/web/app.js`

- [ ] **Step 1: Add a Splice action to each done run row.** In the Results `forEach` (where Reveal is added), for a row with `r.run && r.status === 'done'`, append a button that POSTs `/api/splice`, polls the job (reuse the existing `startJob`/poll helper or `fetch('/api/jobs/…')` loop), and on success sets the row's `output` to the spliced path, marks `r.spliced = true`, and calls `showResult(r)`. Disable it while any render is `running`.

```javascript
// inside data.renders.forEach(...), after the Reveal button:
(r.run && r.status === 'done') ? el('button', { class: 'x', title: 'Splice this edit back into the full source clip',
  onclick: async (e) => {
    e.stopPropagation();
    r.status = 'splicing'; renderAll();
    try {
      const { jobId } = await (await fetch('/api/splice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ui.id, run: r.run }) })).json();
      let s; do { await new Promise((z) => setTimeout(z, 700)); s = await (await fetch(`/api/jobs/${jobId}`)).json(); } while (s.status === 'running');
      if (s.status === 'done') { r.status = 'done'; r.output = s.output; r.spliced = true; showResult(r); }
      else { r.status = 'done'; alert(`Splice failed: ${s.error || 'unknown'}`); }
    } catch (err) { r.status = 'done'; alert(`Splice failed: ${err.message}`); }
    renderAll();
  } }, 'Splice') : null,
```

Also show `splicing…` in the status span when `r.status === 'splicing'`, and add `spliced` to the status label when `r.spliced` (e.g. append ` · spliced`).

- [ ] **Step 2: Manually verify in the browser** (optional, no automated test for client JS): launch `node bin/pipeline.js edit-ui <clip>`, generate, click Splice, confirm the full-length clip plays. (Document as a manual check; not a gating test.)

- [ ] **Step 3: Commit**

```bash
git add src/edit-ui/web/app.js
git commit -m "feat(edit-ui): Splice-into-source button in Results"
```

---

### Task 8: Full suite + doc note

- [ ] **Step 1: Run** `node --test` — Expected: all pass, 0 fail. Fix regressions in code, not tests.

- [ ] **Step 2: Note splice in the backend recipe** — in `docs/recipes/targeted-edit-backend.md`, update step 5 (splice-back) to say edit-ui now implements it via `src/edit-ui/splice.js` + `splice-run.js` (`pipeline edit-ui-splice` / the Splice button), seam chosen from the window pad, right-to-left for multiple windows.

- [ ] **Step 3: Commit**

```bash
git add docs/recipes/targeted-edit-backend.md
git commit -m "docs(edit-ui): note the splice-back implementation"
```

---

## Notes for the executor

- `splice.js` is a faithful port of `scripts/eval/video-editing/splice-match.js`; keep its numeric constants and the `filter_complex` graph identical (only `FPS`→`fps` param and export structure change). Cross-check the filter against the script before committing Task 2.
- Confirm the real export sites before Task 5/6: `readMeta` (server.js vs workspace.js), `videoDirs`, `resolveWithin`, `realWithin`, `readFile`, `crypto`, `path` — import from wherever they actually live; adjust the snippets.
- Do not modify phase-1 modules (windows/trim-media/trim-prompt/trim-generator/runview).
- The Task 4 whole-clip test has a throwaway first block; keep only the second (assertion) block if the first is awkward — the deliverable is the assertion that a whole-clip window makes zero `spliceClip` calls.
