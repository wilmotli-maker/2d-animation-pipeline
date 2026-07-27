# build-element Orchestrator — Design

**Date:** 2026-07-26
**Status:** Approved (design); pending implementation plan

## Problem

The live test proved the reference-image → sheets flow works, but it lived only in
this conversation. We want to **codify** it: a repeatable, Claude-driven process that
takes a reference image and produces a set of element sheets, with room for
interaction (choosing pose/cycle sets) and for adding new sheet types later.

## Decisions (from brainstorming)

1. **Structure:** a **separate orchestrator skill** (`build-element`) that delegates
   per-sheet work to `element-author`. Not one combined skill.
2. **Interaction location:** sheet-type-specific interaction (pose set, cycle choice)
   lives **inside `element-author`** (made sheet-type-aware); the orchestrator owns the
   cross-sheet interaction (which sheets, what order).
3. **Scope:** the orchestrator owns **full onboarding from a reference** — create the
   element, ingest the reference, author `style-lock.yaml`, then build the sheet set.

## The two skills

### `build-element` (new orchestrator)

Flow:
1. **Inputs:** element type + name, reference image path(s), rough character intent.
   Create the element (`pipeline element create`) if it doesn't exist; copy the
   reference image(s) into `elements/<type>/<name>/inputs/reference-images/`.
2. **Style-lock (once):** invoke the appropriate director skill
   (`illustration-director` / `banana-pro-director`) on the reference, propose
   `style-lock.yaml`, iterate with the user, confirm, and write it.
3. **Plan the sheet set (interaction):** propose a default plan — **turnaround first**
   (so later sheets can reference it), then a pose sheet, optionally cycles — and ask
   the user which sheets they want and in what order.
4. **Build each sheet:** delegate to `element-author` per sheet. Offer to chain a
   finished turnaround as the `--image` reference for subsequent sheets.
5. **Wrap:** summarize the produced sheets and their versions.

### `element-author` (enhanced — sheet-type-aware)

Stays the per-sheet engine, gaining a per-type contract of *{what to gather, which
director mode}*:
- `turnaround` → the six fixed angles (director Mode 2A); no extra questions.
- `pose` → ask/confirm the pose set (default idle / walk / run / jump / wave / sit;
  user can customize) → director Mode 2B.
- `cycles` → ask which cycle(s) (walk, idle, run, …) → compose an animation-cycle
  prompt.

Retains everything it already does: read `style-lock.yaml`, the *Prompt fidelity*
lean-prompt rule, write the canonical prompt, `pipeline verify`, generate,
review/iterate.

## Extensibility (future sheet types)

A new sheet type is added in exactly two documented places:
1. The `SHEET_TYPES` list in `src/element.js` (so the pipeline validates it and
   `verify`/generate accept it).
2. One per-type block in `element-author` (what to gather + which director mode).

The `build-element` orchestrator then automatically offers whatever types exist. No
plugin registry — this is the deliberate, minimal extension path.

## What gets built

- **Create** `templates/skills/build-element/SKILL.md` (orchestrator).
- **Enhance** `templates/skills/element-author/SKILL.md` (sheet-type-aware per-type
  contract; keep the existing verify/generate/fidelity content).
- **Modify** `src/init.js` — scaffold **both** skills into `<project>/.claude/skills/`.
- **Modify** `test/init.test.js` — assert both skills are scaffolded.
- **Modify** `templates/CLAUDE.md` — point to `build-element` for onboarding a new
  element and `element-author` for one-off sheets.
- **Sync** both updated skill files into the existing `Puddle-Test` project (manual
  copy; it was scaffolded before these changes).

The only executable code change is `src/init.js` (copy a second skill) + its test;
everything else is authored skill/template content.

## Testing

- `test/init.test.js`: `initProject` scaffolds `build-element/SKILL.md` **and**
  `element-author/SKILL.md`; still refuses a non-empty dir.
- No new runtime code paths (pose/cycles already validate via existing `SHEET_TYPES`;
  no code change needed for them), so no other unit tests are required.

## Out of scope

- No automation of the director-skill invocation itself (it stays a Claude step).
- No new pipeline CLI commands (the orchestrator uses existing `element create`,
  `verify`, `element sheet`).
- Props/scenes-specific sheet types — the extension path is documented, but no new
  types are added now.
