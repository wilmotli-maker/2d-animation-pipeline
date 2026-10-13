# Edit-UI trim generator (HF-draft Seedance) — design

## Intent

Wire the `pipeline edit-ui` generator to a real backend. Replace the stub with a
centered-trim targeted-edit workflow that, for each region a user marks, generates a
short edited clip and (in a later phase) splices it back into the source.

- **Who it's for:** the edit-ui user who marks a frame/range or drops an edited keyframe
  and clicks Generate.
- **Success:** Generate produces a real edited clip per edit region (lip-sync preserved),
  written into the run with enough metadata for a later splice-back step. HF draft mode is
  the default backend for all cases.
- **Non-goals (this phase):** splicing the edited windows back into the full source
  (phase 2); annotation-driven regions and annotation image refs (a separate later pass);
  a MuAPI/Aleph backend (draft is the default "until we run into issues").

This design is the integration of the contract in
[docs/recipes/targeted-edit-backend.md](../../recipes/targeted-edit-backend.md) into the
edit-ui generator interface, built on the registry + normalized run view from PR #113.

## Context

- `createEditServer`/`startEditUi` already accept a pluggable `generator` `{ name, run(job) }`.
  `runVideoJob` calls `createRun` → `prepareRunInputs` → `generator.run({ root, videoPath,
  outDir, runDir, run (manifest), jobId, request })`.
- `src/edit-ui/generators.js` is a name→factory registry (`resolveGenerator`, default `stub`).
- `src/edit-ui/runview.js` `readRunView(workspace, manifest, { maxImages })` returns
  `{ prompt, source, audio, speechref, window, images[], dropped[] }` with absolute paths;
  `images[]` is priority-ordered (edited keyframe > annotation frame > auto keyframe;
  strokes excluded) and capped.
- Reusable generation path (no project root needed), proven in
  `scripts/eval/video-editing/keyframe-edit-eval/hf-textpose.js`:
  `createRunner()` (src/cli.js) → `runBatch(runner, [{ ref, model, opts }])` (src/batch.js)
  → `downloadTo(url, path)` (src/download.js). `runner.upload(file)` returns a hosted ref id
  for videos. Draft is enabled with `opts.extraArgs = ['--draft', 'true']` (Higgsfield-only).
- Centered-trim + 3kf prompt grammar is modeled in `scaffold-muapi-trim.js` (eval). The
  edit-ui generator is a generalized, project-free version of that.
- `src/edit-ui/inputs.js` exports `nearestAspect(width, height)`; `src/transcribe.js`
  transcribes a wav (used by edit-ui's `ensureTranscript`).

## Components

### A. `src/edit-ui/windows.js` — pure windowing (no I/O)

`planWindows({ regions, duration, fps, minWindow = 4 })` → `{ windows[] }`.

**Region input** (derived by the generator from the run manifest, not by this module):
`{ kind: 'point'|'range', start, end }` in seconds, where a keyframe or frame-mark is a
`point` (start === end) and a range mark carries both.

**Algorithm:**
1. **Ideal window per region** on a virtual timeline that may be negative or exceed
   `duration`:
   - point at `t`: `[t − minWindow/2, t + minWindow/2]`.
   - range `[s, e]`: `mid = (s + e)/2`; `w = max(minWindow, e − s)`; `[mid − w/2, mid + w/2]`.
2. **Merge** windows sorted by start; union any that overlap **or touch** (`next.start <=
   cur.end`) into one `[W0, W1]`. A merged window keeps the union of its regions' edit
   centers.
3. For each merged `[W0, W1]`:
   - `sourceSpan = [clamp(W0, 0, duration), clamp(W1, 0, duration)]`.
   - `pad = { start: max(0, −W0), end: max(0, W1 − duration) }`.
   - `clipDuration = W1 − W0` (== sourceSpan length + pad.start + pad.end).
   - `editCenters` and each region's offset are measured from `W0` (so a lone point sits at
     the window midpoint, including when padded at an edge).

**Output** per window: `{ window: [W0, W1], sourceSpan: [s, e], pad: { start, end },
clipDuration, editCenters: number[], regions: [...] }`. Deterministic order by `W0`.

**Edge cases:** `clipDuration >= duration` ⇒ `sourceSpan = [0, duration]`, pads fill the
rest. No regions ⇒ no windows (caller decides fallback — see D).

### B. Trim + pad media (in `trim-generator.js`, ffmpeg injected)

For a window, produce under `runDir/windows/wNN/`:
- `trim.mp4` — source `[sourceSpan]` re-encoded frame-accurately (`-crf 14 -pix_fmt
  yuv420p`, `-an`), then **padded**: `pad.start`/`pad.end` seconds of the held first/last
  frame (ffmpeg `tpad=start_duration/stop_duration` with `clone` mode) so total ==
  `clipDuration`.
- `speechref-trim.mp4` — speechref `[sourceSpan]`, padded with **silence** to
  `clipDuration` (`tpad` for video + `apad`/`adelay` for audio, or concat with a generated
  silent segment).
- `first.png` (clip t=0) and `last.png` (clip end) extracted from the padded `trim.mp4` so
  they reflect what the model sees.
- `speech-trim.wav` (mono 16k) → transcribe via injected transcriber → trimmed dialogue
  string.

### C. Prompt assembly (in `trim-generator.js`)

Compose a structural scaffold (adapted from `scaffold-muapi-trim.js`, generalized — no
hardcoded character design strings) that:
- declares `@Video1` as the speech/lip-sync source and the still refs as `@Image1..N`;
- requires continuous full-clip lip-sync to `@Video1`'s audio (body pose from stills, mouth
  never freezes);
