---
name: targeted-edit-author
description: Inject a specific key pose into an existing talking (lip-synced) shot at a chosen moment, while keeping the original dialogue lip-sync, via a single MuAPI Seedance pass. Use for "keyframe-edit" / targeted pose-edit tasks — change one beat of a finished shot (a gesture, reaction, or pose at a point in time) without re-animating or losing the voice track. Covers prompt structure, keyframe layout, the centered-trim recipe, pose prep, and the measured do's/don'ts.
---

# Targeted Edit Author

Edit ONE beat of an existing talking shot: drop a specific character pose in at a chosen
timestamp (usually the middle) while preserving the shot's original dialogue + lip-sync. One
Seedance 2.5 generation, driven by keyframe reference images + the original speech as a video
reference. This is NOT the full shot-author flow — it is a surgical pose edit on a clip that
already exists.

## Why MuAPI, not higgsfield

The combo this needs — multiple keyframe image refs **plus** a speech-ref video in one
`omni_reference` pass — **deterministically trips higgsfield's `nsfw` moderation** (packaging-side,
not the model). The direct **MuAPI** Seedance 2.5 API runs the exact same combo fine. So always run
targeted edits through MuAPI: either `pipeline shot generate … --runner muapi` or the eval client
`scripts/eval/video-editing/keyframe-edit-eval/muapi-seedance.js`. Needs `MUAPI_KEY` + `FAL_KEY`
in the environment (local image/video refs are uploaded to fal storage; MuAPI takes URLs only).
Cost: 480p ≈ **$0.275/s** empirical (higher than the $0.17/s list floor). Query balance at
`GET https://api.muapi.ai/api/v1/account/balance`; a submit over balance returns HTTP 402
`INSUFFICIENT_CREDITS` cleanly (no charge) — run cheapest-first.

## The inputs

1. **Source clip** — the existing shot (gives the keyframe frames + the look to preserve).
2. **speech-ref.mp4** — the blank mid-gray video carrying the original dialogue wav (this is what
   drives lip-sync; it is how the source shot got its lip-sync in the first place).
3. **Key pose still** — the pose to inject, matted onto the shot's gray at the right scale/position
   (see Pose prep).
4. **Keyframe frames** — frames sampled from the source clip to anchor the untouched beats.

## Keyframe layout — fewer is better (measured)

Reference roles are expressed with `@Image1…/@Video1` tags **in the prompt** (MuAPI sends
`images_list`/`videos_list` as separate arrays with no cross-array ordering — the tags do the
mapping). **Pin every keyframe to a specific time in seconds** and the model hits it.

- **3kfA — first / key pose / last** → `@Image1` @ 0s, `@Image2` = pose @ D/2, `@Image3` @ D.
  (images: source-first, pose, source-last.) **Preferred** for a mid-shot pose edit.
- **3kfB — second / key pose / fourth** → `@Image1` @ 0.25D, pose @ 0.5D, `@Image3` @ 0.75D.
- 5kf (0 / .25 / .5=pose / .75 / 1): **dilutes the pose** — the 4 flanking source frames pull the
  model back toward the idle motion, so the injected pose often does not land. Use only when a
  closed-mouth pose needs extra mouth motion kept alive (rare).

**Finding:** 3 keyframes + specific-second timing reliably lands the key pose at its timestamp;
5 keyframes do not. Verified across ai / art / monster shots.

## Prompt structure

Five paragraphs (see `scaffold-muapi-tc.js` / `scaffold-muapi-trim.js` for the exact builder):

1. **Style + design lock** — flat cartoon illustration, the character's design-lock line, "stays
   turned three-quarter-left, matching the reference images".
2. **Speech / lip-sync** — "`@Video1` is the speech/lip-sync source. … saying, "<exact words>"
   Full lip-sync REQUIRED for the ENTIRE N seconds … NEVER stops, holds, or freezes — not even
   while the body reaches the keyframe pose. Take ONLY audio + timing from `@Video1`; take body
   pose, framing and appearance from `@Image1…@Image3`." Quote the dialogue **verbatim** (transcribe
   with `pipeline voice transcribe`).
