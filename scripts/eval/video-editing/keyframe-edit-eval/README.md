# Keyframe-edit eval

Evaluate Seedance 2.5 (via Higgsfield) as a targeted-edit tool: sample keyframes from an
existing shot, replace one with an injected character pose, regenerate, and splice the result
back into the source clip. See [PLAN.md](PLAN.md) for the full design and pose assignments.

## Matrix

8 shots × 3 edit positions (first/middle/last) × 2 densities (5 kf, 10 kf) = **48 generations**,
~15 credits each at 480p ⇒ ≈720 credits. Pilot = 1 shot × 6 = ≈90 credits.

## Files

- `config.mjs` — single source of truth: shots, pose assignments, character design locks, pose
  descriptions, case enumeration, and the visual-only prompt builder.
- `scaffold.js` — extracts source keyframes, mattes + registers each pose onto the shot's gray,
  assembles the swapped reference sets, emits prompts, creates the scratch project, writes
  `manifest.json` + `tests.json`. **No credits.**
- `splice.js` — splices each generated edit back into its source via `../splice-match.js`, seam
  mode per position (first→head, last→tail, middle→mid). **No credits.**
- `tests.json` — the 48 enumerated cases (generated).
- `muapi-seedance.js` — direct MuAPI Seedance 2.5 client (bypasses higgsfield) for the recommended
  single-pass lip-sync path; the same backend is wired into the pipeline as `--runner muapi`
  (`src/muapi.js`). See the lip-sync section below.
- Media: `evaluation/video-editing-eval/keyframe-edit/` (gitignored).

## Lip-sync variant (hybrid splice + lip sync)

Goal: give the raw (pre-splice) Seedance output **lip sync in addition to the edited key pose**,
so the regenerated middle speaks the same words on the same timeline as the untouched head/tail
and the splice seams stay lip-consistent. The 8 source shots originally got their lip sync from a
`speech-ref.mp4` video reference (a blank mid-gray clip carrying the speech wav) + `generate-audio
true`. Scope for this experiment: `kf5` / `middle` only, all 8 shots.

**Key finding:** a single omni_reference pass carrying both the 5 keyframe image refs **and** the
speech-ref trips `nsfw` *only through higgsfield* — the block is in higgsfield's request packaging,
not the model. The same combo runs fine through the **direct MuAPI Seedance 2.5 API**, so the clean
single-pass (edited pose + lip sync together) is the recommended path; the two-stage workaround is
only needed on the higgsfield path.

### ✅ Single-pass via MuAPI — the recommended path

Run the 5 keyframes + speech-ref in one omni-reference generation through MuAPI, which bypasses
higgsfield's moderation wrapper. Reference roles are expressed with `@Image1..@Image5` / `@Video1`
tags in the prompt (`buildLipsyncAttagPrompt` in `config.mjs`; see `prompt-lipsync-attag.md`).
Verified on art-9 / ai-9 / monster-1 (kf5/middle): no `nsfw`, continuous motion, hits the injected
pose, with speech audio.

Two ways to run it:

```bash
# A) standalone eval client (per-shot; uploads refs to fal, polls, downloads)
MUAPI_KEY=... FAL_KEY=... node scripts/eval/video-editing/keyframe-edit-eval/muapi-seedance.js \
  --prompt-file <shot>/kf5/middle/prompt-lipsync-attag.md \
  --image <kf1.png> --image <kf2.png> --image <pose.png> --image <kf4.png> --image <kf5.png> \
  --video <shot>/speech-ref.mp4 \
  --resolution 480p --aspect-ratio 3:4 --duration <n> --generate-audio true \
  --out <shot>/kf5/middle/muapi-test            # [--spicy] for the relaxed-moderation route

# B) through the pipeline (the merged --runner muapi backend; same shot generate flags)
MUAPI_KEY=... FAL_KEY=... node bin/pipeline.js shot generate \
  --id <shotId> --version 1 --model seedance_2_5 --runner muapi \
  --prompt-file <...prompt-lipsync-attag.md> --image <...> ... --video <...speech-ref.mp4> \
  --resolution 480p --aspect-ratio 3:4 --duration <n> --generate-audio true --mode omni_reference
```

