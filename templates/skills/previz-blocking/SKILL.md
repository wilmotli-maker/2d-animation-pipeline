---
name: previz-blocking
description: Turn a reference video (illustrated or live-action) into a neutral 3D greybox previz / blocking pass — an articulated placeholder mannequin on an empty grey void that carries only the source's motion, timing and pose. Use when asked for a previz, previs, blocking pass, greybox, or animation-mannequin version of a clip, or as stage 1 of a two-stage "collapse to neutral, then restyle" harmonization of a spliced or mismatched clip.
---

# Previz Blocking Pass

Convert a reference video into an **animation blocking pass**: the performer becomes
an obvious articulated placeholder mannequin (greybox), so only the *motion, timing,
pose and gesture* survive and all surface appearance is discarded. This is the
neutral intermediate that makes downstream restyling land consistently — collapsing
two mismatched halves of a spliced clip (or any inconsistent source) into one
identical placeholder look before a single reference style is applied.

Runs through the normal Seedance path: `pipeline shot generate --mode video_edit`
(the video-editing mode — exactly one video reference, no appearance reference on
this pass; the whole point is to strip appearance). Every generate is real credit
cost — check `higgsfield account transactions`.

## When to use

- The user asks for a **previz / previs / blocking pass / greybox / mannequin** cut
  of a clip.
- **Stage 1 of harmonization:** a spliced or otherwise inconsistent clip whose look
  you want to unify. Produce the previz here, then hand it to `shot-author` (or the
  restyle step) with a single style reference image to repaint it uniformly.
- You need to preserve a performance exactly but throw away the rendering.

## Inputs to gather and confirm

- The **source video** (`--video <clip>`). Any length; keep test passes short.
- **Resolution / aspect / duration** to match the source (`--resolution 480p` for
  drafts, `--aspect-ratio` matching the clip, `--duration` = the clip's length).
- Silent unless the source needs audio — pass `--generate-audio false`.

## Procedure

1. **Scaffold** a shot to hold the pass (or reuse an eval work dir via `--root`):
   `pipeline shot create --id <id>` then `pipeline shot draft --id <id>`.
2. **Write the previz prompt** to `shots/<id>/drafts/vNNN/prompt.md` (use the prompt
   below verbatim — do not hand-soften it; the overrides are load-bearing).
3. **Verify**: `pipeline verify shot --id <id> --version <n> --model seedance_2_5 --video <clip> --resolution 480p --aspect-ratio <a>`.
4. **Generate**: `pipeline shot generate --id <id> --version <n> --model seedance_2_5 --mode video_edit --video <clip> --resolution 480p --aspect-ratio <a> --duration <s> --generate-audio false`.
   Submissions can take >2 min (upload latency); run submit+poll in the background.
   Higgsfield uploads occasionally return HTTP 520 — just re-run, it's transient.
5. **Review** the mannequin cut: confirm the background is an empty grey void (no
   stray set geometry) and the character is framed head-to-feet exactly as the source.
   If either drifts, re-roll (it's somewhat nondeterministic) before restyling.

## The previz prompt (use verbatim)

> VISUAL OVERRIDE — HIGHEST PRIORITY: completely discard all line art, colour,
> shading, texture and character design from the reference video. The source is NOT
> the visual target. Use it only to recover body motion, performance timing, pose and
> gesture. Render the result as an ANIMATION BLOCKING PASS in placeholder geometry:
> the character must become an obvious articulated animation mannequin — sphere-like
> head, single-piece torso, simple pelvis, capsule arms, capsule legs, block-like
> hands and feet — a rig-testing dummy, not a finished character. Do not recreate
> clothing, face or costume; represent them only as slightly enlarged primitive body
> volumes for silhouette. BACKGROUND: a completely empty, featureless, flat matte grey
> void — absolutely no environment, set, floor, walls, boxes, planes, cylinders, steps,
> props or scenery of any kind; nothing but the single mannequin on seamless grey.
> FRAMING: keep the source's exact camera framing and character scale — the whole
> mannequin stays in frame from the top of the head to the feet, in the same position
> and with the same margins as the source; never crop, zoom, pan or reframe. The first
> impression of every frame must be "unfinished 3D animation previs." It must never be
> mistaken for finished 2D artwork.

## Restyling the previz (stage 2)

To turn the neutral previz back into a finished look, generate again with
`--mode video_edit --video <previz.mp4>` plus one or more **style reference images**
(`--image <ref> …`, repeatable) and a repaint prompt that (a) keeps motion/timing
unchanged, (b) applies the reference look identically on every frame, and (c)
**preserves the exact framing head-to-feet — never crops below the feet/knees or
zooms in**. Because the previz is uniform, one reference style lands consistently
across the whole clip. `shot-author`'s worldbuilder director can compose the repaint
prompt from the reference image.

## Gotchas

- **Don't add an appearance reference on the previz pass.** The mannequin must be
  neutral; an `--image` here reintroduces the look you're trying to strip.
- **Background creep.** Without the explicit "empty grey void" override the model
  invents greybox set pieces (boxes, steps) behind the mannequin. Keep the override.
- **Framing crop.** Both the previz and the restyle can silently zoom in and cut the
  character off below the knees; the FRAMING clause in both prompts is what holds the
  full-body composition. Re-roll if a take crops.
- **video_edit needs exactly one video reference** and preserves the source's exact
  dimensions and duration.
