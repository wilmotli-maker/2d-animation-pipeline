---
name: element-author
description: Author a detailed Higgsfield prompt for an element sheet (character/prop/scene) from a rough idea and reference image, then verify and generate it. Use when creating or iterating on a turnaround, pose, or action/cycle sheet for an element in this animation project.
---

# Element Author

Turn a rough creative intent into a validated, generation-ready element sheet.
Follow the steps in order; do not skip the verify step.

## Inputs to gather and confirm (propose defaults, never assume silently)

- Element type + name (e.g. `characters` / `cecilia`). The element must already
  exist — if not, run `pipeline element create --type <t> --name <n>` first.
- Sheet type: `turnaround` | `pose` | `cycles`.
- Sheet id (slug): propose a short kebab-case slug from the intent (e.g.
  `winter-outfit`, `combat-stances`) and confirm it. Must match
  `^[a-z0-9][a-z0-9-]*$`. Reusing an existing slug adds a new version.
- The rough creative intent.
- The model (e.g. `nano_banana` for illustrated images).
- Reference images: paths under the element's `inputs/reference-images/`, and/or a
  previously generated sheet to reference for consistency.

## Procedure

1. **Ensure `style-lock.yaml` exists** for the element
   (`elements/<type>/<name>/style-lock.yaml`). If absent, author it: invoke the
   appropriate director skill (`illustration-director` for illustrated,
   `banana-pro-director` for photoreal) on the reference image(s), propose a
   `style-lock.yaml` capturing the locked design (palette, line weight, wardrobe,
   proportions / skin-hair-fabric, etc.), get the user's approval, and write it.
2. **Read** the element's `style-lock.yaml`.
3. **Compose** the sheet prompt: invoke the right director skill to write a
   detailed prompt for the requested sheet type, incorporating the locked design
   (e.g. a 6-panel multi-angle sheet for a turnaround — not a single figure).
4. **Iterate** with the user on the prompt (1–2 rounds).
5. **Write** the finalized prompt to the canonical path (create the dir if needed):
   `elements/<type>/<name>/sheets/<sheetType>/<slug>/prompt.md`
6. **Verify** — run and show the checklist; resolve any ✗ before continuing (a ⚠
   for missing style-lock is allowed but usually worth fixing):
   `pipeline verify element --type <t> --name <n> --sheet <sheetType> --id <slug> [--image <ref> ...]`
7. **Generate** (reads the canonical prompt written in step 5):
   `pipeline element sheet --type <t> --name <n> --sheet <sheetType> --id <slug> --model <m> [--image <ref> ...]`
8. **Review** the output path with the user. Offer to refine the prompt and
   regenerate (a new version under the same slug) or accept.

## Shots

For a shot, use `illustration-worldbuilder` / `cinema-worldbuilder` to compose,
write the prompt to `shots/<id>/drafts/vNNN/prompt.md` (after `pipeline shot draft`),
verify with `pipeline verify shot --id <id> --version <n>`, and generate with
`pipeline shot generate --id <id> --version <n> --model <m>`.
