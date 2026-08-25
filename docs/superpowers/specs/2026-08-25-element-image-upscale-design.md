# Element / image upscale — design

**Date:** 2026-08-25
**Status:** approved, pre-implementation
**Ships as:** a single confirmed PR (per project convention for pipeline/default-skill changes)

## Goal

Give element sheet images the same "finish at higher resolution" step that
`pipeline shot upscale` gives finished clips. A user generates a sheet at the
model's native size, then upscales it to a delivery resolution with a dedicated
image upscaler — without re-running (and re-paying for) generation.

Mirrors `src/upscale.js` / `pipeline shot upscale` in shape, credit accounting,
and sidecar/logging conventions.

## Command

```
pipeline element upscale --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> \
  [--version <n|latest>] [--model topaz_image|bytedance_image_upscale] \
  [--scale 2|4] [--input <file>] [--root <dir>]
```

- `--type/--name/--sheet/--id` — address a sheet instance dir
  `elements/<type>/<name>/sheets/<sheet>/<id>/`.
- `--version <n>` — upscale `vNNN.png`; default `latest` picks the highest
  existing `vNNN.png`. Missing → error naming the resolved path (no upload),
  mirroring `upscaleShot`'s "no such shot version".
- `--input <file>` — override the resolved source with any image path. Uses the
  flat (whole-image) flow regardless of sheet type, and writes beside `<id>/`.
- `--model` — `topaz_image` (default) or `bytedance_image_upscale`.
- `--scale` — `2` (default) or `4`.

## Models

New table in `src/upscale-image.js`, parallel to `UPSCALE_MODELS`:

```js
export const UPSCALE_IMAGE_MODELS = {
  topaz_image: {
    // Non-generative Topaz. Preserves line weight and paper texture on flat
    // cartoon art (same reasoning as the topaz_video default for clips).
    kind: 'dimensions',                 // needs explicit output_width/height
    defaults: { variant: 'Standard V2' },
    // scalars forwarded when present: variant, denoise, sharpen, faceEnhancement
  },
  bytedance_image_upscale: {
    kind: 'enum',                       // takes a resolution enum, not dims
    scaleToResolution: { 2: '2k', 4: '4k' },
  },
};
export const UPSCALE_IMAGE_DEFAULT_MODEL = 'topaz_image';
```

`topaz_image_generative` is intentionally excluded — it invents detail, which
is wrong for a faithful upscale of a locked character/prop design.

## Sizing

`--scale` is the single knob across both models.

- `topaz_image` (`kind: 'dimensions'`): read the source (or per-panel) image
  dims with `sharp(src).metadata()`, send
  `output_width = round(w*scale)`, `output_height = round(h*scale)`.
- `bytedance_image_upscale` (`kind: 'enum'`): send
  `resolution = scaleToResolution[scale]`; dims are not read or sent.

Invalid `--scale` (not 2 or 4) is rejected before any upload, like an unknown
model or unsupported resolution in `upscaleShot`.

## Flows

### Panel-aware flow — `turnaround`, `pose` (3×2 grid)

1. Obtain the 6 panels for the resolved version. Reuse the existing
   `vNNN/panel-*.png` folder if present; otherwise `splitPanels(source, ...)`
   into a temp/derived dir first.
2. Submit **one upscale job per panel** (6 jobs) through `runBatch` — parallel,
   within the existing cap-8 batch. Each job is sized per that panel's own dims
   (topaz) or the shared enum (bytedance).
3. Download each upscaled panel into `.../<id>/upscaled-<tag>/panel-*.png`.
4. **Reassemble** into the composite `.../<id>/upscaled-<tag>.png` via a new
   `stitchPanels()` (see below).

### Flat flow — `cycles`, and any `--input`

Single whole-image upscale → one job → `.../<id>/upscaled-<tag>.png`
(or beside `--input` file). No split, no stitch.

### `tag`

`tag = "<scale>x-<model>"`, e.g. `upscaled-2x-topaz_image.png`,
`upscaled-4x-bytedance_image_upscale.png`. Scale + model live in the name so
different passes of one sheet coexist rather than overwrite — same rule as
`upscaled-<resolution>.mp4` for shots.

## `stitchPanels()` (new, in `src/split-panels.js`)

Inverse of `splitPanels`. Given 6 panel image paths in grid reading order,
their **target grid-cell dims** (each = original panel dim × `scale`), and a
`sharpImpl`, composite them into one 3×2 image:

- **Normalize each panel to its target cell dims** with `sharp().resize(w,h)`
  before compositing. This makes reassembly model-agnostic: `topaz_image`
  already returns each panel at `dim*scale`, but `bytedance_image_upscale`
  returns a fixed 2k/4k long-side regardless of the panel's source size — the
  resize snaps both back onto a consistent grid so columns/rows align.
