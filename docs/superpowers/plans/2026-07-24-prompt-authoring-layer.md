# Prompt-Authoring Layer Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the authoring layer on top of the merged core (Plan A): a `pipeline init` command that scaffolds a per-project folder, a project `CLAUDE.md` template, the `element-author` skill that structures the Claude authoring sequence, and setup/workflow docs (`npm link`).

**Architecture:** `pipeline init <dir>` copies two template files from the repo (`templates/CLAUDE.md`, `templates/skills/element-author/SKILL.md`) into a new project folder (`CLAUDE.md` + `.claude/skills/element-author/SKILL.md`). Running Claude Code from that folder auto-loads the context and makes the skill available. The skill drives: gather inputs → ensure/read style-lock → compose prompt via a director skill → write the canonical prompt → `pipeline verify` → `pipeline element sheet`. All hard enforcement already lives in the pipeline (Plan A).

**Tech Stack:** Node.js (ESM, `node:test`, `node:fs/promises`), building on Plan A's `pipeline verify`, canonical prompt paths, and sheet-instance model.

**Depends on:** Plan A (`docs/superpowers/plans/2026-07-24-prompt-authoring-core.md`), merged. Spec: `docs/superpowers/specs/2026-07-24-prompt-authoring-workflow-design.md`.

---

## File structure

- **Create `templates/CLAUDE.md`** — project-context template (intro, style bible, workflow pointer, command quick-reference).
- **Create `templates/skills/element-author/SKILL.md`** — the authoring skill (frontmatter + procedure).
- **Create `src/init.js`** — `initProject(targetDir)`: refuse a non-empty dir, then copy the two templates into place. Locates templates relative to its own module path.
- **Modify `bin/pipeline.js`** — add the `init <dir>` command (positional dir arg).
- **Modify `README.md`** — `npm link` setup, the `init` step, and the authoring workflow; refresh the CLI usage to the Plan-A shape (`--id`, `--prompt-file`, `verify`).
- **Test:** `test/init.test.js`.

---

## Task 1: Templates (CLAUDE.md + element-author skill)

**Files:**
- Create: `templates/CLAUDE.md`
- Create: `templates/skills/element-author/SKILL.md`

These are content files (no test); Task 2's `initProject` copies them and its test asserts they land.

- [ ] **Step 1: Create `templates/CLAUDE.md`**

```markdown
# Animation Project

<!-- One line: what this project is (the story/world, the register, the goal). -->

## Style bible

<!-- Persistent stylistic concepts for THIS project. Fill this in and keep it
     current — it's the shared context auto-loaded into every session. Examples:
     overall art style and register, colour language, tone, recurring motifs,
     a short do / don't list. The element-author skill and the director skills
     read this as background when composing prompts. -->

## How to work here

This is an animation project driven by the 2d-animation pipeline. To create or
iterate on a character/prop/scene sheet, use the **element-author** skill (in
`.claude/skills/element-author/`). It gathers the inputs, reads the element's
`style-lock.yaml`, invokes the right director skill to compose a detailed prompt,
iterates with you, verifies the inputs (`pipeline verify`), and runs generation.

Element and shot data live here under `elements/` and `shots/` (created by the
pipeline). Put a character's reference drawing in its
`inputs/reference-images/` folder before authoring.

## Command quick-reference

- `pipeline element create --type <characters|props|scenes|other> --name <name>`
- `pipeline element sheet --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> --model <m> [--prompt-file <f>] [--image <f> ...]`
- `pipeline verify element --type <t> --name <n> --sheet <s> --id <slug> [--image <f> ...]`
- `pipeline shot create --id <shotId>` · `pipeline shot draft --id <shotId>` · `pipeline shot generate --id <shotId> --version <n> --model <m> [--prompt-file <f>]`
- Credit cost draws from your Higgsfield account — check `higgsfield account transactions`.
```

