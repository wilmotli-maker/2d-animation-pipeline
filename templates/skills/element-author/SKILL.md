---
name: element-author
description: Author a detailed Higgsfield prompt for an element sheet (character/prop/scene) from a rough idea and reference image, then verify and generate it. Use when creating or iterating on a turnaround, pose, or action/cycle sheet for an element in this animation project.
---

# Element Author

Turn a rough creative intent into a validated, generation-ready element sheet.
Follow the steps in order; do not skip the verify step. (The `build-element` skill
calls this once per sheet when onboarding an element from a reference.)

## Inputs to gather and confirm (propose defaults, never assume silently)

- Element type + name (e.g. `characters` / `cecilia`). The element must already
  exist — if not, run `pipeline element create --type <t> --name <n>` first.
- Sheet type: `turnaround` | `pose` | `cycles` (see *Sheet types* for what each needs).
- Sheet id (slug): propose a short kebab-case slug from the intent (e.g.
  `winter-outfit`, `combat-stances`) and confirm it. Must match
  `^[a-z0-9][a-z0-9-]*$`. Reusing an existing slug adds a new version.
- The rough creative intent, plus any type-specific choices (see *Sheet types*).
- The model. **Default to `nano_banana_2_lite`** (Nano Banana 2 Lite) for image
  sheets. Step up to `nano_banana_pro` (Nano Banana Pro) when the sheet needs higher
  fidelity or the Lite result drifts. Prefer these two over older image models
  (`nano_banana`, `seedream`, …); propose the default and confirm before generating.
- Reference images: paths under the element's `inputs/reference-images/`, and/or a
  previously generated sheet to reference for consistency.

## Sheet types

Each type declares what to gather and which director mode to use. To add a new type
later, add a block here AND add the type to `SHEET_TYPES` in `src/element.js` so the
pipeline accepts it.

- **turnaround** — six fixed angles (front, three-quarter front, side, three-quarter
  rear, rear, face close-up) in one 16:9 sheet, composed as a 3×2 grid. No extra
  input. Director: `illustration-director` Mode 2A (or the `banana-pro-director`
  equivalent for photoreal). After generation the pipeline **auto-splits** the sheet
  into per-angle panel files (see *Turnaround panels*).
- **pose** — distinct action poses in one 16:9 sheet, composed as a 3×2 grid.
  **Ask the user for the pose set;** default: idle / walk mid-stride / run / jump
  apex / wave / sit-or-crouch. Director: Mode 2B. The pipeline **auto-splits** the
  sheet into per-panel files (see *Sheet panels*).
- **cycles** — an animation cycle. **Ask which cycle** (walk, idle, run, …) and
  compose it as evenly spaced keyframes of that motion across the panels.

## Procedure

1. **Ensure `style-lock.yaml` exists** for the element
   (`elements/<type>/<name>/style-lock.yaml`). If absent, author it: invoke the
   appropriate director skill (`illustration-director` for illustrated,
   `banana-pro-director` for photoreal) on the reference image(s), propose a
   `style-lock.yaml` capturing the locked design (palette, line weight, wardrobe,
   proportions / skin-hair-fabric, etc.), get the user's approval, and write it.
2. **Read** the element's `style-lock.yaml`.
3. **Gather type-specific choices** (pose set / cycle, per *Sheet types*), then
   **compose** the sheet prompt: invoke the right director skill and mode to write a
   detailed prompt incorporating the locked design (e.g. a 6-panel multi-angle sheet
   for a turnaround — not a single figure). Keep it lean when a reference image is
   provided — see *Prompt fidelity* below.
4. **Iterate** with the user on the prompt (1–2 rounds).
5. **Write** the finalized prompt to the canonical path (create the dir if needed):
   `elements/<type>/<name>/sheets/<sheetType>/<slug>/prompt.md`
6. **Verify** — run and show the checklist; resolve any ✗ before continuing (a ⚠
   for missing style-lock is allowed but usually worth fixing):
   `pipeline verify element --type <t> --name <n> --sheet <sheetType> --id <slug> [--image <ref> ...]`
7. **Generate** (reads the canonical prompt written in step 5):
   `pipeline element sheet --type <t> --name <n> --sheet <sheetType> --id <slug> --model <m> [--image <ref> ...]`
8. **Review** the output path with the user. Offer to refine the prompt and
   regenerate (a new version under the same slug) or accept. For a **turnaround**
   or **pose**, also point out the auto-generated panel folder (see *Sheet panels*).

## Batch generation (multiple sheets at once)

Generating several sheets in one go (e.g. a full sheet plan from `build-element`)?
Don't call `pipeline element sheet` once per sheet and wait for each — that is
sequential and one failure blocks the rest. Compose + verify each sheet first
(steps 1–6), then submit them all through one parallel batch (up to 8 at a time,
failures isolated):

```
pipeline element sheet-batch --manifest <file.json> [--concurrency <n=8>] [--root <dir>]
```

The manifest is a JSON array (or `{ "concurrency": N, "items": [...] }`), one entry
per sheet, each with the same fields as `element sheet`:

```json
[
  { "type": "characters", "name": "cecilia", "sheet": "turnaround", "id": "winter", "model": "nano_banana_2_lite",
    "images": ["elements/characters/cecilia/reference/ref.png"] },
  { "type": "characters", "name": "cecilia", "sheet": "pose", "id": "combat", "model": "nano_banana_2_lite" }
]
```

Each item reads its canonical `.../sheets/<sheetType>/<slug>/prompt.md` (write +
verify it first). The command prints a ✓/✗ line per sheet and exits non-zero if any
failed; each success downloads, versions, logs, and auto-splits panels exactly like a
single generate. **Verify every sheet before batching** — it spends real credits on
all of them. Note: sheets that reference a *previous* sheet's panel (e.g. a pose that
uses the turnaround's front panel) can't be in the same batch as the sheet they depend
on — generate the referenced sheet first, then batch the rest.

## Sheet panels

`turnaround` and `pose` sheets are a single 16:9 image in a 3×2 grid. The pipeline
automatically splits that image into six per-panel files so later prompt-generation
can reference one panel directly. For a generated `vNNN.png`, the panels land in a
sibling folder **named after the sheet**:

```
elements/<type>/<name>/sheets/turnaround/<slug>/
  v001.png                    # the all-in-one sheet
  v001.prompt.md
  v001/                       # folder name == sheet name
    01-front.png
    02-three-quarter-front.png
    03-side.png
    04-three-quarter-rear.png
    05-rear.png
    06-face-closeup.png
```

Turnaround panels carry the angle in the name (fixed 3×2 order); the numeric prefix
preserves grid order and the angle slug is the stable handle. Pose panels use generic
`panel-1`…`panel-6` names (grid order left→right, top→bottom), matching the pose set
you chose for that sheet. To condition a downstream sheet or shot on one panel, pass
it as a reference image — e.g. the side profile for a side-on shot:

```
pipeline element sheet --type characters --name cecilia --sheet pose --id combat \
  --model nano_banana_2_lite \
  --image elements/characters/cecilia/sheets/turnaround/winter/v001/03-side.png
```

`cycles` sheets are left whole (the panels are frames of one continuous motion, not
independently useful references).

Sheets generated before auto-split existed (or any that are missing their folder)
can be split **after the fact**. This scans existing sheets and splits only those
without a panel folder — it never touches folders that already exist, so it is safe
to re-run:

```
pipeline element split-panels                         # backfill the whole project
pipeline element split-panels --type characters --name cecilia   # narrow the scan
```

Optional `--type` / `--name` / `--sheet` / `--id` flags narrow which sheets are scanned.

## Prompt fidelity — keep it lean when a reference image is provided

With an image-reference model (e.g. Nano Banana Pro) the prompt and the reference
image compete: the more elaborate and prescriptive the prompt, the more the model
reinterprets and drifts from the reference's actual rendering style. When a
faithful reference exists, favour a **short, plain** prompt and let the reference
carry the style.

- Describe the design and panel layout concisely; avoid piling on emphatic
  negatives and restatements ("NOT a three-quarter turn", "no vest or jacket…").
- Include one anchor line: *"match the exact line weight, colouring and style of
  the reference image — do not smooth, polish, or restyle."*
- Make corrections **surgically** — change only the clause that was wrong; don't
  rewrite the whole prompt. A longer "fix" prompt often drifts more than the
  thing it was fixing.
- If a regenerated version drifts from the reference, suspect prompt length
  first, not a missing reference. Confirm the reference was actually sent with
  `higgsfield generate get <jobId> --json` (check `input_images`).

## Shots

For a shot, prefer the **`shot-author`** skill — it owns the full compose → verify →
generate → promote loop, including episodic projects (shots under
`episodes/<N>/shots/…`, threaded via `--root episodes/<N>`). In short: use
`illustration-worldbuilder` / `cinema-worldbuilder` to compose, write the prompt to
`shots/<id>/drafts/vNNN/prompt.md` (after `pipeline shot draft`; in an episodic
project this is `episodes/<N>/shots/<id>/…` and every `pipeline shot`/`verify shot`
command takes `--root episodes/<N>`), verify with
`pipeline verify shot --id <id> --version <n> [--root episodes/<N>]`, and generate
with `pipeline shot generate --id <id> --version <n> --model <m> [--root episodes/<N>]`.
Elements are shared across episodes — reference them from the top-level `elements/`.

## Lip-sync shots (talking characters)

When a shot lip-syncs a character to a **user-provided speech recording**:

1. **Transcribe the recording** to get the exact words:
   `pipeline voice transcribe --audio <wav>` — writes a `<wav>.txt` sidecar beside it
   (local whisper.cpp; `--dir <folder>` does a whole folder at once and skips wavs that
   already have a `.txt`).
2. **Quote the sidecar verbatim** in the Seedance prompt (e.g. `the character says,
   "<exact transcript>"`) — do not paraphrase or re-capitalize. The exact line is what
   gives the generated speech its fidelity.
3. **Generate** with the recording as the speech source:
   `pipeline shot generate … --speech-audio <wav>` (see `docs/recipes/seedance-lipsync.md`).