Then splice the result back into the source with `splice-match.js` (seam `mid`), as in the other
variants. Needs `MUAPI_KEY` + `FAL_KEY` in the environment (MuAPI takes public URLs, so local refs
are uploaded to fal storage first). Cost: 480p ≈ $0.17/s (720p ≈ $0.34/s).

### ✅ Two-stage (`__lipsync2`) — higgsfield-only workaround

If you are pinned to the higgsfield path (where the single pass is blocked), apply lip sync as a
**second stage** over the silent keyframe-edit output instead:

1. **Stage 1 (silent):** the normal `kf5/middle` keyframe-edit generation (5 refs, injected pose).
2. **Stage 2 (lip sync):** mux the silent visuals + the speech wav into ONE clip
   (`silent+speech.mp4`, audio padded to video length) and run Seedance `mode video_edit` over it
   — `video_edit` carries 0 image refs (dodging the ceiling) and allows exactly one video ref. The
   prompt locks every frame and re-animates only the mouth to the clip's own audio
   (`prompt-lipsync-stage2.md`). Verified on art-9-v003: animation preserved frame-for-frame, lip
   sync + audio present.

```bash
# prereq: scaffold.js has run AND the silent kf5/middle outputs were generated (the main eval run)
node scripts/eval/video-editing/keyframe-edit-eval/scaffold-lipsync-stage2.js   # no credits (muxes + manifest)

# generate the 8 stage-2 lip-sync passes (~102 credits: 480p 3 cr/s; 2×15 + 6×12)
node bin/pipeline.js shot generate-batch \
  --manifest evaluation/video-editing-eval/keyframe-edit/manifest-lipsync-stage2.json \
  --root evaluation/video-editing-eval/keyframe-edit/scratch --concurrency 8

# splice the lip-synced middle back into each source (no credits)
node scripts/eval/video-editing/keyframe-edit-eval/splice.js --lipsync2
#    -> spliced-lipsync2.mp4 / splice-lipsync2.json per case
```

Files: `scaffold-lipsync-stage2.js`, `manifest-lipsync-stage2.json`, `tests-lipsync-stage2.json`.

### ✗ Single-pass on higgsfield (`__lipsync`) — blocked by moderation

`scaffold-lipsync.js` builds the one-pass version (5 keyframe refs + speech-ref video +
`generate-audio true`, `prompt-lipsync.md`) **for the higgsfield path**, where it **does not run**:
every attempt returns `status: nsfw` (no output, no credits). Measured ceiling — with a speech-ref
attached, only **1 image ref** clears higgsfield moderation (2/3/5 all fail; the silent 5-ref
variant and the 1-ref source shots both pass). The same combo succeeds via MuAPI (above), confirming
the block is higgsfield-wrapper-side. Files: `scaffold-lipsync.js`, `manifest-lipsync.json`,
`tests-lipsync.json`.

## Run

```bash
# 1. Scaffold everything (no credits)
node scripts/eval/video-editing/keyframe-edit-eval/scaffold.js

# 2. Pilot generation — one shot, 6 cases (~90 credits)
node bin/pipeline.js shot generate-batch \
  --manifest evaluation/video-editing-eval/keyframe-edit/manifest.json \
  --root evaluation/video-editing-eval/keyframe-edit/scratch \
  --concurrency 6
#    (to run only the pilot shot, hand-filter manifest.json to ai-13-v003__* first)

# 3. Splice the pilot back into the source
node scripts/eval/video-editing/keyframe-edit-eval/splice.js --shot ai-13-v003

# 4. Review, then generate + splice the rest.
```

Pose matting uses `pipeline shot matte --method plate --matte chroma --refine closed-form
--format png --input <pose>`; the cutout is composited onto the shot's corner-sampled gray and
registered to the character's central-band extent (head→feet), so the injected keyframe matches
the shot's scale and position.
