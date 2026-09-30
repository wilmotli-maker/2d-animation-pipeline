# Masked WAN VACE composite spike — launch runbook

Standalone plan for running spike (a), `mask-composite-spike.js` (merged in PR #94).
Launchable from a fresh session: everything needed is here.

## Goal
Test whether masked WAN VACE + post-gen composite gives **reliable scoped editing**
(spatial region *and* temporal window) where the kept region is bit-accurate and only
the masked region is judged. Contrast with Aleph (prompt-only) and TokenFlow
(appearance-only — see memory `tokenflow-appearance-only`).

## Why the design is what it is (baked-in learnings)
- fal Wan VACE emits a **fixed 81-frame budget**; wrong length → truncate+stretch,
  timeline drifts, even kept regions corrupt (memory `wan-fal-timeline-truncation`).
  → spike resamples source to **exactly 81 frames @ fps=round(81/duration)** and
  pins fal to that fps. Input/output frame-for-frame aligned.
- VACE won't frame-lock kept (black-mask) regions even with aligned timing.
  → spike **composites** VACE output INTO the frame-matched source via the mask as
  alpha (white→VACE, black→source, feather→blend). Kept region identical by
  construction; edit quality judged only inside the mask.
- Mask convention: **WHITE = regenerate, BLACK = keep**.

## Prereqs
- `FAL_KEY` in repo-root `.env` (or exported). **Spends credits** on `--go`.
- `ffmpeg`/`ffprobe` on PATH.
- Source clips in `evaluation/video-editing-eval/sources/`:
  `ai-1-v003.mp4 ai-4-v013.mp4 art-4-v002.mp4 monster-1-v006.mp4`.

## Run (per test)
```bash
S=scripts/eval/video-editing
# 1) prep: resample to 81f + build mask (no credits)
node $S/mask-composite-spike.js prep --src evaluation/video-editing-eval/sources/<clip>.mp4 \
     [--box cx,cy,w,h | --ellipse cx,cy,rx,ry] [--feather 8] [--window s,e]
# 2) dry-run to eyeball the fal request (no credits)
node $S/mask-composite-spike.js run --prompt "<edit instruction>"
# 3) go (spends credits): submits, composites, reports
node $S/mask-composite-spike.js run --prompt "<edit instruction>" --go
```
Default work dir: `evaluation/video-editing-eval/mask-composite-spike/` (gitignored).
Use `--out <dir>` to run multiple tests side by side.
`composite` and `report` are re-runnable standalone.

## Suggested test matrix (from tests.json)
Spatial (box mask on the region):
- `monster-sunglasses` — monster-1-v006.mp4, `--box 0.5,0.32,0.5,0.28`
- `art-hands-2x` — art-4-v002.mp4, `--box 0.5,0.6,0.6,0.5`

Temporal (region OR full-frame + `--window`): this is the case TokenFlow *can't* do.
- `art-crossed-arms` — art-4-v002.mp4, `--window 3.0,4.0` (± around moment 3.5s)
- `ai-fist-hold` — ai-4-v013.mp4, `--box 0.5,0.5,0.5,0.5 --window 1.3,2.4`

Prompts: copy verbatim from `scripts/eval/video-editing/tests.json` (`prompt` field per id).

## Read the result
Per work dir:
- `analyze-composite/` — composite vs src81: SSIM/PSNR + `diff-heatmap.mp4`.
  Expect near-perfect preservation OUTSIDE the mask (hot only inside).
- `analyze-raw/` — raw VACE vs src81: shows the leakage the composite removed.
- `composite.mp4` — the deliverable.

**Judge:** (1) is the edit good INSIDE the mask? (2) composite heatmap cold outside?
If VACE edit is weak, try `--model wan-22-vace-fun-a14b`, a `--negative` prompt, or
`--resolution 720p`. If the target moves out of a static box, the region mask is too
crude — needs SAM-style tracking (out of spike scope).

## Status / links
- Tooling merged: PR #94 (mask-composite-spike.js, tokenflow-spike.js, wan-vace.js, make-mask.js).
- Related memories: `wan-fal-timeline-truncation`, `tokenflow-appearance-only`,
  `keyframe-v2v-spike`, `video-editing-eval-suite`.
- Blocked on: Runway credits not needed here (fal, cheap); just needs `FAL_KEY` + go-ahead.
