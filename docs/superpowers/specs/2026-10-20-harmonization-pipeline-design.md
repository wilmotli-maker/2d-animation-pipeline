# Harmonization in the pipeline — design

**Date:** 2026-10-20
**Status:** approved to build autonomously (user offline; spec below is their request + decisions marked "my call" that a reviewer can veto)

## Intent / why

The edit-ui splice workflow leaves a visible **seam** where a generated window meets
the source (colour step + background mottling — see the `edit-ui-colour-conform`
thread). A two-stage **previz → restyle** harmonization pass removes the seam *by
construction*: it regenerates the whole clip as one continuous Seedance pass, so there
are no head/gen/tail joins left. Validated on v013 (art-1) in the harmonize-spike. The
user judged it "a viable candidate option for removing stitching seams" and asked to:

1. **(PR1)** Add a pipeline call to harmonize any video (two steps, callable as one
   optional pass).
2. **(PR2, separate)** Have the edit-ui run harmonization automatically after splicing:
   show the un-harmonized splice immediately as a clearly-marked **preview**, then
   **replace** it with the harmonized result when ready.

## Goals

- A reusable `pipeline video harmonize` command that takes any video and returns a
  harmonized clip, via previz (neutralise) → restyle (repaint) — both Seedance 2.5
  `video_edit`.
- The edit-ui calls that same capability under the hood to finish an edit (PR2).
- Preview-then-replace UX in the edit-ui so the user sees a result fast and the
  harmonized version supersedes it.

## Non-goals / anti-goals

- Not changing the splice/seam-match work (that stays as the un-harmonized path).
- Not making harmonization the *only* output — the raw splice must remain viewable.
- Not solving the restyle stage's line-quality (rougher outlines / textured fills vs a
  flat 2D source); that's a known, separate limitation.
- A harmonization failure must never fail the edit — the splice result stands.

## PR1 — `pipeline video harmonize`

**Module `src/harmonize.js`** exports `harmonizeVideo(root, spec, deps)` plus the
canonical `PREVIS_PROMPT` / `STYLE_PROMPT` (moved here from the spike's `prompts.mjs`,
which now re-exports them — single source of truth; the `previz-blocking` skill doc
keeps its own verbatim copy).

Flow (mirrors `src/upscale.js`'s runner/runBatch/downloadTo injection):

1. Probe input dims + duration; pick Seedance aspect from dims; duration = rounded input
   length.
2. **Refs** (appearance targets for the restyle): default = the input's **first and last
   frame**, extracted with ffmpeg. `--ref <img>` (repeatable) overrides.
3. **Stage 1 previz:** upload input; `runBatch` one Seedance `seedance_2_5` /
   `video_edit` job with `videoReferences:[input]`, `PREVIS_PROMPT`, no image,
   `generateAudio:false`; download `*.previz.mp4`.
4. **Stage 2 restyle:** upload previz + refs; `runBatch` with
   `videoReferences:[previz]`, `imageReferences:[refs]`, `STYLE_PROMPT`; download.
5. **Mux** the original input's audio onto the restyled clip → `*.harmonized.mp4`.

**CLI:** `pipeline video harmonize --input <file> [--ref <img> ...]
[--resolution 480p|720p] [--out <dir>] [--keep-previz] [--runner higgsfield|muapi]
[--root <dir>]`. Prints the previz + harmonized paths and the two job ids.

**Decisions (my call — reviewer may veto):**
- Default refs = **first + last** frame. The end frame barely changed the restyle in
  testing but is cheap and honours both ends; `--ref` overrides.
- Default resolution **480p** (the draft rate; 720p returns larger dims).
- Output beside the input as `<name>.previz.mp4` + `<name>.harmonized.mp4` + a
  `<name>.harmonized.json` sidecar (model, jobs, params, refs). `--out <dir>` redirects.
- **Audio is muxed** from the input onto the harmonized clip (the restyle is silent).
- Credit-ledger recording is best-effort (wrapped, never fails the run); full per-stage
  ledger accounting is left as a follow-up since the input may not be a shot.
- Two stages run as one command (previz intermediate kept). Not exposing the stages as
  separate subcommands in v1 — the edit-ui wants the whole pass; can split later if
  wanted.

## PR2 — edit-ui auto-harmonize after splice (preview → replace)

In `server.js`'s `runVideoJob`, after the existing auto-splice:

- If a **harmonizer** is configured (new injected dep, like `splice`), set the run
  manifest `harmonize:{status:'running'}` and start `harmonizeVideo` on `spliced.mp4`
  **without awaiting it**. The generate job returns immediately with the spliced output
  plus `harmonizing:true` and a `harmonizeJobId` (a normal `ctx.jobs` entry).
- The harmonize job downloads `runs/vNNN/harmonized.mp4` and updates the manifest
  `harmonize:{status:'done', output, at}` (or `error`). Refs for the restyle = the
  source's first + last frame.
- **Frontend:** when `/api/generate` returns `spliced` + `harmonizeJobId`, the UI shows
  the spliced result labelled **"Preview — harmonizing…"**, polls `/api/jobs/<harmonizeJobId>`,
  and swaps to the harmonized output (clearing the preview label) when it completes; on
  harmonize error it keeps the spliced result and shows a small "harmonization failed"
  note.

**Decisions (my call — reviewer may veto):**
- Harmonization is **on by default** in the edit-ui when a harmonizer is wired (the user
  asked for automatic). It is injectable and defaults to a no-op in tests. **Open for
  the user:** this spends ~2 Seedance gens (~30 cr) per edit — they may want it behind a
  per-session toggle; flagged for review.
- Restyle refs in the UI path = source first + last frame (no manual ref UI in v1).
- Preview/replace is driven by polling the harmonize job id (consistent with how the UI
  already polls generate/splice jobs); no new streaming channel.

## What's left to the builder

- Exact frontend copy/placement of the "Preview — harmonizing…" badge and the swap, in
  `web/index.html` (kept minimal, clearly marked).
- Whether to persist a user preference for auto-harmonize on/off (left off in v1 pending
  the user's call on the credit-cost default).