- Canvas width = sum of the 3 column target widths; height = sum of the 2 row
  target heights.
- Place each normalized panel at cumulative offsets, `sharp().composite([...])`.
- `sharpImpl` injectable for tests, loaded lazily like `splitPanels`.

The caller computes target cell dims from the source sheet's own panel grid
(`round(colW*scale)` etc.) so stitching never depends on what a given model
chose to return.

Constraints: exactly `COLS*ROWS` (6) panels; every panel readable. A missing or
unreadable panel throws before writing the composite.

## `upscaleImage(root, spec, deps)` (new, in `src/upscale-image.js`)

Same skeleton as `upscaleShot`:

- `deps`: `{ runner, runBatch, downloadTo, splitPanels, stitchPanels, sharpImpl }`
  — all injectable, real defaults imported.
- Resolve task (`resolveActiveTask`), validate model + scale.
- Resolve source version (or `--input`); error with path if absent, no upload.
- Decide flow by sheet type (panel-aware vs flat); `--input` forces flat.
- For each job: `runner.upload(panel|source)` → build `opts`
  (`imageReferences: [mediaId]` + sized params) → `estimateCredits` →
  include in the `runBatch` job list.
- On success: download outputs; for the panel flow, `stitchPanels` the
  composite; write sidecar JSON beside the composite/output.

## Credit accounting

Each panel upscale is a separately billed Higgsfield job, so we log **one
`generations.jsonl` entry per panel job**, each with its own `jobId`, so
`reconcile` still maps 1 log entry ↔ 1 transaction. Fields mirror the shot
upscale entry plus sheet coords:

```
{ sheetType, sheetId, panel, model, scale, jobId, source, sourceMediaId,
  output, kind: 'upscale', credits, creditsSource, task, status }
```

- `recordCreditAttempt(root, { kind: 'element', type, name }, entry)` — already
  routes element entries to the element store; `kind: 'upscale'` distinguishes
  them in logs and in `collectLogEntries` (which already tolerates arbitrary
  `kind` and keys entries by `elementName/sheetType/sheetId`).
- The `stitchPanels` reassembly is a free local op — recorded on the composite
  sidecar (`status: 'generated'`, no `credits`), **not** as a billed attempt.
- Flat flow: a single entry, exactly like the panel flow with one job.

## Failure handling

- **Any panel job fails** → do not write a composite (it would carry a low-res
  hole). The successful panels' files and their logged credit entries are kept;
  the failed panel is logged `status: 'failed'`, `failurePhase: 'generation'`,
  `billedLikely: !!result.id`; the command reports which panel failed and exits
  non-zero. A re-run redoes all panels.
- **Job succeeds, post-processing throws** (download/stitch) → log
  `status: 'failed'`, `failurePhase: 'post_complete'`, `billedLikely: true`,
  then rethrow — same as `upscaleShot`.

## Paths

New helper in `src/paths.js`:

```js
// Composite output of `pipeline element upscale`, beside the sheet version it
// enlarged. tag carries scale+model so passes coexist. The panel-level
// upscales land in the sibling `upscaled-<tag>/` dir.
export function elementUpscalePath(root, type, name, sheet, id, tag) {
  return path.join(sheetInstanceDir(root, type, name, sheet, id), `upscaled-${tag}.png`);
}
```

## CLI

Add `else if (cmd === 'element' && sub === 'upscale')` in `bin/pipeline.js`,
paralleling the `shot upscale` branch: flag parsing/validation, call
`upscaleImage` with `createRunner({ exec: inheritStderrExec })`, print the
composite path + per-panel job ids. Add the usage line to `printHelp`.

## Tests — `test/upscale-image.test.js`

Parallels `test/upscale.test.js`, with fakes for `runner`, `runBatch`,
`downloadTo`, `splitPanels`, `stitchPanels`, `sharpImpl`:

- Panel flow submits 6 jobs, one per panel; topaz sends each panel's computed
  `output_width/height`; bytedance sends the mapped enum.
- `--scale 4` doubles-again the computed dims / maps to `4k`.
- Composite + per-panel files land at `upscaled-<tag>.png` and
  `upscaled-<tag>/panel-*.png`; sidecar carries model/scale/jobIds.
- `cycles` and `--input` take the flat single-job flow (no split/stitch).
- One failed panel → throws, no composite written, failed entry logged with
  `billedLikely`, successful panels retained.
- Unknown model and invalid `--scale` rejected before upload.
- Missing version reports the path without uploading.
- `stitchPanels` unit test: 6 solid-color panels → one image of the summed
  dimensions with panels in the right cells (using a real/tiny sharp or a fake).

## Out of scope

- `topaz_image_generative` and other image models.
- Re-generating downstream prompts/panels from the upscaled sheet.
- Upscaling shot first-frames or arbitrary non-element images beyond `--input`.
