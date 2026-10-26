---
name: pose-keyframe-author
description: Generate a SINGLE pose still of a character by editing a reference frame — pass a reference image of the character (already at the target framing) plus a text description of a new pose, and get back that same character in the new pose, in the same framing and art style. Use to produce a middle keyframe for a targeted edit (the @Image2 pose) or any one-off pose image. Reuses the character's style lock and the shot-generation framing language.
---

# Pose Keyframe Author

Generate **one pose still** for a character: a reference frame (the character at the framing
and scale you want) + a **text pose** → the same character in that pose, same framing, scale,
orientation and art style. This is an *image edit*, not a from-scratch render and not a 3×2 pose
sheet (that is `element sheet --sheet pose`). The primary use is producing the middle keyframe of a
`targeted-edit-author` edit (the `@Image2` pose), replacing the old "matte an existing pose still"
prep — but it is standalone and works for any one-off pose.

The generation primitive is `pipeline image edit` (fal Nano Banana `/edit`); this skill's job is to
**compose the right prompt** from the character's design and call it.

## Inputs (gather and confirm)

1. **Character element** — its name (and type, default `characters`), so you can read the design:
   `elements/<type>/<name>/style-lock.yaml`.
2. **Reference frame** — an image of the character at the exact framing/scale/orientation you want
   the pose to keep (for a targeted-edit keyframe, grab a frame from the source clip at the edit
   window; e.g. `ffmpeg -ss <t> -i <clip> -frames:v 1 ref.png`).
3. **Pose** — a short text description of the new pose ("rests one claw against the side of its head,
   tilted, thinking"). Make it clearly different from the reference's pose or it won't read as a change.

## Procedure

1. **Read the style lock.** Open `elements/<type>/<name>/style-lock.yaml` and take its `style_stack`
   (the design + art-style line). Use the **correct per-character** lock — styles differ between
   characters (e.g. painterly watercolor vs flat children's-book vs crayon/watercolor).
2. **Compose the prompt** (write it to a file, e.g. `pose-prompt.md`) following *Prompt structure*
   below. Reuse the framing/orientation and no-props language from `targeted-edit-author` /
   `src/edit-ui/trim-prompt.js`, re-tensed for a single still (no "across the clip", no lip-sync).
3. **Generate:**
   ```
   pipeline image edit --image <ref-frame> --prompt-file pose-prompt.md --runner fal --out <dir>
   ```
   (needs `FAL_KEY`; default model `nano_banana_2_lite` → fal Nano Banana 2.)
4. **Report** the output still's path. Offer to refine the pose wording and re-run (each run
   auto-versions `<stem>-edit-vNN.png`, so iterations don't overwrite).

## Prompt structure

Three short parts — the image analogue of a shot prompt:

1. **Design + style (from the style lock).** "The character carries its exact design, line weight,
   coloring, proportions and art style from the reference image: `<style_stack>`." Do not redesign or
   re-style.
2. **Framing / orientation — preserve exactly.** "Keep the reference image's EXACT framing, shot size
   and crop, the same subject scale and position, the same camera angle and the same orientation /
   viewpoint, and the same background. Change ONLY the pose." (If the reference shows the full figure,
   add: "keep the entire figure — head through both feet — fully in frame; do not crop or tighten.")
3. **The pose + no-props.** "Re-pose the character so it `<pose>`. Keep the hands/claws empty —
   nothing is held, picked up, or conjured, and no prop appears."

## Use

- **Targeted edit:** feed the still as the middle keyframe (`@Image2` / the pose keyframe) in
  `targeted-edit-author`'s keyframe-pose variant — it lands the exact pose without matte prep.
- **Standalone:** any time you want one pose image of a character from a reference.

## Gotchas

- **Correct style lock per character** — a wrong or generic style lock drifts the design.
- **Reference frame carries the framing** — the pose inherits whatever framing/scale the reference
  shows, so pick a reference at the framing you want the keyframe to have.
- **fal endpoint IDs are version-sensitive** — `pipeline image edit` keeps them in
  `FAL_IMAGE_ENDPOINTS` (`src/fal.js`); adjust there if fal renames a model.
