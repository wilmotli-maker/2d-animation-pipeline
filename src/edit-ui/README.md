# Edit UI — targeted gesture/pose edits for talking shots

A local web UI for **surgically editing one beat of an existing talking clip** — swapping a
gesture or pose at a chosen moment — while keeping the original dialogue and lip-sync. It
regenerates just a short window around the edit with Seedance (preserving the voice track), then
splices that window back into the source so the untouched head/tail are bit-for-bit the original.

```bash
pipeline edit-ui [path/to/clip.mp4] [--port 4880] [--workspace <dir>] [--generator <name>]
```

Starts a localhost-only server (default `http://127.0.0.1:4880`) and prints the URL. Pass a clip to
open it directly, or open/upload one in the UI. `Ctrl+C` to stop.

## Workflow

1. **Open a clip.** The source talking shot (the lip-sync you want to keep).
2. **Mark the edit.** Scrub to the moment to change and mark a region / drop a keyframe for the new
   gesture or pose. Optional per-run inputs: a speech reference, auto keyframes, annotation images,
   and the dialogue line.
3. **Generate (phase 1).** For each marked region the generator trims a centered **≥4 s window**
   (padding at source edges), then runs a **full-quality Seedance 2.5 omni edit** at 480p using the
   window's **start/end frames + the speech reference** (plus any pose keyframes) so the mouth keeps
   lip-syncing the original dialogue while the body reaches the new pose. Output lands per-window as
   `windows/<wNN>/out.mp4`.
4. **Splice back (phase 2).** The regenerated window is spliced into the source at the least-visible
   frames: a global translate/rotate/scale alignment, a **boundary-hugging seam search** (keeps the
   whole regenerated window — and its gesture — rather than collapsing onto the pre-gesture frames),
   and a **flow-morph seam join** that eases the cut. The original source audio is laid over the whole
   clip so there is no timbre seam. Output: `runs/<vNNN>/spliced.mp4`.
5. **Review.** The Results list shows each run; **Splice** (re)runs phase 2. Build a shareable
   comparison with `pipeline review shots --folder … ` (see the review-page docs).

Re-run the splice for a finished run from the CLI:

```bash
pipeline edit-ui-splice --id <videoId> --run <vNNN> [--workspace <dir>]
```

## Generation

- Model **`seedance_2_5`**, `mode: omni_reference`, **480p**, `generateAudio: true`, start/end frames
  + speech-ref (+ optional pose image refs). **Full quality — no draft** (HF removed the draft
  endpoint in the `api.higgsfield.ai` migration; it now 404s).
- Requires **`@higgsfield/cli` ≥ 1.2.0** and a signed-in Higgsfield account (`higgsfield auth login`).
  Credits are drawn from that account (≈12 credits per 4 s 480p window).
- The default generator is registered as `seedance-draft` (name kept for the registry; it is now
  full-quality). Override with `--generator <name>` or `PIPELINE_EDIT_GENERATOR`.

## Splicing

- Implemented in [`splice.js`](splice.js) (`spliceClip`) and wired per-window by
  [`splice-run.js`](splice-run.js). The seam search defaults to **small margins at the gen window's
  head/tail** so the edited gesture is never cut (`seamWindows`); explicit ranges still override.
- **Seam joiner** (`morphEngine`): **`flow`** by default — a dense optical-flow morph
  (`python/flow_morph.py`, cv2 via `uv`; `FLOW_MORPH_PYTHON` overrides the interpreter). It warps one
  side's boundary frame into the other (the **source** side, so the generated footage stays pristine)
  and is frame-count-neutral so the audio stays aligned. Set `EDIT_UI_MORPH=minterpolate` to fall back
  to the ffmpeg joiner. A WaveSpeed VACE joiner is available for single-window runs (`.env`-keyed).

## Data & layout

Runs live under the workspace (default `~/.pipeline/edit-ui/<videoId>/`):

```
<videoId>/
  meta.json            # source clip + name
  source.mp4
  runs/<vNNN>/
    manifest.json      # windows: sourceSpan, pad, clipDuration, editCenters, output, status
    windows/<wNN>/     # trim.mp4, first/last.png, prompt.md, out.mp4, splice-src.mp4, …
    spliced.mp4        # final result (phase 2)
```

## Related

- [`docs/recipes/targeted-edit-backend.md`](../../docs/recipes/targeted-edit-backend.md) — the backend
  recipe (window planning, seam modes, the splice/joiner internals).
- `.claude/skills/targeted-edit-author` — authoring guidance for the edit prompts (pose/gesture
  wording, keyframe layout, do's and don'ts).
