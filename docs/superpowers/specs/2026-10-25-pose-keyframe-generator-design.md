# Pose Keyframe Generator — Design

Date: 2026-10-25

## Intent / why

A targeted edit (`targeted-edit-author`) can inject a pose as the middle keyframe
(`@Image2`) of a talking shot. Today that pose still has to be **matted from an
existing image** — there is no way to *generate* one. This adds a way to generate a
single pose still for a character from a reference frame + a text description of the
pose, so it can be dropped straight into an edit's keyframe slot. It generalizes the
pose-prep step we did by hand in earlier experiments.

The primary consumer is the keyframe-pose variant of the targeted edit, but the
capability is standalone so it can be used other ways (one-off pose stills, building a
pose for any purpose).

## Goals

- From **one reference frame** (the character already at the target framing/scale) + a
  **text pose**, generate the *same character* in that pose, preserving framing, scale,
  position, orientation, design and art style.
- Reuse the character's **style lock** (`style-lock.yaml` → `style_stack`) and the
  shot-generation framing/orientation prompt components already factored for edits.
- Be **standalone and reusable**, not welded to the edit workflow.
- Produce a still ready to drop in as `@Image2` in a targeted edit.

## Non-goals

- Not a pose **sheet / 3×2 grid** — that is `element sheet --sheet pose`.
- Not video.
- Not matting/compositing — generation is an *alternative* to the matte-prep step; this
  work does not remove or change the existing matte path.
- Not auto-wiring the still into an edit run — the skill hands back a file; dropping it
  into the edit stays the existing targeted-edit flow.

## Anti-goals (would make it a failure even if it "works")

- Changing the character's design or art style (must be preserved exactly).
- Changing the framing, scale, crop, or orientation — only the **pose** changes.
- Introducing any prop/object not in the reference.

## Constraints

- Uses the fal image runner added in #168 (`createFalImageRunner`, fal `/edit` endpoint,
  default model `nano_banana_2_lite` → fal Nano Banana 2). Needs `FAL_KEY`.
- The prompt is composed by the **skill** (Claude-authored), consistent with how
  `element-author` / `shot-author` author prompts — not hardcoded in a command.

## The decided how

Two pieces.

### 1. `pipeline image edit` — a thin, standalone command (code)

Mirrors `pipeline image upscale`: a general single-image edit primitive, no element or
credit bookkeeping, so the skill (or anything else) can call it.

```
pipeline image edit --image <ref> [--image <ref> ...] (--prompt <p> | --prompt-file <f>) \
  --out <dir> [--model nano_banana_2_lite] [--runner fal|higgsfield]
```

- **Default `--runner fal`** (the `/edit` path from #168; `/edit` is used because image
  refs are present). `higgsfield` available as the alternate.
- Writes one image into `--out`, prints the path.
- Reuses `createFalImageRunner` + `FAL_IMAGE_ENDPOINTS` (same version-sensitivity note as
  #168 — the slug is the single place to adjust).

### 2. `pose-keyframe-author` — a new standalone skill

In `templates/skills/pose-keyframe-author/` (synced to projects via `pipeline sync-skills`).

- **Inputs:** the character's element name (→ reads `style-lock.yaml` `style_stack`), a
  **reference frame** (the character at the target framing — e.g. a frame grabbed from
  the source clip), and the **pose text**.
- **Composes** a pose-edit prompt: the `style_stack` (design + art style) + a
  framing/orientation-preserve block ("match the reference image's exact framing, scale,
  position and orientation; change ONLY the pose to `<pose>`; keep the same design and art
  style") + the no-props guard — reusing the shot-gen framing/orientation component
  language already in `targeted-edit-author` / `buildTrimPrompt`, adapted from "across the
  clip" to a single still.
- **Calls** `pipeline image edit --image <frame> --prompt-file <composed> --runner fal`.
- **Hands back** the still's path, for the targeted-edit `@Image2` slot or other use.
- **`targeted-edit-author`** gains a short pointer: to generate a pose keyframe, use
  `pose-keyframe-author`.

## What's left to the builder

- Exact `image edit` flag parsing and output-filename convention (mirror `image upscale`:
  `src/upscale-image.js` + its `bin/pipeline.js` handler).
- The skill's prompt-template wording — lift the framing/orientation + no-props blocks
  from `src/edit-ui/trim-prompt.js` / `targeted-edit-author` and re-tense them for a still.
- Tests for `pipeline image edit` (injected runner/fetch, like `test/fal-image.test.js`):
  fal `/edit` is selected, the ref is passed, the output is written. The skill itself is
  an authoring skill (no unit tests, matching the other `*-author` skills).
- Docs: a `pipeline image edit` entry in the `templates/CLAUDE.md` command quick-reference.

## Builder-check — minor calls settled (mine, not the user's)

A builder read raised these; none change what gets built, so they are settled here:

- **`image edit` requires ≥1 `--image`.** It is an *edit* (ref → image); with no ref it
  would silently fall back to text-to-image. The command errors if no `--image` is given.
- **Multiple `--image` refs allowed**, passed through as `image_urls` (fal `/edit` accepts
  several); the pose-keyframe skill passes one.
- **Output filename:** `<out>/<first-input-stem>-edit-vNN.png`, auto-versioned like the
  sheet/upscale outputs (no overwrite). `--out` is a directory.
- **Default `--model nano_banana_2_lite`** for both runners (maps to fal Nano Banana 2;
  for `--runner higgsfield` the caller can pass another image model). Endpoint slugs stay
  in `FAL_IMAGE_ENDPOINTS` — same version-sensitivity caveat as #168.
- **The skill is handed a reference-frame path** (it does not grab frames from a clip);
  the caller/edit workflow supplies the frame. The skill writes the still via the command's
  `--out` and returns that path.