- pins each still to a timestamp within the clip: first `@Image1` at `0.0s`, each edited
  keyframe at its offset `(t − W0)` (body+eyes only, mouth keeps lip-syncing), last at
  `clipDuration`;
- quotes the trimmed dialogue verbatim;
- appends the UI's authored prompt text for regions in this window (from the manifest's
  `prompts[]` whose `markId` falls in-window, plus whole-video prompts).

Text-pose case (no edited keyframe in the window): 2 stills (first/last), no middle pin; the
pose comes from the UI prompt text.

Write to `runDir/windows/wNN/prompt.md`.

### D. Generator `src/edit-ui/trim-generator.js` — `{ name: 'seedance-draft', run(job) }`

`createTrimGenerator({ runner, runBatch, download, transcribe, ffmpeg, now } = {})` returns
the generator; all side-effecting deps are injected (defaults wire the real
runner/batch/download/transcribe/ffmpeg) so `run()` is testable without network or GPUs.

`run({ root, videoPath, outDir, runDir, run, jobId, request })`:
1. `view = readRunView(root, run)`; `fps`, `duration` from `run.source`.
2. Build `regions` from the manifest: edited keyframes (`view.images` kind `keyframe:edited`)
   and marks (`request.marks`); **annotations excluded this phase**.
3. `kind === 'keyframe'` single-keyframe job ⇒ one point region at that keyframe.
4. `planWindows(...)`. If no regions ⇒ one whole-clip window `[0, duration]` (text-pose over
   the whole clip), so Generate always does something.
5. For each window: trim+pad (B), pick the edited keyframes whose time ∈ `sourceSpan` as
   pose refs (ordered by time; apply `readRunView`'s image cap across first+poses+last),
   build prompt (C), `runner.upload(speechref-trim)`, submit `runBatch` with
   `opts = { prompt, startImage: first, endImage: last, imageReferences: [poses...],
   videoReferences: [speechId], resolution: '480p', aspectRatio: nearestAspect(w,h),
   duration: clipDuration, generateAudio: true, mode: 'omni_reference',
   extraArgs: ['--draft', 'true'] }`, then `download` the clip to `windows/wNN/out.mp4`.
   A per-window failure is recorded as that window's `status: 'error'` + message; other
   windows still run (mirrors the batch engine's isolation).
6. Fold a `windows[]` array into the manifest via `updateRun`, each entry `{ window,
   sourceSpan, pad, clipDuration, editCenters, keyframeCount, draft: true, prompt:
   'windows/wNN/prompt.md', output: 'windows/wNN/out.mp4' | null, status, note? }`.
7. Return `{ output: <first window's output, workspace-relative>, windows: [...] }` so the
   existing Results UI shows a clip; `stub` is no longer involved.

### E. Registry + CLI

- Register `seedance-draft` in `generators.js`; set `DEFAULT_GENERATOR = 'seedance-draft'`.
  `stub` stays selectable (`--generator stub`). Update help text's `[--generator <...>]`.
- No server changes: the server already forwards `generator`.

## Data flow

UI Generate → `runVideoJob` → `createRun` + `prepareRunInputs` (unchanged) →
`seedance-draft.run()` → `readRunView` + `planWindows` → per window {trim/pad media,
prompt, runner+runBatch, download} → `updateRun(windows[])` → Results UI.

## Error handling

- Generator-level failures (no source, probe missing duration) throw → run marked `error`
  (existing `runVideoJob` catch).
- Per-window failures are isolated and recorded; a run with ≥1 window still returns.
- Transcription failure ⇒ warning + empty dialogue (prompt still generated), matching the
  existing "transcription unavailable" warning convention.
- Draft/runner transient failures (e.g. HF 520 on upload) surface as the window's error
  message; retry is out of scope this phase (noted for later).

## Testing

- **`windows.js`:** pure unit tests (TDD) — single point centering; range width =
  `max(4, span)`; edge extension + pad at start and end with the point still centered;
  merge of overlapping and of touching windows; union of edit centers; whole-clip when
  `clipDuration >= duration`; empty regions.
- **`trim-generator.js`:** `run()` with injected fakes (ffmpeg/transcribe record calls;
  runner/runBatch return canned ids/urls; download writes a marker). Assert: regions →
  windows → one runBatch submission per window with correct `opts` (draft on, 3kf vs 2kf,
  duration = clipDuration, aspect from source); manifest `windows[]` shape incl.
  `sourceSpan`/`pad`; first-window output returned; per-window error isolation.
- **Registry/CLI:** `seedance-draft` resolves and is the default; `--generator stub` still
  works (extend existing tests).
- Full suite stays green (`node --test`).

## File plan

- New: `src/edit-ui/windows.js`, `src/edit-ui/trim-generator.js`,
  `test/edit-ui-windows.test.js`, `test/edit-ui-trim-generator.test.js`.
- Changed: `src/edit-ui/generators.js` (register + default),
  `test/edit-ui-generators.test.js` (default assertion), `bin/pipeline.js` (help text).
- Unchanged: server, workspace, inputs, runview, stub.

## Deferred (phase 2+)

- Splice-back: reinsert each window's `out.mp4` into the full source using `sourceSpan`/`pad`
  (drop synthetic head/tail), via the stitching skill /
  `scripts/eval/video-editing/splice-match.js`.
- Annotation-driven regions and annotation image refs.
- MuAPI/Aleph backends as alternatives to draft.
- Runner retry on transient upload failures; per-window image-cap tuning per model limit.