3. **Framing** — full-body WIDE 3:4, head-to-feet always visible, locked camera, mid-gray bg.
4. **Keyframes** — "pass smoothly THROUGH each at its timestamp, no held freezes: `@Image1` at 0.0s;
   `@Image2` at D/2 s — at this instant the BODY reaches the pose (<poseDesc>). **This keyframe sets
   the BODY and EYES only; the MOUTH ignores the reference image's mouth and keeps lip-syncing to
   `@Video1` without pause**; `@Image3` at D s."
5. **Render style** — bold dark outlines, flat fills, no gradients/3D.

### Mouth vs. pose (measured — don't over-correct)

- **Do NOT write "hold this pose exactly at Ns"** — "pass THROUGH the pose at Ns" avoids a settle.
- **Scope the keyframe to BODY + EYES only** and tell the mouth to ignore the pose still's mouth and
  keep lip-syncing. This keeps the mouth alive through the keyframe.
- **Open-mouthed key poses** agree with lip-sync and are easiest. A **closed-mouth pose** (e.g. a
  deadpan) causes only a brief mouth settle at the keyframe, then lip-sync resumes — it is NOT a
  freeze (verified by per-frame mouth-region motion, not eyeballing a few frames). Prefer open/neutral
  mouths when you can; a closed-mouth pose is acceptable.
- **Evaluate lip-sync by motion over time, not a 3-4 frame montage** — a lip-syncing mouth cycles
  open/closed several times a second, so sparse frames read as "frozen" even when it isn't. Measure
  mouth-region inter-frame diff across the clip, or watch the video.

## Centered-trim recipe (for talking shots longer than the edit needs)

A long clip dilutes a single pose and the speech line can over-fill. Trim a short window
**centered on the edit moment** so the pose sits exactly at the window's midpoint:

- `start = D/2 − win/2`, `win` ≈ 4s. Trim BOTH the source and the speech-ref to `[start, start+win]`
  (frame-accurate re-encode). The pose then sits at `win/2` (dead center).
- **Re-quote the trimmed words** — transcribe the trimmed speech-ref; the line will be mid-sentence
  (words clipped at the ends) — that is expected, quote it as-is.
- Run 3kfA on the trim. `scaffold-muapi-trim.js --shot <name> --win 4` does all of this.

## Pose prep

Matte the pose still onto the SHOT's exact gray, registered to the source character's extent
(head→feet) so scale/position match:

- **Green-screen pose** → `pipeline shot matte --method plate --matte chroma --refine closed-form
  --format png`, then composite the cutout onto the corner-sampled shot gray, scaled/positioned to
  the measured source character band.
- **Already-gray pose still** (shot-sized) → colorkey its own bg gray and recomposite onto the shot
  gray (handles a small gray mismatch).

`scaffold-muapi-batch.js` does both and prepares the kf5 frames; `scaffold-muapi-tc.js` emits the
time-constrained layouts; `scaffold-muapi-trim.js` does the centered-trim 3kfA.

## Procedure

1. Pick the source shot, the edit timestamp, and the key pose (open/neutral mouth preferred).
2. Prep frames + matted pose (`scaffold-muapi-batch.js`), or the centered trim
   (`scaffold-muapi-trim.js`).
3. Build the prompt (quote the exact/ trimmed dialogue; scope the keyframe to body+eyes).
4. Check MuAPI balance; run 3kfA via `muapi-seedance.js` (or `shot generate --runner muapi`),
   cheapest-first if budget is tight.
5. Review: `pipeline review shots --folder <dir> --layout side-by-side` (name files
   `<shot>-vNN.mp4` to group conditions as columns). Judge pose-landing + lip-sync from the VIDEO.

## Gotchas

- `video_edit` mode requires exactly ONE video reference — not usable for keyframes + speech
  together; use `omni_reference`.
- Dedicated lip-sync models (LatentSync/sync.so/MuseTalk) **fail on flat 2D characters**
  (face-detection error) — Seedance itself is the only thing that lip-syncs this art style.
- MuAPI reference count is generous (≤30 images), so there is no `nsfw` ceiling there — the ceiling
  is specific to higgsfield's packaging.
