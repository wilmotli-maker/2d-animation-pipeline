---
name: build-element
description: Onboard a new element (character/prop/scene) from a reference image and produce a set of sheets. Use when starting an element from a reference and you want turnaround/pose/cycle sheets built. Orchestrates create-element, reference ingest, style-lock authoring, then delegates each sheet to the element-author skill.
---

# Build Element

Take a reference image and produce a set of sheets for a new (or existing) element.
This skill orchestrates the whole onboarding; per-sheet authoring is delegated to the
**element-author** skill. Keep the flow interactive — confirm the style-lock and the
sheet plan before spending credits; every generate step is a real credit cost.

**Elements are shared across episodes.** They live once at the top-level `elements/`
(not under `episodes/<N>/`), so an element built for one episode is reusable by every
shot in every episode. Run these commands from the project's top directory with no
`--root` — the episode split applies only to shots, not elements.

## Procedure

1. **Gather inputs (confirm, don't assume):** element type
   (`characters` | `props` | `scenes` | `other`) and name; reference image path(s); a
   rough description / creative intent for the element.

2. **Create + ingest.** If the element doesn't exist, run
   `pipeline element create --type <type> --name <name>`. Copy the reference image(s)
   into `elements/<type>/<name>/inputs/reference-images/`.

3. **Author the style-lock (once).** View the reference and invoke the appropriate
   director skill — `illustration-director` for illustrated/stylized,
   `banana-pro-director` for photoreal — to extract the locked design. Propose a
   `style-lock.yaml` (palette, line weight, wardrobe, proportions / skin-hair-fabric,
   identity markers), mirror it back, iterate, then write it to
   `elements/<type>/<name>/style-lock.yaml`.

4. **Plan the sheet set (ask the user).** Propose a default plan and confirm which
   sheets to build and in what order. Recommended default:
   - `turnaround` first (a strong multi-angle sheet later sheets can reference),
   - then a `pose` sheet,
   - optionally `cycles`.
   The user can pick any subset/order and add more later. Agree a short kebab-case
   slug per sheet (e.g. `default`, `winter-outfit`).

5. **Build each planned sheet — delegate to element-author.** For each sheet, invoke
   the **element-author** skill with the element, sheet type, slug, model, and
   reference image(s). element-author handles the sheet-type-specific interaction
   (e.g. the pose set), the verify step, generation, and per-sheet review/iteration.
   Offer to chain a finished turnaround (`sheets/turnaround/<slug>/vNNN.png`) as an
   extra `--image` reference for later pose/cycle sheets, for consistency.

   **Building several independent sheets at once?** After composing + verifying each
   (element-author steps 1–6), generate them together in parallel instead of one at a
   time — see element-author's *Batch generation* (`pipeline element sheet-batch
   --manifest <file.json>`, up to 8 concurrent, failures isolated). Keep the
   turnaround-first ordering: sheets that reference the turnaround's panels must be
   generated after it, so build the turnaround first, then batch the rest.

6. **Wrap up.** Summarize the sheets produced (type / slug / version) and where they
   live. Offer to build more sheets, add another instance, or refine any sheet.

This skill never generates directly — it always goes through element-author per sheet,
so all generation flows through the same verify / generate / prompt-fidelity path.
