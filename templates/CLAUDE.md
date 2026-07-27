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
sheet for an existing element, use the **element-author** skill. Both are in
`.claude/skills/`. They gather inputs, read the element's `style-lock.yaml`, invoke the
right director skill, verify (`pipeline verify`), and run generation.

Element and shot data live here under `elements/` and `shots/` (created by the
pipeline). Put a character's reference drawing in its
`inputs/reference-images/` folder before authoring.

## Command quick-reference

- `pipeline element create --type <characters|props|scenes|other> --name <name>`
- `pipeline element sheet --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> --model <m> [--prompt-file <f>] [--image <f> ...]`
- `pipeline verify element --type <t> --name <n> --sheet <s> --id <slug> [--image <f> ...]`
- `pipeline shot create --id <shotId>` · `pipeline shot draft --id <shotId>` · `pipeline shot generate --id <shotId> --version <n> --model <m> [--prompt-file <f>]`
- Credit cost draws from your Higgsfield account — check `higgsfield account transactions`.
