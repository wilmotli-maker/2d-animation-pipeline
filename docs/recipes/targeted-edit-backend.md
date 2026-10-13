# Targeted-edit backend — wiring a UI to the pipeline

How a video-editing UI turns "inject a pose/gesture at this moment while keeping the dialogue
lip-sync" into concrete pipeline calls. Companion to the `targeted-edit-author` skill (which has
the prompt grammar + findings); this doc is the integration contract for the generator backend.

Status (2026-10): HF full-quality Seedance is effectively unusable for lip-sync (nsfw ~14/15).
Use **MuAPI** (`--runner muapi`) or **HF draft** (`--draft`). See the skill's "Runner choice".

**`pipeline edit-ui` now implements this workflow** via the default `seedance-draft` generator
(`src/edit-ui/trim-generator.js`): it plans centered, edge-padded, merged edit windows with
`src/edit-ui/windows.js`, trims source + speech-ref per window (`src/edit-ui/trim-media.js`),
builds the prompt (`src/edit-ui/trim-prompt.js`), and runs each window through the HF-draft
Seedance path (`draft: true`, `mode omni_reference`). Splice-back (step 5 below) is deferred to
phase 2; each window records `sourceSpan`/`pad` in the run manifest for it.

## Inputs the UI collects

| Input | Notes |
|---|---|
| Source clip | the existing talking shot to edit |
| Edit time `t` | where the new pose peaks (a mark / keyframe / annotation) |
| Pose | EITHER a pose image (precise) OR a text description (looser, no asset) |
| Dialogue | the shot's speech wav / speech-ref.mp4 (drives lip-sync) |
| Duration/res | default 480p, 3:4; keep the generation short (see trim) |

## Pipeline, step by step

**1. Centered trim** (talking shots longer than the edit needs). Trim source + speech-ref to a
short window centered on `t` so the pose sits at the window midpoint, and re-quote the trimmed
words (`pipeline voice transcribe`). `scaffold-muapi-trim.js --shot <name> --win 4` does the whole
step; or directly:
```
start = t - win/2            # win ≈ 4s
ffmpeg -ss <start> -i source.mp4   -t <win> -an -c:v libx264 -crf 14 -pix_fmt yuv420p trim.mp4
ffmpeg -ss <start> -i speech-ref.mp4 -t <win> -c:v libx264 -pix_fmt yuv420p -c:a aac speech-trim.mp4
# first/last frames: -ss 0 … / -sseof -0.1 …   ;  transcribe speech-trim for the prompt
```

**2. Pose prep** — only for the *keyframe* variant: matte the pose still onto the shot's gray and
register it (green-screen → `pipeline shot matte … --matte chroma`; already-gray → colorkey +
recomposite). The *text* variant skips this entirely.

**3. Build the prompt** — @-tag + specific-second grammar, keyframe scoped to body+eyes so the
mouth keeps lip-syncing. See the skill for the exact builder; `scaffold-muapi-tc.js` /
`scaffold-muapi-trim.js` emit it. Quote the (trimmed) dialogue verbatim.

**4. Generate** — one `pipeline shot generate` call. The shot/draft must exist
(`pipeline shot create` / `shot draft`). Reference frames + speech as below.

- **MuAPI (most reliable, supports full multi-keyframe + speech):**
  ```
  pipeline shot generate --id <shot> --version <n> --model seedance_2_5 --runner muapi \
    --prompt-file <prompt.md> --image <kf1> --image <pose> --image <kf3> \
    --video <speech-trim.mp4> --resolution 480p --aspect-ratio 3:4 --duration <win> \
    --generate-audio true --mode omni_reference        # [--spicy] for relaxed moderation
  ```
  (text variant: drop the pose `--image`, pass just first/last.) `--runner muapi` uploads local
  refs to fal storage automatically; needs `MUAPI_KEY` + `FAL_KEY`.

- **HF draft (cheaper/native, clears the moderation that blocks full HF):** same call, drop
  `--runner muapi`, add **`--draft`**:
  ```
  pipeline shot generate --id <shot> --version <n> --model seedance_2_5 --draft \
    --prompt-file <prompt.md> --image <kf1> --image <pose> --image <kf3> \
    --video <speech-trim.mp4> --resolution 480p --aspect-ratio 3:4 --duration <win> \
    --generate-audio true --mode omni_reference
  ```
  `--draft` is Higgsfield-only (ignored by `--runner muapi`). HF-draft is verified for the
  1-image recipe and start/end + speech; the full 3–5 image_references + speech case under draft
  is not yet confirmed (see the `hf-draft-multiref-test-todo` note).

Batch many edits with `pipeline shot generate-batch --manifest <file.json>` (same flags; each item
may also carry `draft`/`mode`/etc.). `--runner` and `--spicy`/`--draft` apply per command.

**5. Splice back** — put the edited window(s) back into the full source, keeping the original
head/tail and splicing the regenerated middle at the least-visible frames. The untouched head/tail
already carry the original lip-sync, and the regenerated middle speaks the same words on the same
timeline, so seams stay lip-consistent.

`pipeline edit-ui` implements this: `src/edit-ui/splice.js` is a reusable port of
`splice-match.js` (frame-matching + global `trs` alignment + the `filter_complex` builder), and
`src/edit-ui/splice-run.js` maps a run's phase-1 windows onto it — de-padding each window's `out.mp4`,
choosing the **seam from the window's pad** (`pad.start>0 → head`, `pad.end>0 → tail`, else `mid`;
a whole-clip window is just de-padded), and splicing **right-to-left** so earlier edits' frames stay
valid. Trigger it with the **Splice** button in the edit-ui Results list or
`pipeline edit-ui-splice --id <videoId> --run <vNNN>`; output is `runs/vNNN/spliced.mp4` and
`manifest.spliced`. The eval script `scripts/eval/video-editing/splice-match.js --seam mid --retime
--align trs` remains for ad-hoc/eval use.

## Variant cheat-sheet

| | Keyframe pose | Text pose |
|---|---|---|
| Pose input | matted still image | prose description |
| Asset prep | matte + register | none |
| Image refs | 3 (first / pose / last) | 2 (first / last) |
| Precision | exact | looser (gist of the gesture) |
| Best for | a specific, locked pose | quick "do roughly X here" edits |

## Gotchas / caps

- Use `omni_reference` (NOT `video_edit` — that allows exactly one video reference).
- Dedicated lip-sync models (LatentSync/sync.so/MuseTalk) fail on flat 2D characters (face
  detection) — Seedance is the only thing that lip-syncs this art style.
- MuAPI: ≤30 image refs (no ceiling); HF full: nsfw-blocked; HF draft: bypasses.
- Evaluate lip-sync by motion over time / the video, never a few sampled frames.
- Transient HF upload 520s happen — retry the roll.
