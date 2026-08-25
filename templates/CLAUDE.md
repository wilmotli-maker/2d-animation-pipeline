# Animation Project

<!-- One line: what this project is (the story/world, the register, the goal). -->

## Style bible

<!-- Persistent stylistic concepts for THIS project. Fill this in and keep it
     current — it's the shared context auto-loaded into every session. Examples:
     overall art style and register, colour language, tone, recurring motifs,
     a short do / don't list. The element-author skill and the director skills
     read this as background when composing prompts. -->

## How to work here

This is an animation project driven by the 2d-animation pipeline. To onboard a **new
element from a reference image** (create it, author its `style-lock.yaml`, and build a
set of sheets), use the **build-element** skill. To create or iterate on a **single**
sheet for an existing element, use the **element-author** skill. To create or iterate
on a **video shot** (including talking / lip-sync shots), use the **shot-author** skill.
All three are in `.claude/skills/`. They gather inputs, read the relevant locked design,
invoke the right director skill, verify (`pipeline verify`), and run generation. For
lip-sync specifics see `docs/recipes/seedance-lipsync.md`.

Element and shot data live here under `elements/` and `shots/` (created by the
pipeline). Put a character's reference drawing in its
`inputs/reference-images/` folder before authoring.

## Command quick-reference

- `pipeline element create --type <characters|props|scenes|other> --name <name>`
- `pipeline element sheet --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> --model <m> [--prompt-file <f>] [--image <f> ...]`
- `pipeline element split-panels [--type <t>] [--name <n>] [--sheet <turnaround|pose>] [--id <slug>]` — backfill per-panel folders for existing turnaround/pose sheets
- `pipeline verify element --type <t> --name <n> --sheet <s> --id <slug> [--image <f> ...]`
- `pipeline shot create --id <shotId>` · `pipeline shot draft --id <shotId>` · `pipeline shot generate --id <shotId> --version <n> --model seedance_2_5 --mode omni_reference --resolution 480p [--prompt-file <f>] [--speech-audio <wav>]`
- `pipeline shot upscale --id <shotId> [--version <n|final>] [--model topaz_video|bytedance_video_upscale] [--resolution 1080p|2160p]` — enlarge the finalized clip; pairs with 480p drafting
- `pipeline element upscale --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> [--version <n|latest>] [--model topaz_image|bytedance_image_upscale] [--scale 2|4] [--input <file>]` — enlarge a sheet (panel-aware for turnaround/pose; each panel upscaled then reassembled)
- `pipeline image upscale --input <file> [--model topaz_image|bytedance_image_upscale] [--scale 2|4] [--out <dir>]` — enlarge any single image
- `pipeline voice transcribe --audio <wav> [--dir <folder>] [--force]` — exact transcript sidecar (`<wav>.txt`) for lip-sync prompts; local whisper.cpp
- `pipeline sync-skills` — refresh this project's `.claude/skills/` from the current pipeline templates (run after the tool updates)
- Credit cost draws from your Higgsfield account — check `higgsfield account transactions`.
