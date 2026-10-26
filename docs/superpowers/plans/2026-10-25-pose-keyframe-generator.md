# Pose Keyframe Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a thin `pipeline image edit` command (fal `/edit`) and a `pose-keyframe-author` skill that uses it to generate one pose still for a character from a reference frame + text pose.

**Architecture:** `image edit` mirrors `image upscale` (`src/upscale-image.js`): a standalone core (`src/image-edit.js`) that uploads reference image(s), submits via the injected runner through `runBatch`, and downloads one result — no element/credit bookkeeping. The runner is chosen by the existing `pickImageRunner` (default fal). The skill composes the pose-edit prompt from the character's `style_stack` + the shot-gen framing/no-props language and calls the command.

**Tech Stack:** Node ESM, `node:test`, the `createFalImageRunner` added in #168, `runBatch`, `downloadTo`.

**Spec:** `docs/superpowers/specs/2026-10-25-pose-keyframe-generator-design.md`

## Global Constraints

- Default model `nano_banana_2_lite`; default runner `fal` (`createFalImageRunner` `/edit`). `FAL_KEY` from the env.
- fal endpoint slugs stay in `FAL_IMAGE_ENDPOINTS` (`src/fal.js`) — the single place to adjust.
- `image edit` does no element/credit logging (standalone, like `image upscale`).
- Skills live in `templates/skills/` and reach projects via `pipeline sync-skills`.

## Review Focus

- **No `--image` given:** `image edit` must error (an edit needs a reference), not silently fall back to text-to-image. → Task 1 test.
- **Neither `--prompt` nor `--prompt-file`:** must error with a clear message. → Task 1 test.
- **Runner returns a non-completed result** (status `error`/no `outputUrl`): surface it as a thrown error, do not write a 0-byte file. → Task 1 test.
- **Repeated `--image` refs:** all are uploaded and passed as `imageReferences`. → Task 1 test.
- **Output versioning:** a second edit into the same `--out` for the same input does not overwrite the first. → Task 1 test.

---

### Task 1: `editImage` core + tests

**Files:**
- Create: `src/image-edit.js`
- Test: `test/image-edit.test.js`

**Interfaces:**
- Consumes: `createFalImageRunner` (`src/fal.js`); `runBatch(runner, requests)` (`src/batch.js`) → `[{ id, status, outputUrl, error }]`; `downloadTo(url, path)` (`src/download.js`).
- Produces: `export async function editImage(root, spec, deps = {}) -> { outputPath, jobId }`
  - `spec`: `{ images: string[], prompt?: string, promptFile?: string, out?: string, model?: string }`
  - `deps`: `{ runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo }`
  - `export const IMAGE_EDIT_DEFAULT_MODEL = 'nano_banana_2_lite'`

- [ ] **Step 1: Write the failing tests** in `test/image-edit.test.js` (inject a fake runner whose `generate` records opts and whose `runBatch` is stubbed, or pass a fake `runBatch`; fake `downloadTo` records the write):
  - `test('uploads each ref, submits prompt + imageReferences, downloads the result')` — two `images`, `prompt:'raise a fist'`; assert the request `opts.prompt` and `opts.imageReferences` (uploaded ids, both), and that `downloadTo` is called with the result url → returns `{ outputPath }`.
  - `test('reads promptFile when prompt is absent')` — writes a temp prompt file, asserts its text is the submitted prompt.
  - `test('throws when no images are given')` — `images: []` rejects with /image/.
  - `test('throws when neither prompt nor promptFile is given')` — rejects with /prompt/.
  - `test('throws when the runner result is not completed')` — fake runBatch → `[{ status:'error', outputUrl:null }]`; rejects, and `downloadTo` not called.
  - `test('versions the output, no overwrite')` — with an existing `<stem>-edit-v01.png` in `out`, the next call targets `-v02.png`.

- [ ] **Step 2: Run to verify they fail** — `node --test test/image-edit.test.js` → FAIL (module/export missing).

- [ ] **Step 3: Implement `editImage` in `src/image-edit.js`** — resolve prompt text (`spec.prompt` or read `spec.promptFile`, else throw); throw if `images` empty; upload each via `runner.upload` → ids; `opts = { prompt, imageReferences: ids }`; `out` dir defaults to the first image's dir; output path `<out>/<first-stem>-edit-v<NN>.png`, NN = next free version (scan existing `*-edit-v*.png`); `const [result] = await runBatch(runner, [{ ref: stem, model: spec.model || IMAGE_EDIT_DEFAULT_MODEL, opts }])`; if `result.status !== 'completed' || !result.outputUrl` throw with the error; else `downloadTo(result.outputUrl, outputPath)`; return `{ outputPath, jobId: result.id }`.

