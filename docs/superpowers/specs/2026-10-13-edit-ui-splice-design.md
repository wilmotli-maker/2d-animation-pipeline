# Edit-UI splice-back (phase 2) — design

## Intent

Phase 1 produced, per marked region, a regenerated 4s+ edit window (`runs/vNNN/windows/wNN/out.mp4`)
plus splice metadata (`sourceSpan`, `pad`, `window`, `editCenters`). Phase 2 puts those windows
**back into the full source clip**, producing one full-length edited video per run, with seams hidden
by the proven frame-matching + global-alignment splicer.

- **Who:** the edit-ui user who has generated a window they like and wants the whole clip with the edit applied.
- **Success:** a manual "Splice into source" action turns a run's window(s) into a full-length `spliced.mp4`
  whose untouched regions are the original footage and whose edited region(s) are the regenerated clip,
  joined at the least-visible frames.
- **Non-goals (this phase):** `retime` on by default, crossfade tuning, re-upscaling the spliced output,
  overlapping windows, auto-splice-after-generate.

Decisions locked in brainstorming: **extract** splice-match's algorithm into a reusable `src/` module
(not shell out); **manual** trigger.

## Context

- The splicer today is `scripts/eval/video-editing/splice-match.js` — a 243-line CLI script, no exports,
  `FPS/W/H` hardcoded (24 / 140×188). It: decodes orig+gen to gray frames, finds best in/out frame pairs
  around an edit (MAD of frame + previous frame, with an offset penalty), optionally fits ONE global
  transform (translate/rotate/scale) by coordinate descent to minimise seam cost, renders the aligned gen
  clip, then composes `orig_head + gen_middle + orig_tail` via an ffmpeg `filter_complex` (hard-cut concat
  or xfade), with seam modes `mid|head|tail`. This design ports that algorithm faithfully.
- Phase-1 window metadata (manifest `windows[]`): `{ name, window:[W0,W1], sourceSpan:[s,e],
  pad:{start,end}, clipDuration, editCenters[], output, status }`. `out.mp4` length = `clipDuration` and
  INCLUDES the pad (frozen head/tail + silence).
- Server (`src/edit-ui/server.js`): `POST /api/generate` → `{jobId}`, job runs in `ctx.jobs`, UI polls
  `GET /api/jobs/:id`. Reveal/runs endpoints exist. `createEditServer` holds `ctx`.
- UI (`src/edit-ui/web/app.js`): Results list renders one row per `render` (`{run, output, status, at}`);
  rows already have Reveal / remove buttons and a `startJob`/poll helper.

## Components

### A. `src/edit-ui/splice.js` — reusable splicer (ported from splice-match.js)

**Pure, exported, unit-tested:**
- `mad(a, b)` — mean absolute difference of two equal-length arrays.
- `warp(src, P, { W, H })` — bilinear global transform `{tx,ty,s,rot}` of a `W×H` gray frame (identity fast-path).
- `bestPair(O, G, { lo, hi, fps, shift, jMin, jMax, offsetPenalty })` — best (i,j) frame pair in orig range.
- `findPairs(O, G, { inRange, outRange, fps, shift, offsetPenalty, genInHi, genOutLo })` → `{ inPt, outPt }`.
- `fitTransform(O, G, { mode, seam, inPt, outPt, W, H, … })` → `{ P, pairs }` (coordinate-descent; `mode`
  in `none|t|tr|trs`). Pure over decoded frame arrays.
- `buildSpliceFilter({ seam, blend, retime, inPt, outPt, origLen, genLen, fps })` → the `filter_complex`
  string (and the expected output frame count). This is the one piece most likely to regress, so it is
  pure and tested for all three seams × {hard-cut, xfade} × {retime on/off}.

**I/O (injected `ffmpeg`, `ffprobe`):**
- `decodeGrayFrames(file, { ffmpeg, fps, W, H })` → `Buffer[]`.
- `probeSize(file, { ffprobe })` → `{ w, h }`; `cornerColor(file, { ffmpeg })` → `0xRRGGBB`.
- `renderAlignedGen(gen, out, P, { ffmpeg, fps, srcSize })`, `renderSplice(orig, gen, out, filter, { ffmpeg })`.

**Orchestrator:** `spliceClip({ orig, gen, out, edit, seam='mid', blend=0, retime=false, align='trs',
fps=24, size={W:140,H:188}, inRange, outRange, shift=0.5, genInHi, genOutLo }, { ffmpeg, ffprobe }) →
report`. Faithful to splice-match: decode → findPairs (+fit if align) → pin absent seam for head/tail →
render aligned gen (if align) → renderSplice → report `{ seam, align, transform, inPoint, outPoint,
output, expectedOutputFrames }`. `fps` generalises the hardcoded 24.

### B. `src/edit-ui/splice-run.js` — map a run's windows → full-length spliced output

`spliceRun(workspace, meta, manifest, { ffmpeg = defaultFfmpeg, ffprobe = defaultFfprobe, splice =
spliceClip } = {}) → { output, windows: [...] }`.

