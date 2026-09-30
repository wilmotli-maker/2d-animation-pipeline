---
name: previz-blocking
description: Turn a reference video (illustrated or live-action) into a neutral grey previz / blocking pass — the SAME character re-rendered as a solid grey clay maquette (its own silhouette, proportions and facial expression kept, all colour and texture stripped) on an empty grey void, carrying only the source's motion, timing and pose. Use when asked for a previz, previs, blocking pass, greybox, or clay-render version of a clip, or as stage 1 of a two-stage "collapse to neutral, then restyle" harmonization of a spliced or mismatched clip.
---

# Previz Blocking Pass

Convert a reference video into a **grey blocking pass**: re-render **the same
character** as a solid, untextured grey clay maquette. Keep its own silhouette,
proportions, features and facial expression; strip every colour and texture. Only the
*motion, timing, pose, gesture and expression* survive. This is the neutral
intermediate that makes downstream restyling land consistently — collapsing two
mismatched halves of a spliced clip (or any inconsistent source) into one identical
grey look before a single reference style is applied.

**Key idea — neutralise, don't replace.** Do NOT ask the model to turn the character
*into a mannequin* with a sphere head and capsule limbs: that makes Seedance
substitute a generic (often wooden, humanoid) dummy and throw away the real design —
a robot's boxy head becomes a human head, a monster becomes a wooden biped. Instead
tell it to re-render *this* character, unchanged in shape, as grey clay.

Runs through the normal Seedance path: `pipeline shot generate --mode video_edit`
(the video-editing mode — exactly one video reference, **no** appearance reference on
this pass; the whole point is to strip appearance). Every generate is real credit
cost — check `higgsfield account transactions`.

## When to use

- The user asks for a **previz / previs / blocking pass / greybox / clay-render** cut
  of a clip.
- **Stage 1 of harmonization:** a spliced or otherwise inconsistent clip whose look
  you want to unify. Produce the previz here, then hand it to `shot-author` (or the
  restyle step) with a style reference image to repaint it uniformly.
- You need to preserve a performance (including facial expression) exactly but throw
  away the colour/rendering.

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
   Higgsfield uploads occasionally return HTTP 5xx (520/503) — just re-run, it's transient.
5. **Review** the clay cut against the source, checking all four: (a) the character's
   own silhouette/proportions are kept (not humanised or swapped for a dummy), (b) it
   is ONE uniform grey — no colour left in hair, eyes, lenses or clothing, (c) the
   face still has eyes/mouth/brows with the right expression, (d) background is an
   empty grey void and framing is head-to-feet. Re-roll (it's nondeterministic) before
   restyling if any of these drift.

## The previz prompt (use verbatim)

> Re-render the exact character in this video as a single-colour, untextured grey CLAY
> MAQUETTE — a 3D greybox / blocking-model version of THIS specific character. SHAPE —
> keep the character's exact silhouette, proportions and body-part shapes from the
> source: the same head shape and size, the same body, torso, limbs, hands and feet,
> and every distinctive feature it has (antennae, snout, muzzle, tail, ears, horns,
> spikes, fins, wings, extra or non-human limbs, block feet, etc.). Do NOT replace it
> with a generic humanoid figure, a human body, a rounded human head, or a wooden
> artist's posing mannequin, and do NOT change, regularise or humanise any proportion —
> a boxy head stays boxy, an animal body stays an animal body, a robot stays that
> robot's shape. FACE & EXPRESSION — KEEP the character's facial features and current
> expression on every frame: eyes, eyebrows, the mouth (or beak / muzzle), nose, and
> any visible teeth or tongue must stay, sculpted into the grey clay as raised or
> recessed relief so the expression reads clearly — never leave a blank, smooth or
> featureless face, and do not drop the mouth. MATERIAL — strip ALL colour and texture:
> remove every colour, line, outline, marking, pattern, logo, printed text and surface
> texture that came from the source. The ENTIRE character — body, head, face, hair,
> fur, skin, eyes, clothing and every accessory — must become ONE uniform flat matte
> light neutral-grey (like untextured 3D greybox or pale grey modelling clay), shown
> only through soft smooth shading. Absolutely no colour survives anywhere: no coloured
> hair or fur, no coloured eyes, no coloured glasses lenses or frames, no wood tone, no
> tints or textures from the source — every part is the same grey. BACKGROUND: a
> completely empty, featureless flat matte grey void — no environment, floor, set,
> walls, props or scenery of any kind; nothing but the single grey character on
> seamless grey. FRAMING: keep the source's exact camera framing and character scale —
> the whole character stays in frame from top to bottom in the same position and with
> the same margins as the source; never crop, zoom, pan or reframe. Preserve the body
> motion, performance timing, pose and gesture exactly. The result must read as an
> untextured grey 3D previz model of this character — never finished or coloured 2D
> artwork, and never a generic dummy.

## Restyling the previz (stage 2)

To turn the neutral previz back into a finished look, generate again with
`--mode video_edit --video <previz.mp4>` plus one or more **style reference images**
(`--image <ref> …`, repeatable) and a repaint prompt that (a) keeps motion/timing
unchanged, (b) applies the reference look identically on every frame, and (c)
**preserves the exact framing head-to-feet — never crops below the feet/knees or
zooms in**. Because the previz is uniform, one reference style lands consistently
across the whole clip; a single first frame is usually enough. The grey face's
sculpted expression gives the restyle its mouth/eyes to paint. `shot-author`'s
worldbuilder director can compose the repaint prompt from the reference image.

## Gotchas

- **Don't add an appearance reference on the previz pass.** The clay must be neutral;
  an `--image` here reintroduces the look you're trying to strip.
- **Don't say "mannequin / rig dummy / sphere head / capsule limbs."** That language
  makes the model discard the real design and render a generic — often wooden — human
  dummy. Frame it as re-rendering *this* character as grey clay, shape unchanged.
- **Colour leak.** Hair, eyes, and glasses lenses/frames are the usual hold-outs — the
  prompt names them explicitly; if colour survives there, re-roll.
- **Blank faces.** Without the FACE & EXPRESSION clause the model smooths the face and
  drops the mouth, leaving the restyle nothing to work from. Keep the clause.
- **Background creep.** Without the explicit "empty grey void" override the model
  invents set pieces (boxes, steps) behind the character. Keep the override.
- **Framing crop.** Both the previz and the restyle can silently zoom in and cut the
  character off below the knees; the FRAMING clause in both prompts holds the full-body
  composition. Re-roll if a take crops.
- **video_edit needs exactly one video reference** and preserves the source's exact
  dimensions and duration.
