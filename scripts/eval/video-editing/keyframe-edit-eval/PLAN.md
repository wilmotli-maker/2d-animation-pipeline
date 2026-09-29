# Keyframe-edit evaluation plan

Evaluate Seedance 2.5 (via Higgsfield) as a **targeted-edit** tool: sample keyframes from an
existing shot, replace one with an injected character pose, regenerate, and splice the result
back into the source clip so the unedited frames stay pixel-original.

## Completion criterion

A set of prompts, keyframes, and scripts that run the generations + splices automatically to
produce the edited outputs, reusing existing pipeline capabilities (no duplicated generation,
keying, or batch logic).

## Matrix

**8 shots × 3 edit positions (first / middle / last) × 2 sampling densities (5 kf, 10 kf) = 48 generations.**

- Same 3 poses per shot, reused across both densities → **24 pose stills** to prep.
- Cost: **~15 credits / generation** at 480p (confirmed via `higgsfield generate cost`), so
  **≈720 credits** for all 48. Pilot (1 shot × 3 × 2 = 6 gens) ≈ 90 credits. Balance ~4000.
- Resolution 480p, aspect 3:4, `generate_audio false`, `mode omni_reference`.

## Shots (episode 2 candidates, 560×752, mid-gray bg)

| Shot | dur | baseline motion |
|---|---|---|
| ai-13-v003 | 5s | arms thrown up, excited |
| ai-9-v002 | 5s | hand-to-head, surprised |
| ai-4-v013 | 5s | calm talking, arms at sides |
| art-9-v003 | 4s | cheerful, gesturing |
| art-7-v002 | 4s | talking, neutral → surprise |
| art-5-v003 | 4s | subdued neutral |
| monster-1-v006 | 4s | mild talking gestures |
| monster-5-v002 | 4s | mild talking gestures |

Characters: ai = `AI_ALT2`, art = `art`, monster = `MonsterA` (pose sheets under
`elements/characters/<char>/sheets/pose/`).

## Pose assignments (injected edit per position)

Pose stills come from the green-screen emo sheets; the specific panel index within each emo dir
is chosen at build time from the split panels. Chosen to contrast the shot's baseline while
staying in a plausible register.

Pose stills come from the user's `~/Downloads/{ai,art,monster}/` sets. Revision subfolders take
precedence over same-named root poses (`ai/revision2-three-quarters`, `art/revision1`,
`monster/revision1`). **ai uses only three-quarter-left poses** (the revision2-three-quarters set).

| Shot | first | middle | last |
|---|---|---|---|
| ai-13-v003 | depressed | angry | dismissive |
| ai-9-v002 | confident | angrypoint | embarrassed2 |
| ai-4-v013 | shocked | happy2 | sad2 |
| art-9-v003 | sad | holierthanthou | thinking |
| art-7-v002 | angry | fistsraised | skepticalidle |
| art-5-v003 | bragging | armsraised | uppity |
| monster-1-v006 | annoyed | firebreath | thinking |
| monster-5-v002 | enjoying | upset | agreeing |

Pose file resolution: `<char>/<revision>/<prefix>-<name>.png` if present, else `<char>/<prefix>-<name>.png`
(prefix: ai→`ai-2`, art→`art-1`, monster→`monster-1`).

## Pipeline reuse

| Step | Capability |
|---|---|
| Split 3×2 pose grid → panels | `pipeline element split-panels` |
| Green pose → mid-gray composite | `pipeline shot matte` (chroma engine) |
| Run generations in parallel | `pipeline shot generate-batch --manifest` (`mode omni_reference`) |
| Splice + align edit into source | `scripts/eval/video-editing/splice-match.js --align trs` |
| Harness pattern | mirror existing `tests.json` / `scaffold.js` / `run.js` |

New glue only: `scaffold.js` (extract source keyframes, scale each pose still to the shot's
character bbox, assemble the swapped ref sets), a manifest generator, and a `splice.js` wrapper.

## Pose preparation

1. `pipeline shot matte --method plate --matte chroma --refine closed-form --format png --input <pose>`
   → RGBA cutout with the green keyed out (verified clean, no fringe).
2. Composite the cutout onto the shot's exact mid-gray (corner-sampled).
3. Auto-scale/position the pose to the source character's central-band extent (head-top → feet,
   measured from the sampled source frames, excluding laterally-extended arms) so the injected
   keyframe is registered to the shot — avoids the scale/offset conflict seen in earlier spikes.

Pose stills are on green screen; individual named files (not grids), so `split-panels` is not needed.

## Keyframe sampling

N uniform frames across the clip (N = 5 and N = 10), passed as ordered omni_reference `--image`
refs. For each edit, the frame at the target index is swapped for the pose still:
- first → index 0, middle → index ⌊N/2⌋, last → index N−1.

## Prompt template

Visual-only (no speech / lip-sync / audio). Sections: style & mood; **full-body wide-framing
paragraph** (kept Seedance from zooming/cropping feet in earlier spikes); character design-lock;
keyframe paragraph listing the N evenly-spaced frames with the injected pose described at its
index/timestamp; "no audio" tail. One prompt file per (shot, position, density).

## Generation

A generated `generate-batch` manifest (one item per case) driven against a scratch project root
under the eval dir, so nothing touches the real episode project.

## Splice semantics (per position)

- **middle** → keep original head + tail, splice regenerated middle (two seams).
- **first** → new opening, keep original tail (one out-seam).
- **last** → keep original head, new ending (one in-seam).

`splice-match.js` handles the two-seam case; add `--seam head|mid|tail` for the single-seam
positions. All splices use `--align trs` (per-clip fit) since Seedance output is misregistered
and the offset is not constant across clips/prompts.

## Deliverables

`scripts/eval/video-editing/keyframe-edit-eval/`:
- `PLAN.md` (this file)
- `tests.json` — 48 cases (shot, position, density, pose ref, splice seam)
- `scaffold.js` — keyframe extraction + pose prep + ref-set assembly + prompt emission
- `manifest.json` — generated `shot generate-batch` input
- `splice.js` — wrapper over `splice-match.js` per case
- `README.md` — run instructions
- media under gitignored `evaluation/video-editing-eval/keyframe-edit/…`

## Execution order

1. Build scaffold + prep all 24 poses + emit prompts/manifest (no credits).
2. **Pilot:** run 1 shot (3 edits × 2 densities = 6 gens ≈ 90 cr), splice, review.
3. On go-ahead, run remaining 42, splice, build comparison sheets.

## Open risks

- 10-kf timing drift (seen in the multi-keyframe spike) — included for comparison anyway.
- Pose registration to shot bbox is approximate; may need per-shot tuning.
- `shot matte` chroma is designed for video; on stills it may need a single-frame path or a
  fallback. Verify during pose prep.
- Single-seam (first/last) splices are new in `splice-match.js`; verify on the pilot.
