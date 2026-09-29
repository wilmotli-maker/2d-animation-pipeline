# harmonize-eval — can a v2v model "harmonize" a spliced clip?

**Question.** A `transition-pairs/*-aligned.mp4` clip is two different animation
segments spliced A→B and motion-aligned, so the two halves visibly mismatch in
shadows, textures, highlights and line weight. Can a video-to-video editor model
iron that mismatch out into one uniformly-styled 4s shot **without** disturbing
the pose, motion or timing?

Two arms, both driven through existing pipeline functionality:

- **Seedance 2.5** via `bin/pipeline.js shot generate --mode video_edit` (the
  Seedance video-editing mode: exactly one video reference), rooted inside the
  work dir so nothing lands in the real project shot tree. The first frame is
  passed as the appearance reference (`--image`).
- **Aleph 2.0** via the existing `../aleph.js` spike client (`video_to_video`),
  with the first frame supplied as a timed keyframe at t=0.

Both get the same harmonize prompt (keep the performance, unify the look).

## Run it

```bash
cd scripts/eval/video-editing/harmonize-eval

node harmonize.js prep                 # copy default clip + extract ref.png
node harmonize.js run                  # DRY RUN — no credits (verify + aleph --dry-run)
node harmonize.js run --go             # spend credits on both arms
node harmonize.js run --arm seedance --go   # one arm only
node harmonize.js report               # strip.png + compare.mp4
```

`prep --clip <path>` switches to any other `*-aligned.mp4`. `prep --prompt "..."`
overrides the harmonize prompt.

Outputs land in `evaluation/video-editing-eval/harmonize-spike/` (gitignored):
`source.mp4`, `ref.png`, `seedance.mp4`, `aleph.mp4`, `strip.png`, `compare.mp4`.

Default clip: `transition-pairs/art-3-v002__to__art-7-v002/…__v1-aligned.mp4`
(4.04s, 560×752 ≈ 3:4).

## Cost

Rough per-run credit cost (480p, 4s): Seedance 2.5 ≈ 2.0 cr/s ≈ **8 cr**; Aleph
priced separately by Runway. `run` without `--go` spends nothing.
