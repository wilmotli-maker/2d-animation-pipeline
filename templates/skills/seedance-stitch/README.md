# Seedance Stitch (from Jordie Shapiro, 7 Oct 2026)

A Claude Code skill that joins two AI video clips (Seedance, Wan, Kling, Veo and so on) into one continuous shot when the end of one doesn't quite meet the start of the next. It finds the best hand-off frames, tries a free digital push-in first, then the WaveSpeed VACE joiner, and only if needed a short Seedance bridge clip with start and end frames. It also cuts a dead stretch out of the middle of one clip and heals the seam, then checks every join.

Made by Jordie Shapiro with Claude. Share freely inside Red Rock.

---

## Amendments for the 2d-animation-pipeline (wilmot.li, 7 Oct 2026)

This copy is vendored into the pipeline at `templates/skills/seedance-stitch/` so it rides
`pipeline sync-skills` into every project's `.claude/skills/`. Jordie's scripts
(`scripts/stitch.py`, `scripts/vace_join.py`) are **unchanged**. Two things were adapted:

1. **Bridge generation now reuses the pipeline's Seedance runner instead of the Magnific connector.**
   Jordie's original generated the start+end-frame bridge through the Magnific connector
   (`video_generate` with `keyframes.start`/`keyframes.end`). This pipeline already has a Seedance
   2.5 runner via **MuAPI** (`src/muapi.js`), so the skill calls that instead — no second
   generation path, no second credit ledger. A new `first_last_frame` mode was added to the MuAPI
   runner (one route in `routeBase()`), so the bridge is just:
   ```
   pipeline shot generate --id stitch-bridge --version 1 --model seedance_2_5 \
     --runner muapi --mode first_last_frame \
     --image JOBDIR/A_out.png --image JOBDIR/B_in.png \
     --prompt-file JOBDIR/bridge_prompt.txt --resolution 480p --duration 4 --root JOBDIR
   ```
   (first `--image` = start frame, second = end frame; billed per second by the MuAPI credit layer,
   ≈ $0.17/s at 480p). See `SKILL.md` step 2.

2. **The WaveSpeed VACE joiner is kept as-is, and your `FAL_KEY` cannot replace the WaveSpeed key.**
   Checked: fal has **no turnkey VACE joiner** — it only hosts the raw `fal-ai/wan-vace-14b`
   v2v/inpainting model. WaveSpeed's joiner is a workflow (overlap frames → gray gap → mask →
   inpaint) packaged into one `videos:[…]` call. To run joining on fal you'd reimplement that
   workflow over `fal-ai/wan-vace-14b/inpainting`, and it inherits fal Wan VACE's fixed
   81-frame @16fps budget. So `vace_join.py` still needs `~/.wavespeed/key`. **Follow-up (not done
   here):** add a fal-backed joiner that reuses `src/muapi.js`'s fal uploader and the pipeline's
   matte/compositing path to build the gap + mask. Until then, if there's no WaveSpeed key, skip
   the joiner and use the free push-in (`stitch.py assemble --reframe`) then the Seedance bridge.

Everything else — prep, the free `--reframe` push-in, `--direct`/`--morph` morph-cuts, retime,
colour-match, detail-handoff, QA strips, and the `ease` command — is Jordie's and spends no credits.

## Install (in this pipeline)

Nothing to copy by hand. The skill lives under `templates/skills/seedance-stitch/`; run
`pipeline sync-skills` in a project to refresh its `.claude/skills/` from the templates. Then say
"stitch these two clips", "heal this cut", "make these one shot", or type `/seedance-stitch`.

## What it needs

- Python 3 with `opencv-python` and `numpy` (`pip3 install opencv-python numpy`), and ffmpeg.
- For the bridge: `MUAPI_KEY` + `FAL_KEY` (the pipeline's existing MuAPI Seedance runner — fal is
  used only to upload the keyframes to public URLs). Bridges are generated at 480p and billed in
  MuAPI USD; the skill says the cost before a second try.
- For the WaveSpeed VACE joiner (optional, preferred when framings differ): a WaveSpeed API key,
  from `WAVESPEED_API_KEY` (the pipeline's `.env` or your shell) **or** `~/.wavespeed/key` as a
  fallback (about $0.20 a join, paid in WaveSpeed cash). Not required — the free push-in and the
  Seedance bridge cover the same job without it. Pipeline-side the key location is resolved by
  `src/wavespeed.js` (`resolveWavespeedKey`); `vace_join.py` mirrors the same order.