- [ ] **Step 4: Run to verify they pass** — `node --test test/image-edit.test.js` → PASS.

- [ ] **Step 5: Commit** — `git add src/image-edit.js test/image-edit.test.js && git commit -m "feat(image): editImage core — single-image edit via a runner"`

---

### Task 2: `pipeline image edit` CLI wiring + docs

**Files:**
- Modify: `bin/pipeline.js` (import `editImage`; add `cmd === 'image' && sub === 'edit'` handler beside `image upscale` ~line 445; add a help line ~660)
- Modify: `templates/CLAUDE.md` (command quick-reference)

**Interfaces:**
- Consumes: `editImage` (Task 1); `pickImageRunner(f)` (already in `bin/pipeline.js`, default higgsfield) — call with an fal default here: pass `{ ...f, runner: f.runner || 'fal' }` so `image edit` defaults to fal per the spec while still honoring `--runner higgsfield`.

- [ ] **Step 1: Add the handler** — on `cmd === 'image' && sub === 'edit'`: parse flags; `fail(usage)` if no `--image` (`collectFlag(rest,'image')` empty) or if neither `--prompt` nor `--prompt-file`; call `editImage(projectRoot(f.root), { images: collectFlag(rest,'image'), prompt: f.prompt, promptFile: f['prompt-file'], out: f.out, model: f.model }, { runner: pickImageRunner({ ...f, runner: f.runner || 'fal' }) })`; `console.log` the output path. Usage string: `pipeline image edit --image <ref> [--image <ref> ...] (--prompt <p> | --prompt-file <f>) [--out <dir>] [--model nano_banana_2_lite] [--runner fal|higgsfield] [--root <dir>]`.

- [ ] **Step 2: Add the help-text line** near the other `image` commands (~line 660).

- [ ] **Step 3: Verify the CLI parses** — `node bin/pipeline.js image edit` → prints the usage (exit non-zero); `node bin/pipeline.js image edit --image x.png` → usage mentioning `--prompt` (missing prompt).

- [ ] **Step 4: Add the `templates/CLAUDE.md` entry** under the command quick-reference: one line describing `pipeline image edit` (ref + prompt → one edited image; `--runner fal` default, needs `FAL_KEY`).

- [ ] **Step 5: Run the full suite** — `node --test` → PASS (no regressions).

- [ ] **Step 6: Commit** — `git add bin/pipeline.js templates/CLAUDE.md && git commit -m "feat(image): pipeline image edit command (fal /edit default)"`

---

### Task 3: `pose-keyframe-author` skill + targeted-edit pointer

**Files:**
- Create: `templates/skills/pose-keyframe-author/SKILL.md`
- Modify: `templates/skills/targeted-edit-author/SKILL.md` (pointer to the new skill in the keyframe-pose section)

**Interfaces:**
- Consumes: `pipeline image edit` (Task 2); `readStyleLock` concept (the element's `style-lock.yaml` `style_stack`); the framing/orientation + no-props language from `src/edit-ui/trim-prompt.js` / `targeted-edit-author`.

- [ ] **Step 1: Write `SKILL.md`** with frontmatter (`name: pose-keyframe-author`, a `description` covering: generate a single pose still for a character from a reference frame + text pose, for use as a targeted-edit middle keyframe or standalone). Body sections:
  - **Inputs:** character element name (→ `elements/<type>/<name>/style-lock.yaml` `style_stack`), a reference frame (character at the target framing), the pose text.
  - **Compose the prompt:** `style_stack` (design + art style) + "match the reference image's EXACT framing, scale, position and orientation; change ONLY the pose to `<pose>`; keep the same design and art style" + the no-props guard. Re-tense the framing/orientation blocks from `targeted-edit-author` for a single still (no "across the clip"/lip-sync lines).
  - **Generate:** `pipeline image edit --image <frame> --prompt-file <composed> --runner fal` → the pose still; report the path.
  - **Use:** drop the still into a targeted edit as `@Image2` (keyframe-pose variant), or use standalone.

- [ ] **Step 2: Add the pointer** in `targeted-edit-author/SKILL.md` (the "Two variants … Keyframe pose" section): to *generate* a pose keyframe (instead of matting one), use the `pose-keyframe-author` skill.

- [ ] **Step 3: Verify** — `node --test` still green (docs-only change); confirm the new SKILL.md has valid frontmatter (`name`/`description` present).

- [ ] **Step 4: Commit** — `git add templates/skills/pose-keyframe-author/SKILL.md templates/skills/targeted-edit-author/SKILL.md && git commit -m "feat(skill): pose-keyframe-author (generate a pose keyframe via image edit)"`
