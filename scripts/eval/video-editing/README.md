# Video-editing model eval suite

A benchmark for AI **video-editing** models — models that take an existing clip
plus an instruction and return an edited clip. Runway **Aleph** (`aleph2`) is the
first adapter; the layout is model-agnostic so other models file results beside it
on the same tests for direct comparison.

## The matrix

3 categories x 3 characters from **ArtAI episode 2** (`ai` = robot, `art` =
artist, `monster` = dragon). Each test edits a source clip and is scored on
**did it make the intended change while preserving everything else.**

| Category | ai | art | monster |
|---|---|---|---|
| **spatial** (local region) | eyes → blue *(done)* | hands 2× size | add sunglasses |
| **global** (whole frame) | bg → blue screen *(done)* | flat-shaded, no outlines | red → turquoise |
| **temporal** (one beat) | swap embarrassed gesture @6.5s | "original" gesture @3.9s | "my script" point @1.8s |

The single source of truth is [`tests.json`](tests.json). The two `ai` tests were
run during the earlier Aleph spike and migrated in.

## Files

- `tests.json` — suite definition (categories, the 9 tests, source clips, prompts).
- `scaffold.js` — materializes `evaluation/video-editing-eval/<cat>/<id>/` and writes
  a `prompt.md` into each from `tests.json`. Idempotent; never touches media.
- `run.js` — runs pending tests against a model adapter, then analyzes each.
  **Spends credits.**
- `aleph.js` — the Aleph adapter (submit → poll → download). Reads `RUNWAY_API_KEY`
  from `.env`.
- `analyze.js` — builds `compare.mp4`, `diff-heatmap.mp4`, and `summary.json`
  (mean SSIM/PSNR, worst frame) for one result vs its source.
- `crossfade.filter` — ffmpeg graph for the A/B/A crossfade workaround (fake
  temporal control by blending source and edited on a shared timeline).

## Output layout (gitignored media)

```
evaluation/video-editing-eval/<category>/<id>/
  prompt.md                 # from tests.json
  <model>/                  # e.g. aleph2/
    output.mp4 compare.mp4 diff-heatmap.mp4 norm-out.mp4
    summary.json task.json request.json ssim.log psnr.log
```

## Usage

```bash
node scripts/eval/video-editing/scaffold.js            # (re)create folders + prompt.md
node scripts/eval/video-editing/run.js --list          # show pending, spend nothing
node scripts/eval/video-editing/run.js --only art-hands-2x
node scripts/eval/video-editing/run.js --category temporal
node scripts/eval/video-editing/run.js                 # all pending (spends credits)
```

## Cost

Aleph 2.0 bills **28 credits/sec of output** (56-credit/gen minimum), $0.01/credit
≈ $0.28/sec, per output *duration* not resolution. The 7 pending tests at their
current clip lengths run ~**1,500 credits (~$15)** — the two long temporal clips
(`art-2-v015` ~13s, `monster-2-v006` ~14s) dominate. `run.js --list` shows the set
before you spend; `task.json` records the actual `cost.credits` per run.

## Reading results

- **`diff-heatmap.mp4`** is the honest signal — hot = changed, cool = untouched.
  Spatial/temporal tests should be hot only in the intended region/window; global
  tests are hot nearly everywhere by design.
- **`summary.json`** SSIM/PSNR are whole-frame, so a big intended edit lowers them
  too — read them with the heatmap, not alone.
- For temporal tests, also check frames **before** the target beat: if they already
  changed, the model failed to gate the edit in time (Aleph has no audio and gets
  no keyframes here). The crossfade workaround (`crossfade.filter`) is the mitigation.
