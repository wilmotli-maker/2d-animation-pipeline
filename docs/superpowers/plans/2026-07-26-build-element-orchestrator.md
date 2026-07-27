# build-element Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codify the reference-image → sheets flow as a `build-element` orchestrator skill that delegates to a sheet-type-aware `element-author`, scaffolded into every project by `pipeline init`.

**Architecture:** Two skill templates (the orchestrator `build-element`, and the enhanced per-sheet `element-author`) plus a generalized `initProject` that copies *all* skill templates under `templates/skills/`. The only executable change is `src/init.js` + its test; the rest is authored skill/template content.

**Tech Stack:** Node.js (ESM, `node:test`), Markdown skill templates. Spec: `docs/superpowers/specs/2026-07-26-build-element-orchestrator-design.md`.

---

## File structure

- **Create** `templates/skills/build-element/SKILL.md` — the orchestrator skill.
- **Overwrite** `templates/skills/element-author/SKILL.md` — sheet-type-aware version.
- **Modify** `templates/CLAUDE.md` — point to `build-element` for onboarding.
- **Modify** `src/init.js` — copy every skill under `templates/skills/*/SKILL.md`.
- **Modify** `test/init.test.js` — assert both skills are scaffolded.

---

## Task 1: Author the skill + CLAUDE.md templates

**Files:**
- Create: `templates/skills/build-element/SKILL.md`
- Overwrite: `templates/skills/element-author/SKILL.md`
- Modify: `templates/CLAUDE.md`

Content files (no test); Task 2's test asserts they are scaffolded.

- [ ] **Step 1: Create `templates/skills/build-element/SKILL.md`** with exactly:

```markdown
---
name: build-element
description: Onboard a new element (character/prop/scene) from a reference image and produce a set of sheets. Use when starting an element from a reference and you want turnaround/pose/cycle sheets built. Orchestrates create-element, reference ingest, style-lock authoring, then delegates each sheet to the element-author skill.
---

# Build Element

Take a reference image and produce a set of sheets for a new (or existing) element.
This skill orchestrates the whole onboarding; per-sheet authoring is delegated to the
**element-author** skill. Keep the flow interactive — confirm the style-lock and the
sheet plan before spending credits; every generate step is a real credit cost.

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

6. **Wrap up.** Summarize the sheets produced (type / slug / version) and where they
   live. Offer to build more sheets, add another instance, or refine any sheet.

This skill never generates directly — it always goes through element-author per sheet,
so all generation flows through the same verify / generate / prompt-fidelity path.
```

- [ ] **Step 2: Overwrite `templates/skills/element-author/SKILL.md`** with exactly:

```markdown
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
- The model (e.g. `nano_banana` for illustrated images).
- Reference images: paths under the element's `inputs/reference-images/`, and/or a
  previously generated sheet to reference for consistency.

## Sheet types

Each type declares what to gather and which director mode to use. To add a new type
later, add a block here AND add the type to `SHEET_TYPES` in `src/element.js` so the
pipeline accepts it.

- **turnaround** — six fixed angles (front, three-quarter front, side, three-quarter
  rear, rear, face close-up) in one 16:9 sheet. No extra input. Director:
  `illustration-director` Mode 2A (or the `banana-pro-director` equivalent for photoreal).
- **pose** — distinct action poses in one 16:9 sheet. **Ask the user for the pose
  set;** default: idle / walk mid-stride / run / jump apex / wave / sit-or-crouch.
  Director: Mode 2B.
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
   regenerate (a new version under the same slug) or accept.

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

For a shot, use `illustration-worldbuilder` / `cinema-worldbuilder` to compose,
write the prompt to `shots/<id>/drafts/vNNN/prompt.md` (after `pipeline shot draft`),
verify with `pipeline verify shot --id <id> --version <n>`, and generate with
`pipeline shot generate --id <id> --version <n> --model <m>`.
```

- [ ] **Step 3: Update `templates/CLAUDE.md`** — replace the "How to work here" paragraph's first sentence block so it points to both skills. Change the paragraph that currently begins "This is an animation project driven by the 2d-animation pipeline. To create or iterate on a character/prop/scene sheet, use the **element-author** skill…" to:

```markdown
This is an animation project driven by the 2d-animation pipeline. To onboard a **new
element from a reference image** (create it, author its `style-lock.yaml`, and build a
set of sheets), use the **build-element** skill. To create or iterate on a **single**
sheet for an existing element, use the **element-author** skill. Both are in
`.claude/skills/`. They gather inputs, read the element's `style-lock.yaml`, invoke the
right director skill, verify (`pipeline verify`), and run generation.
```

- [ ] **Step 4: Commit**

```bash
git add templates/skills/build-element/SKILL.md templates/skills/element-author/SKILL.md templates/CLAUDE.md
git commit -m "feat: add build-element orchestrator skill; make element-author sheet-type-aware"
```

---

## Task 2: `initProject` scaffolds all skills

**Files:**
- Modify: `src/init.js`
- Test: `test/init.test.js`

- [ ] **Step 1: Update the test**

Replace the first test in `test/init.test.js` (the one titled `'initProject scaffolds CLAUDE.md and the element-author skill'`) with:

```js
test('initProject scaffolds CLAUDE.md and all skill templates', async () => {
  await withTemp(async (base) => {
    const target = path.join(base, 'proj');
    const res = await initProject(target);
    assert.equal(res.dir, target);
    const claude = await readFile(path.join(target, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /Style bible/);
    const ea = await readFile(
      path.join(target, '.claude', 'skills', 'element-author', 'SKILL.md'), 'utf8');
    assert.match(ea, /name: element-author/);
    const be = await readFile(
      path.join(target, '.claude', 'skills', 'build-element', 'SKILL.md'), 'utf8');
    assert.match(be, /name: build-element/);
    // res.files lists every scaffolded file.
    assert.ok(res.files.includes('.claude/skills/element-author/SKILL.md'));
    assert.ok(res.files.includes('.claude/skills/build-element/SKILL.md'));
  });
});
```

Keep the existing second test (`'initProject creates a missing target dir but refuses a non-empty one'`) unchanged.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/init.test.js`
Expected: FAIL — `build-element/SKILL.md` not found (init only copies element-author).

- [ ] **Step 3: Generalize `src/init.js` to copy every skill template**

Replace the body of `initProject` (from the CLAUDE.md write through the return) so it copies all skills under `templates/skills/`. The full file should read:

```js
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(here, '..', 'templates');

// Empty dir or missing dir both count as safe to scaffold into.
async function emptyOrMissing(dir) {
  try { return (await readdir(dir)).length === 0; }
  catch (err) { if (err.code === 'ENOENT') return true; throw err; }
}

// Scaffold a new project folder: CLAUDE.md + every skill under templates/skills/.
export async function initProject(targetDir) {
  const dir = path.resolve(targetDir);
  if (!(await emptyOrMissing(dir))) {
    throw new Error(`refusing to init a non-empty directory: ${dir}`);
  }
  await mkdir(dir, { recursive: true });
  const files = [];

  const claudeMd = await readFile(path.join(TEMPLATES, 'CLAUDE.md'), 'utf8');
  await writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);
  files.push('CLAUDE.md');

  // Copy every templates/skills/<name>/SKILL.md into the project's .claude/skills/.
  const skillsSrc = path.join(TEMPLATES, 'skills');
  let names = [];
  try { names = await readdir(skillsSrc); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  for (const name of names.sort()) {
    let content;
    try { content = await readFile(path.join(skillsSrc, name, 'SKILL.md'), 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') continue; throw err; } // skip non-skill entries
    const destDir = path.join(dir, '.claude', 'skills', name);
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, 'SKILL.md'), content);
    files.push(`.claude/skills/${name}/SKILL.md`);
  }

  return { dir, files };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/init.test.js`
Expected: PASS — both tests green (build-element + element-author scaffolded).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Smoke-test (no credits)**

Run:
```bash
rm -rf /tmp/pbe && node bin/pipeline.js init /tmp/pbe
find /tmp/pbe/.claude -name SKILL.md | sort && rm -rf /tmp/pbe
```
Expected: lists both `build-element/SKILL.md` and `element-author/SKILL.md`.

- [ ] **Step 7: Commit**

```bash
git add src/init.js test/init.test.js
git commit -m "feat: initProject scaffolds every skill template (adds build-element)"
```

---

## Post-merge (manual, not a TDD task)

Sync the two updated skill files into the existing `Puddle-Test` project (it was
scaffolded before these changes):

```bash
cp templates/skills/element-author/SKILL.md "/Users/wilmotli/Projects/Seedance Animation/Puddle-Test/.claude/skills/element-author/SKILL.md"
mkdir -p "/Users/wilmotli/Projects/Seedance Animation/Puddle-Test/.claude/skills/build-element"
cp templates/skills/build-element/SKILL.md "/Users/wilmotli/Projects/Seedance Animation/Puddle-Test/.claude/skills/build-element/SKILL.md"
```

---

## Self-review

- **Spec coverage:** separate `build-element` orchestrator (Task 1) ✓; delegates to
  element-author per sheet (build-element step 5) ✓; full onboarding incl. create +
  reference ingest + style-lock (build-element steps 2–3) ✓; cross-sheet interaction in
  the orchestrator, pose/cycle interaction inside element-author *Sheet types* (Task 1)
  ✓; extension path documented in *Sheet types* + `SHEET_TYPES` note (Task 1) ✓; init
  scaffolds both skills (Task 2) ✓; CLAUDE.md points to both (Task 1 step 3) ✓; Puddle-Test
  sync (post-merge) ✓.
- **Placeholder scan:** all content is complete; the only `<...>` are literal CLI
  placeholders inside skill instructions, and `<!-- fill in -->` in CLAUDE.md is an
  intentional authoring placeholder. No plan placeholders.
- **Type consistency:** `initProject` still returns `{ dir, files }`; the test asserts
  `res.files` includes both skill paths, matching the implementation's `files.push(...)`
  entries. Skill directory layout (`.claude/skills/<name>/SKILL.md`) is identical across
  init.js, the test, and the smoke test. The generalized copy loop makes future skills
  auto-scaffold with no further init.js edits — satisfying the extensibility goal.
```