For a run with windows `w` (status `done`, having `output`), sorted by `sourceSpan[0]` **descending**
(right-to-left):
1. **De-pad** `w.output` → `wDir/splice-src.mp4`: trim `[pad.start, clipDuration − pad.end]` so the clip is
   exactly the real footage spanning source `sourceSpan`. (input-side `-ss/-t`, re-encode.)
2. **Whole-clip case** — if the window covers the whole source (`pad.start>0 && pad.end>0`, or
   `sourceSpan` ≈ `[0, duration]`): the de-padded clip *is* the output; no seam matching. Copy it to the
   working output and continue.
3. Otherwise **seam from pad:** `pad.start>0 → 'head'`; `pad.end>0 → 'tail'`; else `'mid'`.
4. `spliceClip({ orig: <current working file>, gen: splice-src.mp4, out: <next working file>, edit:
   editCenters[0] (or sourceSpan midpoint), seam, fps, align:'trs' })`.
5. Chain: the next window (to the left) splices into the file produced by this one. Right-to-left keeps
   each remaining window's original-timeline search ranges valid, because a splice only alters frames at/
   after its own in-seam, and windows are non-overlapping.

Final working file → `runDir/spliced.mp4`. Record `manifest.spliced = { output:'…/spliced.mp4',
windows:[{ name, seam, report }], at }` via `updateRun`. Return `{ output: rel(spliced.mp4), windows }`.
A run with zero usable windows → throw (nothing to splice).

### C. CLI — `pipeline edit-ui-splice`

`pipeline edit-ui-splice --id <videoId> --run <vNNN> [--workspace <dir>]`. Loads the workspace + meta +
run manifest, calls `spliceRun`, prints the spliced path. Validates id/run; clear errors.

### D. Server — `POST /api/splice`

`POST /api/splice { id, run }` → `{ jobId }` (mirrors `/api/generate`): looks up meta + the run manifest,
spawns a `ctx.jobs` job running `spliceRun`, returns 202. The UI polls `GET /api/jobs/:id` for
`{ status, output }`. Validates id/run (`resolveWithin` the runs dir, as `/api/reveal` does). The spliced
file is served through the existing `/api/video`-style workspace file route the result player uses.

### E. UI — "Splice into source" button

On each **done** run row in Results, add a **Splice** button. Click → `POST /api/splice {id, run}`, poll the
job, and on success show the spliced video (reuse `showResult` with the spliced output; mark the render
`spliced:true` so the row reflects it). Disabled while a splice/generate job is running.

## Data flow

Generate (phase 1) → run with `windows[]` → user clicks **Splice** → `POST /api/splice` → `spliceRun`
(de-pad each window, seam-from-pad, `spliceClip` right-to-left) → `runDir/spliced.mp4` + `manifest.spliced`
→ UI shows the full-length edited clip.

## Error handling

- `spliceClip`: if no valid in/out points (`outPt.j <= inPt.j + blend`) → throw with "widen search ranges"
  (as the script does). Propagates to the job as `error`.
- `spliceRun`: a window whose `output` is missing/`status!=='done'` is skipped; if none remain, throw.
- ffmpeg failures propagate (non-zero exit → rejected promise) and surface as the job's error.
- Whole-clip case avoids seam matching entirely (no "no valid points" risk for near-whole-clip windows).

## Testing

- **`splice.js` pure fns (TDD):** `mad`; `warp` identity fast-path + a known translate on a tiny synthetic
  frame; `bestPair`/`findPairs` on hand-built frame arrays where the matching pair is obvious;
  `buildSpliceFilter` for `mid|head|tail` × {blend 0 hard-cut, blend>0 xfade} × {retime off/on} — assert the
  filter graph shape and `expectedOutputFrames`.
- **`spliceRun` (TDD, injected fakes):** `ffmpeg`/`ffprobe` record calls; `splice` fake records its args and
  writes a marker. Assert: de-pad trim args per window; seam-from-pad (`head`/`tail`/`mid`) from pad values;
  whole-clip window short-circuits to de-pad only; two non-overlapping windows splice **right-to-left**
  chaining outputs; `manifest.spliced` recorded; zero-window run throws.
- **CLI/endpoint:** thin — a server test that `POST /api/splice` validates a bad id/run (404) and, with a
  stub `splice` dep, returns a jobId whose job completes with an output; CLI arg-validation smoke.
- Full suite stays green (`node --test`).

## File plan

- New: `src/edit-ui/splice.js`, `src/edit-ui/splice-run.js`, `test/edit-ui-splice.test.js`,
  `test/edit-ui-splice-run.test.js`.
- Modify: `src/edit-ui/server.js` (`/api/splice` + inject `splice` dep into `ctx` for tests),
  `bin/pipeline.js` (`edit-ui-splice` command + help), `src/edit-ui/web/app.js` + `index.html` (Splice
  button + poll + show), `test/edit-ui-server.test.js` (endpoint test).
- Unchanged: windows.js, trim-media.js, trim-prompt.js, trim-generator.js, runview.js, workspace.js, inputs.js.

## Deferred (phase 3+)

- `retime` default-on + crossfade tuning; overlapping-window merge beyond phase-1 planning; re-upscale of
  the spliced clip; auto-splice; sharing the extracted `splice.js` back into the eval scripts (they can
  import it later — out of scope here).
