# Prompt-Authoring Workflow — Design

**Date:** 2026-07-24
**Status:** Approved (design); pending implementation plan

## Problem

The pipeline generates from whatever prompt string it's handed. Effective character
sheets need detailed, structured prompts — the kind the director skills
(`illustration-director`, `illustration-worldbuilder`, `banana-pro-director`,
`cinema-worldbuilder`) produce. A rough one-liner ("a young girl with red hair in a
simple flat illustrated style") yielded a single figure, not a multi-view turnaround
(observed: `elements/characters/test-cecilia`, whose `inputs/prompt.md` stayed an empty
stub and which has no `style-lock.yaml`).

The prompt-authoring step is inherently Claude-in-the-loop (same shape as the deferred
interactive critique). This design adds that authoring layer **and makes the handoff
structured** so it doesn't rely on the user shepherding Claude to save files in the
right place or remember to read/update the locked design.

## Decisions (resolved during brainstorming)

1. **Session model:** per-project folders with an auto-loaded `CLAUDE.md`; run Claude
   Code from the project folder. (Not: run-from-repo-with-`--root`.)
2. **Prompt composition:** Claude composes the full prose prompt; the pipeline is a
   thin executor. (Not: pipeline auto-injects style-lock.)
3. **Handoff:** `--prompt-file` + the exact prompt saved per rendered version.
4. **Structure level:** canonical pipeline-owned paths + loud preconditions **and** a
   packaged `element-author` skill. (Not: prose-only, and not fully pipeline-orchestrated.)
5. **Sheet model:** two levels — many **sheet instances** per type, each with **versions**.
   (Not: one prompt per sheet type.)
6. **Sheet-instance id:** a human-readable slug (skill proposes, user overrides,
   pipeline validates unique-within-type + filesystem-safe).

## Session & project model

- **One-time setup:** `npm link` in the pipeline repo puts `pipeline` on the user's
  PATH (symlinks the bin; does not install deps globally). Documented in setup/README.
- **`pipeline init <dir>`** scaffolds a new project folder: writes a `CLAUDE.md` from a
  template and installs the `element-author` skill into `<dir>/.claude/skills/`. Prints
  next steps (`cd`, launch Claude, the `npm link` reminder if needed).
- The user runs Claude Code from the project folder, so `CLAUDE.md` auto-loads the
  project's persistent context every session. Project data (`elements/`, `shots/`) is
  written under the current directory by default (existing `projectRoot` behavior).

## Data model

A **sheet instance** is a specific turnaround/pose/cycle the user authors, identified by
`(sheet type, slug)`. It owns its working prompt, its reference context, and its
versioned renders. This replaces the current flat `sheets/<type>/vNNN.png` layout.

```
elements/<type>/<name>/
  inputs/
    reference-images/  reference-videos/  speech-samples/
    prompt.md                      # base identity description (authored)
  style-lock.yaml                  # locked design (authored by Claude from the ref)
  sheets/
    turnaround/
      winter-outfit/               # sheet instance; slug = persistent id
        prompt.md                  # working prompt for THIS instance (canonical path)
        v001.png   v001.prompt.md  # render + exact prompt snapshot for that version
        v002.png   v002.prompt.md
      summer-outfit/
        prompt.md  v001.png  v001.prompt.md
    pose/
      combat-stances/ ...
    cycles/
      walk/ ...
  generations.jsonl                # one line per render (schema below)
```

- **Versions** (`vNNN`) auto-increment *within* a sheet instance (max existing + 1).
- **Shots are unchanged** — a `shotId` with `drafts/vNNN/` already provides the same
  (id, version) shape; each draft's `prompt.md` is its canonical per-version prompt.

### `generations.jsonl` entry schema

```json
{
  "ts": "2026-07-24T19:54:41.698Z",
  "type": "characters",
  "sheetType": "turnaround",
  "sheetId": "winter-outfit",
  "version": "v001",
  "model": "nano_banana",
  "jobId": "<uuid>",
  "prompt": "<full prompt text used>",
  "promptFile": "sheets/turnaround/winter-outfit/v001.prompt.md",
  "imageReferences": ["inputs/reference-images/ref.png"],
  "output": "sheets/turnaround/winter-outfit/v001.png",
  "status": "generated"
}
```

## Prompt handoff & resolution

- New flag `--prompt-file <path>` on `element sheet` and `shot generate`.
- **Prompt source:** at most one of `--prompt` (inline, quick tests) or `--prompt-file
  <path>` may be given — supplying both is an error. When neither is given, the
  pipeline falls back to the **canonical path**:
  - element sheet → `sheets/<sheetType>/<slug>/prompt.md`
  - shot generate → `drafts/vNNN/prompt.md` (already created by `shot draft`)
- On render, the resolved prompt is snapshotted next to the output
  (`vNNN.prompt.md` for sheets; shot drafts are per-version already), and logged.
- The canonical path means **Claude never chooses where the prompt lives** — it writes
  to the path the pipeline defines for that instance/version.

## Preconditions (fail loud, in code)

Both commands refuse to spend a generation when the **resolved prompt is missing or
empty** — the error names the exact file to fill.

`element sheet` hard-requires and validates (error, no generation):
- **`--id <slug>`** — required; missing → error. Invalid (not matching
  `^[a-z0-9][a-z0-9-]*$`) → error. Reusing an existing slug is allowed and simply
  appends a new version — new-instance vs. new-version is inferred from whether
  `sheets/<type>/<slug>/` already exists (no collision error).

`element sheet` **warns but proceeds** when:
- **`style-lock.yaml` is absent** — prints a warning that the locked design is missing
  (the usual cause of drift, e.g. a single-figure "turnaround"), then generates anyway.
  No bypass flag needed since it never blocks. `shot generate` has no style-lock check,
  since a shot may compose multiple elements.

Existing guardrails still apply (element/shot/draft must exist; sheet type valid;
positive version).

## Validation & the `verify` command

**Single source of truth.** All precondition/validation logic lives in one module
(`src/validate.js`). Two entry points call it, so they can never drift:
- **Generate commands** (`element sheet`, `shot generate`) — hard enforcement at
  execution; a failed hard check aborts before any API call.
- **`pipeline verify`** — an authoring-time dry check that runs the same checks (plus
  authoring-artifact checks), prints a ✓/⚠/✗ checklist, and exits non-zero if any hard
  check fails. Zero-credit — no API call.

`pipeline verify element --type <t> --name <n> --sheet <sheetType> --id <slug>` reports:
- ✓/✗ element exists; sheet type valid; slug present and valid
- ✓/✗ prompt resolved and non-empty (naming the file it read)
- ⚠ `style-lock.yaml` absent; ✗ present but unparseable
- ✗ any referenced image path missing on disk

A `pipeline verify shot --id <shotId> --version <n>` variant covers shots (shot/draft
exist, prompt present and non-empty, referenced images exist).

This is what lets authoring end with **confirmed-valid inputs**: the `element-author`
skill runs `verify` before handing off, so the user sees a green checklist in Claude
before switching to generation — and because generation re-runs the same module, a
green check means generation won't fail on inputs.

## The `element-author` skill

Shipped in the repo as a template (`templates/skills/element-author/SKILL.md`) and
copied into `<project>/.claude/skills/element-author/` by `pipeline init`. It encodes
the authoring sequence so the interaction is one repeatable invocation rather than five
manual steps:

1. Resolve the element and sheet type; take a rough intent and a proposed slug (propose
   one from the intent; confirm with the user; validate).
2. Ensure `style-lock.yaml` exists — if not, run the style-lock sub-flow: invoke
   `illustration-director` (or the photoreal/video director as appropriate) on
   `inputs/reference-images/`, propose a `style-lock.yaml`, get approval, write it.
3. Read `style-lock.yaml`.
4. Invoke the appropriate director skill to compose a detailed prompt for the requested
   sheet, incorporating the locked design.
5. Show the prompt; iterate with the user (1–2 rounds).
6. Write the finalized prompt to the canonical path
   (`sheets/<type>/<slug>/prompt.md`).
7. Run `pipeline verify …` and show the ✓/⚠/✗ checklist; resolve any ✗ before
   proceeding (the authoring-time confidence gate).
8. Run the generate command (`pipeline element sheet … --id <slug>` reads the canonical
   prompt; pass `--image` references).
9. Show the output; offer to refine + regenerate (new version under the same slug) or
   accept.

**Inputs the skill gathers and confirms before generating** (proposing defaults, never
assuming silently): element type + name; sheet type; **sheet id (slug)** — proposed from
the intent, user can override; the rough creative intent; the model; and any reference
images. It does not proceed to author/generate until these are settled.

**Enforcement is layered.** The skill *gathers* inputs and guides the sequence, but it
is a Claude procedure (soft). The pipeline is the hard backstop: it independently rejects
a generation with a missing/invalid `--id`, a nonexistent element, an invalid sheet type,
or an empty prompt — so the non-negotiable inputs hold even if the skill is skipped or
Claude errs. Judgment items (a *meaningful* slug, presence of style-lock, choice of
references) remain the skill's/user's responsibility. The skill itself is not
unit-tested; every precondition it relies on is enforced by the pipeline and is.

## `CLAUDE.md` template

Thin, because the skill carries the procedure. Sections:
- What this project is (one line, user-filled).
- **Style bible** — a fill-in section for persistent stylistic concepts the user maintains.
- **Workflow pointer** — "use the `element-author` skill to create sheets; it reads
  `style-lock.yaml` and the director skills for you."
- Command quick-reference.

## Style-lock authoring (convention)

No new command. When creating an element and dropping a reference image in
`inputs/reference-images/`, the user asks Claude (via the skill's step 2) to extract the
locked design and write `style-lock.yaml` + the base identity in `inputs/prompt.md`.
Thereafter Claude reads `style-lock.yaml` when composing each sheet prompt.

## Code vs. convention

- **Code:** `pipeline init` + templates; the sheet-instance data model (`paths.js`,
  `generate.js`, `element.js`); a shared validation module (`src/validate.js`) used by
  both the generate commands and `pipeline verify`; `--id` and `--prompt-file` +
  canonical-default prompt resolution + preconditions on the generate commands;
  per-version prompt snapshots; `generations.jsonl` schema fields.
- **Convention (carried by `CLAUDE.md` + the skill):** the authoring sequence and
  style-lock authoring.

## Error handling

- Prompt resolution errors (missing/empty prompt, both `--prompt` and `--prompt-file`
  given → error) surface before any API call, so no credits are spent on a bad setup.
- Missing `style-lock.yaml` blocks generation unless `--allow-no-style-lock`.
- Invalid slug or nonexistent element/sheet type → clear, specific messages.
- `init` refuses to overwrite an existing non-empty target dir.

## Testing

Unit tests, injected fakes, zero credits/network:
- Prompt source: canonical fallback when neither flag given; missing/empty prompt →
  error; both `--prompt` and `--prompt-file` given → error.
- `style-lock` absent → warning emitted, generation still proceeds (does not block).
- `--id` required (missing → error) and slug validation (accept/reject cases);
  new-instance vs. new-version-of-existing (reused slug appends a version).
- Per-version prompt snapshot written with exact content; `generations.jsonl` schema.
- Sheet-instance path builders and within-instance version increment.
- Shared validator: `verify` and the generate preconditions call the same module and
  agree (a case that passes `verify` passes generation's checks, and vice versa).
- `verify` output: ✓/⚠/✗ checklist; exit non-zero on hard failure, zero on warn-only;
  style-lock-absent shows ⚠ but exits zero; missing referenced image → ✗ + non-zero.
- `pipeline init` scaffolds the dir, `CLAUDE.md`, and the skill; refuses non-empty dir.

## Out of scope (future)

- Headless (non-interactive) critique via `ANTHROPIC_API_KEY`.
- Upscale-to-production-resolution command.
- Multiple prompt variants *for a shot* (shots keep the single-clip, many-drafts model
  for now; revisit if needed).
- Automatic detection that a design change should update `style-lock.yaml` (the skill
  prompts for it; not enforced in code).

## Migration note

The current flat `sheets/<type>/vNNN.png` layout (used by `test-cecilia`) predates the
sheet-instance model. Since `elements/` is gitignored user data and only throwaway test
output exists, no migration tooling is needed — the new layout applies going forward.
