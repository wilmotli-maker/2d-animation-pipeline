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
- Media: `evaluation/video-editing-eval/keyframe-edit/` (gitignored).

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
