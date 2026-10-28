# Editing pipeline — testing status & next steps

_Session close-out, 2026-10-28._

Companion to [editing-pipeline-regression-tests.md](editing-pipeline-regression-tests.md) (the
corpus + regression-test design). This file is the live status: what landed, what's validated, and
what to do next.

## Where things stand

The keyframe → splice → harmonize editing path was exercised end-to-end on the two **bruce** shots
(`evaluation/video-editing-eval/textpose-bruce/`, gitignored). That shook out four fixes, three of
them now merged to `main`:

| # | Issue | Status |
|---|---|---|
| 1 | Gens too tight — source is full-body, framing hint cropped it | Fixed in harness: pad stills 12%/side + `framing: full-length`. (harness-only) |
| 2 | bruce1 splice mislabeled `head` (window `lo=0.67>0` is a two-sided `mid`) | Fixed in harness: seam derived from window geometry. (harness-only) |
| 3 | Harmonize SAR leak (560×752 displayed as 752×752) + pad-back failing (leg crop + crushed-dark colours) + `keepRaw` | **Merged — PR #177 (`8195427`)** |
| 4 | Dropped `color_range` tag between stages → gen↔source colour step | **Merged — PR #178 (`ae481d8`)** |

Supporting: **PR #179 (`a592acc`)** added `--seed` for fal Seedance 2.5 shot gen (reproducible gens).

### What PR #178 (colour-range) actually does
Pins `color_range=tv` (ffmpeg's current default decode for our untagged sources → **zero pixel
change**, validation-safe) on every libx264 encode in the gen↔source chain, via new
`src/color-range.js`: `trim-media`, `speechclip` (speechref), `splice` (×4), `splice-run` (×3),
`harmonize` (guidance / padded / keepRaw / conform mux); the harmonize stream-copy path's
`h264_metadata` bsf also sets `video_full_range_flag=0`. Frame extraction left on ffmpeg's
tag-aware default (so a genuinely full-range source isn't mis-decoded). Tests: `color-range.test.js`
+ harmonize range assertions — **658 pass**.

Root cause finding (local, no billing): source / gen (`raw.mp4`) / spliced are **all untagged**;
a `YUV→PNG→YUV` roundtrip is level-preserving under either range as long as every stage **agrees**
— the ~10-level gap comes only from **asymmetry** between stages.

### Validated vs not
- **Validated locally:** #3 on bruce2 (full body head-to-feet, no border, SAR 1:1, brightness
  matched conformed 165.7 / raw 165.8 / source 166.6); #4 is zero-pixel-change by construction +
  unit tests.
- **NOT yet validated (needs live fal spend):** that #4 actually *shrinks* the gen↔source colour
  step. See next step 1.

## Next steps

1. **Run the colour-range A/B** (the one open validation). Full runnable spec is in memory
   `color-range-ab-plan` — Arm A = code before `ae481d8` (untagged) vs Arm B = `main` (tagged),
   same source/prompt/keyframes/window/seam/**seed**, measure seam colour step + bg delta + harmonize
   conform magnitude. `--seed` (PR #179) is now merged, so the reproducibility prereq is satisfied —
   just confirm fal actually honours the seed. ~4 billed fal jobs/shot. **Billing guardrail:**
   persist `request_id`, re-poll on error, never re-gen.

2. **Decide where the bruce shots + harness live.** Everything under
   `evaluation/video-editing-eval/textpose-bruce/` is gitignored (binaries). Per the regression-test
   plan, the groundtruth corpus lives outside the tree at `~/Projects/animation-test-corpus/`
   (`GT_CORPUS_DIR`). Decide whether bruce becomes part of that corpus (it's currently harness-only).

3. **Promote the harness lessons into the pipeline** (optional). Fixes #1 and #2 live only in
   `run-bruce.mjs`. If the full-length framing default and the geometry-derived seam should apply to
   all edits, port them into the edit-UI / fal-run path proper (own PR).

4. **Scripted regression suite** (from the regression-test plan, still pending): wire the
   gt-prompts → gt-keyposes → gt-spliced → gt-harmonized corpus into scripted runs that auto-flag
   splice-boundary discontinuities. The seam-step metric from step 1 is the natural flag.

## Pointers

- Regression-test design & corpus: [editing-pipeline-regression-tests.md](editing-pipeline-regression-tests.md)
- A/B plan (runnable, standalone): memory `color-range-ab-plan`
- Colour-range root cause: memory `textpose-untagged-range-colorshift`
- Harness lessons: memory `textpose-bruce-harness`
- fal billing rule: memory `fal-poll-double-billing`