- [ ] **Step 2: Create `templates/skills/element-author/SKILL.md`**

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add templates/CLAUDE.md templates/skills/element-author/SKILL.md
git commit -m "feat: add CLAUDE.md and element-author skill templates"
```

---

## Task 2: `initProject` (scaffolding logic)

**Files:**
- Create: `src/init.js`
- Test: `test/init.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/init.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/init.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'init-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('initProject scaffolds CLAUDE.md and the element-author skill', async () => {
  await withTemp(async (base) => {
    const target = path.join(base, 'proj');
    const res = await initProject(target);
    assert.equal(res.dir, target);
    const claude = await readFile(path.join(target, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /Style bible/);
    const skill = await readFile(
      path.join(target, '.claude', 'skills', 'element-author', 'SKILL.md'), 'utf8');
    assert.match(skill, /name: element-author/);
    assert.ok((await stat(path.join(target, '.claude', 'skills', 'element-author', 'SKILL.md'))).isFile());
  });
});

test('initProject creates a missing target dir but refuses a non-empty one', async () => {
  await withTemp(async (base) => {
    // base itself is empty here except when we add a file:
    await writeFile(path.join(base, 'existing.txt'), 'x');
    await assert.rejects(() => initProject(base), /non-empty/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/init.test.js`
Expected: FAIL — cannot find module `../src/init.js`.

- [ ] **Step 3: Implement**

Create `src/init.js`:

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

// Scaffold a new project folder: CLAUDE.md + the element-author skill.
export async function initProject(targetDir) {
  const dir = path.resolve(targetDir);
  if (!(await emptyOrMissing(dir))) {
    throw new Error(`refusing to init a non-empty directory: ${dir}`);
  }
  await mkdir(dir, { recursive: true });

  const claudeMd = await readFile(path.join(TEMPLATES, 'CLAUDE.md'), 'utf8');
  await writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);

  const skillDir = path.join(dir, '.claude', 'skills', 'element-author');
  await mkdir(skillDir, { recursive: true });
  const skillMd = await readFile(path.join(TEMPLATES, 'skills', 'element-author', 'SKILL.md'), 'utf8');
  await writeFile(path.join(skillDir, 'SKILL.md'), skillMd);

  return { dir, files: ['CLAUDE.md', '.claude/skills/element-author/SKILL.md'] };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/init.test.js`
Expected: PASS — both tests green.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/init.js test/init.test.js
git commit -m "feat: add initProject scaffolding (CLAUDE.md + element-author skill)"
```

---

## Task 3: `pipeline init` command

**Files:**
- Modify: `bin/pipeline.js`

- [ ] **Step 1: Import `initProject`**

At the top of `bin/pipeline.js`, add with the other imports:

```js
import { initProject } from '../src/init.js';
```

- [ ] **Step 2: Add the `init` branch**

Add a new `else if` branch inside `main()`, immediately before the final `else` (usage block). Note `init` takes a positional directory as `sub`:

```js
  } else if (cmd === 'init') {
    const target = sub;
    if (!target) fail('usage: pipeline init <dir>');
    const res = await initProject(target);
    console.log(`initialized project: ${res.dir}`);
    for (const file of res.files) console.log(`  + ${file}`);
    console.log('next: cd into it, run `claude`, then use the element-author skill.');
  }
```

- [ ] **Step 3: Add `init` to the usage block**

In the final `fail([...])` usage array, add as the first command line (before `element create`):

```js
      '  pipeline init <dir>                        # scaffold a new project folder',
```

- [ ] **Step 4: Smoke-test (no credits)**

Run:
```bash
rm -rf /tmp/pinit && node bin/pipeline.js init /tmp/pinit
ls -R /tmp/pinit && rm -rf /tmp/pinit
```
Expected: prints `initialized project: /tmp/pinit`, `+ CLAUDE.md`, `+ .claude/skills/element-author/SKILL.md`; the `ls -R` shows both files.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bin/pipeline.js
git commit -m "feat: add pipeline init command to scaffold a project"
```

---

## Task 4: Setup & workflow docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current README**

Run: `cat README.md` — note the existing `## Setup`, `## Usage`, and `## Example` sections (they predate Plan A's `--id`/`verify`/`init`).

- [ ] **Step 2: Update the Setup section**

Replace the `## Setup` section's setup command block so the one-time global link and project init are documented. Ensure it contains exactly these commands in order (keep any surrounding prose that still applies; the key change is adding `npm link` and `pipeline init`):

```bash
npm install                              # installs the Higgsfield CLI locally + deps
npm link                                 # one-time: put `pipeline` on your PATH (symlinks the bin)
npm run higgsfield -- auth login         # browser OAuth; session persists
npm run higgsfield -- workspace list     # find your workspace id
npm run higgsfield -- workspace set <id> # REQUIRED: selects the billing workspace
npm run check-auth                       # preflight: auth + workspace + Claude access

pipeline init ~/anim/my-project          # scaffold a project folder (CLAUDE.md + skill)
cd ~/anim/my-project                      # run Claude Code from here so CLAUDE.md auto-loads
```

- [ ] **Step 3: Replace the Usage command list**

Replace the fenced command list under `## Usage` with the Plan-A shape:

```
pipeline init <dir>
pipeline element create --type <characters|props|scenes|other> --name <name>
pipeline element sheet  --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> --model <m> [--prompt-file <f> | --prompt <p>] [--image <file> ...]
pipeline verify element --type <t> --name <n> --sheet <s> --id <slug> [--image <file> ...]
pipeline shot create    --id <shotId> [--duration <s>] [--mode <m>] [--description <d>]
pipeline shot draft     --id <shotId>
pipeline shot generate  --id <shotId> --version <n> --model <m> [--prompt-file <f> | --prompt <p>] [--image <file> ...]
pipeline verify shot    --id <shotId> --version <n>
pipeline shot promote   --id <shotId> --version <n> --output <file>
```

- [ ] **Step 4: Replace the Example section**

Replace the `## Example` section body with the skill-driven authoring flow:

```markdown
The prompt-authoring happens in Claude Code via the **element-author** skill; the
pipeline generates and preserves the result.

```bash
# From your project folder (CLAUDE.md auto-loaded):
pipeline element create --type characters --name cecilia
cp ~/Downloads/cecilia-drawing.png elements/characters/cecilia/inputs/reference-images/ref.png
```

Then, in Claude Code: *"use element-author to make a turnaround for cecilia from
that reference."* The skill authors `style-lock.yaml`, composes the detailed
prompt (a real multi-angle turnaround, not a single figure), writes it to
`sheets/turnaround/<slug>/prompt.md`, runs `pipeline verify`, and then:

```bash
pipeline element sheet --type characters --name cecilia --sheet turnaround --id default --model nano_banana \
  --image elements/characters/cecilia/inputs/reference-images/ref.png
# -> saved v001: .../sheets/turnaround/default/v001.png
```

Iterate (new version under the same slug) or start another instance
(`--id summer-outfit`). Chain a finished sheet as an `--image` reference for pose
sheets. Each render keeps its exact prompt in `vNNN.prompt.md`.
```

- [ ] **Step 5: Verify the README renders sensibly**

Run: `node -e "process.stdout.write(require('node:fs').readFileSync('README.md','utf8').slice(0,1))"` (sanity that the file is readable) and visually skim `README.md` — confirm no leftover references to `element sheet` without `--id`.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document npm link, pipeline init, and the element-author workflow"
```

---

## Self-review

- **Spec coverage:** `pipeline init` scaffolds dir + `CLAUDE.md` + skill, refuses non-empty (Task 2, 3) ✓; `CLAUDE.md` template with style-bible + workflow pointer + command ref (Task 1) ✓; `element-author` skill encoding the gather→style-lock→compose→write→verify→generate sequence, wired in by init (Task 1, 2) ✓; `npm link` + per-project session model documented (Task 4) ✓. Hard preconditions, `verify`, canonical paths, sheet-instance model all delivered in Plan A (correctly not re-done here).
- **Placeholder scan:** template files contain intentional `<!-- fill in -->` authoring placeholders (that is their purpose, not plan placeholders); every implementation step has complete content/code. No "TBD"/"add X"/"similar to".
- **Type consistency:** `initProject(targetDir)` returns `{ dir, files }`, consumed with those fields in `bin` and the test. Template paths written by `initProject` (`CLAUDE.md`, `.claude/skills/element-author/SKILL.md`) match what the test reads and what `bin` prints. The skill/`CLAUDE.md` command examples match the Plan-A CLI shape (`--id`, `--prompt-file`, `verify`).

---

## Note on the templates directory

`templates/` is tooling (committed to the repo), not user data — it must NOT be caught by the `elements/`/`shots/` gitignore rules (it isn't; those rules are path-specific). The `.claude/skills/...` files are written into the *user's project* dir by `init`, not into this repo.
