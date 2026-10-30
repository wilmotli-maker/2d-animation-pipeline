# Editable shots with a background scene

A workflow for making and editing animated shots that live in a real background scene, while
keeping all the editing power of our isolated-character (plain-bg) pipeline. The trick: do every
hard step on the character in isolation against a plain backdrop, and composite the finished
performance into the scene as the last step — because our targeted-edit, stitching and
harmonization methods all work far better on an isolated character than on a full scene (a real
background makes framing drift and the splice's background morph very visible).

Validated 2026-10-29 in `evaluation/video-editing-eval/textpose-bruce/bruce-composite-scene/`
(v2 pass). Related findings: `docs/model-findings.md` → "Harmonize into a full background scene"
and "Real-background framing still drifts".

## Steps

1. **Get an isolated character shot (plain bg).** Either:
   - Generate the character shot directly against a plain/neutral backdrop, OR
   - Generate the shot already in the desired scene, then **matte** it to an isolated character:
     `pipeline shot matte --method ml` (background-agnostic; `plate` only for solid chroma plates).
     Composite the matte over flat grey for a clean plain-bg clip.

2. **Edit the isolated character shot** with our standard targeted-edit methods (text-pose /
   keyframe-pose edits via the edit-ui / fal reference-to-video path). Editing against a plain bg
   avoids the real-background framing and seam problems.

3. **Stitch + harmonize** the edited window back into the isolated shot to get a seamless, uniform
   isolated-character clip (splice + `video harmonize`). Still all on the plain bg.

4. **Build the scene composite reference still.** Composite a representative character frame into
   the target background plate with `pipeline image edit` (fal Nano Banana), pinning pose/identity
   and asking for scene-matched lighting + contact/cast shadows. This still is the integration
   target. (Make the plate 3:4 to match the shot.)

5. **Composite the finished isolated clip into the scene** with the colour-guidance harmonize pass
   (the method validated here):
   - Source `input` = the finished **isolated** (plain-bg) character clip.
   - Reference `@Image1` = the **generated composite still** from step 4 (NOT the bare plate — the
     still gives the model a concrete finished-frame target: scene + character composition +
     lighting + grounding). The prompt states @Image1 is the target finished frame and @Video1
     drives only the character's motion/framing.
   - **Skip the desaturate/blur**: the stock `filter` guidance greys the source (`hue=s=0,gblur`),
     which throws away the colour we want to keep. Pass the source through in full colour (bypass
     that one filter) so the model matches the character's existing colours and only adapts
     lighting to fit the scene.
   - **No pad, no border** for this composite step (those are for the restyle-framing problem; here
     the full-colour guidance anchors structure and framing well on its own).

## Reference implementation (spike)

`evaluation/video-editing-eval/textpose-bruce/bruce-composite-scene/`:
- `prompt-v2.md` — the composite prompt (@Image1 = target finished frame, @Video1 = motion only).
- `spike-v2.mjs` — colour-guidance harmonize: wraps the `ff` dep to rewrite the guidance
  `hue=s=0,...` filter to `null` (passthrough), `padMargin: 0`, no border, fal runner.
- `still-composite/output-frame-0-edit-v01.png` — the step-4 composite still (ref for step 5).
- `v2-out/output.harmonized.mp4` — the validated result.

## To productionize

The colour-guidance + composite-still path is a spike (`ff`-dep bypass). To fold into the CLI,
`video harmonize` would need: a no-desaturate / colour-guidance option, and acceptance of a
finished composite still as the appearance ref for a "composite into scene" mode.
