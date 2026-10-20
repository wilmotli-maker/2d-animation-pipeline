# Bugs & known issues

A running list of open bugs, blockers, and known gotchas. Add an entry when you file a bug; remove
it when it's fixed.

## Open bugs

- **Edit-UI Run v7 — hitch at the start of the spliced-in clip.** A significant hitch/jump appears
  at the head seam of the spliced output (where the source head rejoins the regenerated window) in
  run `v007`. Deferred; revisit to check for a head-seam stitching bug — look at the head-seam path
  in `src/edit-ui/splice-run.js` and `src/edit-ui/splice.js` (`seamWindows` boundary-hugging search,
  the `genOffset`/`sourceSpan` de-pad mapping, and the flow-morph join at the in-point in
  `python/flow_morph.py`). Repro: open the run in `pipeline edit-ui`, view the spliced result, watch
  the first ~0.5s of the window boundary.

## Known blockers / gotchas

- **HF lip-sync nsfw ceiling.** Higgsfield moderation deterministically false-positives `nsfw` on
  speech-ref video + more than one image ref (and on full-quality lip-sync generally, since the draft
  endpoint was removed in the `api.higgsfield.ai` migration). It's HF-side, not the model — prefer the
  `fal` (default) or `muapi` backends for talking shots.

- **Higgsfield CLI can't run data/STT jobs.** `@higgsfield/cli` (1.1.19/1.1.20) can't run
  speech2text/data jobs; the pipeline uses local whisper.cpp for speech-to-text instead.

- **WAN/fal timeline truncation.** fal Wan VACE has a fixed 81-frame budget: pre-resample inputs to
  16fps, or the timing drifts and the tail of the clip gets dropped.
