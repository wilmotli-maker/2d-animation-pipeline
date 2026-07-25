# Prompt-Authoring Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure element sheets into slug-identified instances with versions, add file-based prompt resolution, and introduce a single shared validator used both to hard-enforce generation preconditions and to power a zero-credit `pipeline verify` command.

**Architecture:** One validation module (`src/validate.js`) is the single source of truth: it resolves the prompt (precedence `--prompt` > `--prompt-file` > canonical path) and produces a ✓/⚠/✗ checklist. The generate ops call it and abort on any hard failure; the new `verify` command calls it and prints the checklist. Sheets move from `sheets/<type>/vNNN.png` to `sheets/<type>/<slug>/vNNN.png` + per-version `vNNN.prompt.md` snapshots.

**Tech Stack:** Node.js (ESM, `node:test`, `node:fs/promises`, `yaml`), building on `src/{config,paths,element,generate,cli,batch,download}.js` and `bin/pipeline.js`.

**Scope:** This is Plan A of two. Plan B (the authoring layer: `pipeline init`, `CLAUDE.md` template, the `element-author` skill, `npm link` docs) builds on the `verify` command and canonical paths delivered here. Spec: `docs/superpowers/specs/2026-07-24-prompt-authoring-workflow-design.md`.

---

## File structure

- **Modify `src/paths.js`** — add `sheetInstanceDir` and `sheetPromptPath` (the slug layer + canonical prompt path). `sheetDir` (the type dir) stays.
- **Create `src/validate.js`** — `SLUG_RE`, `resolvePrompt`, `validateElementSheet`, `validateShotGenerate`. The single source of truth for prompt resolution + preconditions. Returns structured checklists; never calls the API.
- **Modify `src/generate.js`** — `generateElementSheet` rewritten to the sheet-instance model, calling `validateElementSheet` (throw on fail, warn on ⚠) and snapshotting the prompt per version; `generateShotDraft` resolves its prompt from the canonical draft path via `validateShotGenerate`.
- **Modify `bin/pipeline.js`** — `element sheet` gains required `--id` and `--prompt-file`; `shot generate` gains `--prompt-file`; new `verify` command prints the checklist and sets the exit code.
- **Tests:** `test/paths.test.js` (additions), `test/validate.test.js` (new), `test/generate.test.js` (updated).

Naming used consistently across tasks: sheet **type** = `turnaround|pose|cycles`; sheet **id**/**slug** = the instance id; **version** = `vNNN` within an instance.

---

## Task 1: Sheet-instance path builders

**Files:**
- Modify: `src/paths.js`
- Test: `test/paths.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `test/paths.test.js`:

```js
test('sheetInstanceDir nests a slug under the sheet type', () => {
  assert.equal(p.sheetInstanceDir(ROOT, 'characters', 'cecilia', 'turnaround', 'winter-outfit'),
    '/tmp/root/elements/characters/cecilia/sheets/turnaround/winter-outfit');
});

test('sheetPromptPath is the canonical prompt.md inside the instance', () => {
  assert.equal(p.sheetPromptPath(ROOT, 'characters', 'cecilia', 'turnaround', 'winter-outfit'),
    '/tmp/root/elements/characters/cecilia/sheets/turnaround/winter-outfit/prompt.md');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/paths.test.js`
Expected: FAIL — `p.sheetInstanceDir is not a function`.

- [ ] **Step 3: Implement**

In `src/paths.js`, add after the existing `sheetDir` function (line ~21):

```js
export function sheetInstanceDir(root, type, name, sheetType, slug) {
  return path.join(sheetDir(root, type, name, sheetType), slug);
}
export function sheetPromptPath(root, type, name, sheetType, slug) {
  return path.join(sheetInstanceDir(root, type, name, sheetType, slug), 'prompt.md');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/paths.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths.js test/paths.test.js
git commit -m "feat: add sheet-instance path builders (slug layer + canonical prompt)"
```

---

## Task 2: Shared validator (`src/validate.js`)

**Files:**
- Create: `src/validate.js`
- Test: `test/validate.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/validate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement, writeStyleLock } from '../src/element.js';
import { sheetPromptPath } from '../src/paths.js';
import { SLUG_RE, resolvePrompt, validateElementSheet } from '../src/validate.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'val-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('SLUG_RE accepts kebab slugs and rejects unsafe ones', () => {
  for (const ok of ['winter-outfit', 'a', 'combat-stances', 'v2']) assert.ok(SLUG_RE.test(ok), ok);
  for (const bad of ['', 'Winter', 'a b', 'a/b', '-lead', '..']) assert.ok(!SLUG_RE.test(bad), bad);
});

test('resolvePrompt: inline wins, both is an error, empty is an error', async () => {
  assert.equal((await resolvePrompt({ prompt: 'hi' })).text, 'hi');
  assert.match((await resolvePrompt({ prompt: 'a', promptFile: '/x' })).error, /only one/i);
  assert.match((await resolvePrompt({ prompt: '   ' })).error, /empty/i);
  assert.match((await resolvePrompt({ canonicalPath: '/nope/prompt.md' })).error, /not found/i);
});

test('resolvePrompt reads a file when no inline prompt is given', async () => {
  await withTemp(async (dir) => {
    const f = path.join(dir, 'prompt.md');
    await writeFile(f, 'detailed prompt');
    assert.equal((await resolvePrompt({ canonicalPath: f })).text, 'detailed prompt');
    assert.equal((await resolvePrompt({ promptFile: f })).text, 'detailed prompt');
  });
});

test('validateElementSheet passes when element, slug, prompt, style-lock all present', async () => {
  await withTemp(async (root) => {
    await createElement(root, { type: 'characters', name: 'cecilia' });
    await writeStyleLock(root, 'characters', 'cecilia', { palette: ['#f00'] });
    await writeFile(sheetPromptPath(root, 'characters', 'cecilia', 'turnaround', 'winter'), 'a prompt');
    const r = await validateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'turnaround', id: 'winter', images: [],
    });
    assert.equal(r.ok, true);
    assert.equal(r.promptText, 'a prompt');
    assert.ok(r.checks.every((c) => c.status !== 'fail'));
  });
});

test('validateElementSheet fails on missing element, bad slug, missing prompt', async () => {
  await withTemp(async (root) => {
    const r = await validateElementSheet(root, {
      type: 'characters', name: 'ghost', sheet: 'turnaround', id: 'Bad Slug', images: [],
    });
    assert.equal(r.ok, false);
    const failed = r.checks.filter((c) => c.status === 'fail').map((c) => c.label);
    assert.ok(failed.includes('element exists'));
    assert.ok(failed.includes('sheet id valid'));
    assert.ok(failed.includes('prompt present'));
  });
});

test('validateElementSheet warns (not fails) when style-lock is absent', async () => {
  await withTemp(async (root) => {
    await createElement(root, { type: 'characters', name: 'nolock' });
    await writeFile(sheetPromptPath(root, 'characters', 'nolock', 'turnaround', 'a'), 'p');
    const r = await validateElementSheet(root, {
      type: 'characters', name: 'nolock', sheet: 'turnaround', id: 'a', images: [],
    });
    assert.equal(r.ok, true);
    const sl = r.checks.find((c) => c.label === 'style-lock present');
    assert.equal(sl.status, 'warn');
  });
});

test('validateElementSheet fails when a referenced image is missing', async () => {
  await withTemp(async (root) => {
    await createElement(root, { type: 'characters', name: 'cecilia' });
    await writeFile(sheetPromptPath(root, 'characters', 'cecilia', 'turnaround', 'a'), 'p');
    const r = await validateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'turnaround', id: 'a',
      images: ['/does/not/exist.png'],
    });
    assert.equal(r.ok, false);
    assert.ok(r.checks.some((c) => c.label === 'reference image' && c.status === 'fail'));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/validate.test.js`
Expected: FAIL — cannot find module `../src/validate.js`.

- [ ] **Step 3: Implement**

Create `src/validate.js`:

```js
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import YAML from 'yaml';
import { SHEET_TYPES } from './element.js';
import { elementDir, styleLockPath, sheetPromptPath } from './paths.js';

// Filesystem-safe, human-readable sheet-instance slug.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

// Prompt source precedence: at most one of prompt/promptFile; else canonicalPath.
// Returns { text } on success or { error } — never throws for expected cases.
export async function resolvePrompt({ prompt, promptFile, canonicalPath } = {}) {
  if (prompt != null && promptFile != null) {
    return { error: 'pass only one of --prompt or --prompt-file' };
  }
  if (prompt != null) {
    return prompt.trim() ? { text: prompt } : { error: 'prompt is empty' };
  }
  const file = promptFile ?? canonicalPath;
  if (!file) return { error: 'no prompt provided (use --prompt, --prompt-file, or the canonical prompt.md)' };
  try {
    const text = await readFile(file, 'utf8');
    return text.trim() ? { text, file } : { error: `prompt file is empty: ${file}` };
  } catch (err) {
    if (err.code === 'ENOENT') return { error: `prompt file not found: ${file}` };
    return { error: `cannot read prompt file ${file}: ${err.message}` };
  }
}

// Validate everything needed to generate an element sheet. Returns a checklist
// plus the resolved prompt text. ok === no 'fail' checks (warns are allowed).
export async function validateElementSheet(root, { type, name, sheet, id, prompt, promptFile, images = [] }) {
  const checks = [];
  const add = (label, status, detail) => checks.push({ label, status, detail });

  add('element exists', (await exists(elementDir(root, type, name))) ? 'pass' : 'fail', `${type}/${name}`);
  add('sheet type valid', SHEET_TYPES.includes(sheet) ? 'pass' : 'fail', String(sheet));
  const slugOk = typeof id === 'string' && SLUG_RE.test(id);
  add('sheet id valid', slugOk ? 'pass' : 'fail', id ? String(id) : '(missing)');

  const canonicalPath = (slugOk && SHEET_TYPES.includes(sheet))
    ? sheetPromptPath(root, type, name, sheet, id) : null;
  const pr = await resolvePrompt({ prompt, promptFile, canonicalPath });
  let promptText = null;
  if (pr.error) add('prompt present', 'fail', pr.error);
  else { promptText = pr.text; add('prompt present', 'pass', pr.file ? `from ${pr.file}` : 'inline'); }

  const slPath = styleLockPath(root, type, name);
  if (!(await exists(slPath))) {
    add('style-lock present', 'warn', 'no style-lock.yaml — the look may drift');
  } else {
    try { YAML.parse(await readFile(slPath, 'utf8')); add('style-lock present', 'pass', slPath); }
    catch (err) { add('style-lock present', 'fail', `style-lock.yaml is unparseable: ${err.message}`); }
  }

  for (const img of images) {
    add('reference image', (await exists(img)) ? 'pass' : 'fail', img);
  }

  const ok = checks.every((c) => c.status !== 'fail');
  return { checks, ok, promptText };
}

// Validate an existing shot draft before generating its output.
export async function validateShotGenerate(root, { shotId, version, prompt, promptFile, images = [] }, deps = {}) {
  // deps.canonicalPath lets generate.js pass the draft's prompt.md path (avoids a
  // paths import cycle for the shot-draft layout, which generate.js already knows).
  const checks = [];
  const add = (label, status, detail) => checks.push({ label, status, detail });

  const pr = await resolvePrompt({ prompt, promptFile, canonicalPath: deps.canonicalPath });
  let promptText = null;
  if (pr.error) add('prompt present', 'fail', pr.error);
  else { promptText = pr.text; add('prompt present', 'pass', pr.file ? `from ${pr.file}` : 'inline'); }

  for (const img of images) {
    add('reference image', (await exists(img)) ? 'pass' : 'fail', img);
  }

  const ok = checks.every((c) => c.status !== 'fail');
  return { checks, ok, promptText };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/validate.test.js`
Expected: PASS — all seven tests green.

- [ ] **Step 5: Commit**

```bash
git add src/validate.js test/validate.test.js
git commit -m "feat: add shared validator (prompt resolution + element/shot checks)"
```

---

## Task 3: Rewrite `generateElementSheet` to the sheet-instance model

**Files:**
- Modify: `src/generate.js`
- Test: `test/generate.test.js`

- [ ] **Step 1: Update the tests**

Replace the entire contents of `test/generate.test.js` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement, writeStyleLock } from '../src/element.js';
import { createShot, newDraft } from '../src/shot.js';
import { sheetPromptPath } from '../src/paths.js';
import { generateElementSheet, generateShotDraft } from '../src/generate.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gen-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// Deps double: batch returns a completed job; download writes a marker file.
function deps() {
  const downloaded = [];
  return {
    downloaded,
    runBatch: async (_runner, requests) => {
      deps._lastRequest = requests[0];
      return requests.map((r) => ({ ref: r.ref, id: 'job_1', status: 'completed',
        outputUrl: 'https://cdn/job_1.png' }));
    },
    downloadTo: async (url, dest) => {
      downloaded.push({ url, dest });
      const { mkdir, writeFile: wf } = await import('node:fs/promises');
      await mkdir(path.dirname(dest), { recursive: true });
      await wf(dest, 'BYTES');
      return dest;
    },
  };
}

// Helper: a ready-to-generate element with style-lock + canonical prompt.
async function seedElement(root, name, sheet, id, promptText = 'a detailed prompt') {
  await createElement(root, { type: 'characters', name });
  await writeStyleLock(root, 'characters', name, { palette: ['#f00'] });
  await writeFile(sheetPromptPath(root, 'characters', name, sheet, id), promptText);
}

test('generateElementSheet saves output under sheets/<type>/<slug>/vNNN and logs it', async () => {
  await withTemp(async (root) => {
    await seedElement(root, 'cecilia', 'turnaround', 'winter');
    const d = deps();
    const res = await generateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'turnaround', id: 'winter', model: 'nano_banana',
    }, { runner: {}, ...d });

    assert.match(res.outputPath, /sheets\/turnaround\/winter\/v001\.png$/);
    assert.equal(res.sheetId, 'winter');
    assert.ok((await stat(res.outputPath)).isFile());

    // Per-version prompt snapshot exists with the exact prompt.
    const snap = path.join(path.dirname(res.outputPath), 'v001.prompt.md');
    assert.equal(await readFile(snap, 'utf8'), 'a detailed prompt');

    const log = JSON.parse(
      (await readFile(path.join(root, 'elements', 'characters', 'cecilia', 'generations.jsonl'), 'utf8')).trim());
    assert.equal(log.sheetType, 'turnaround');
    assert.equal(log.sheetId, 'winter');
    assert.equal(log.version, 'v001');
    assert.equal(log.jobId, 'job_1');
  });
});

test('generateElementSheet versions within an instance (reused slug -> v002)', async () => {
  await withTemp(async (root) => {
    await seedElement(root, 'cecilia', 'turnaround', 'winter');
    const d = deps();
    const spec = { type: 'characters', name: 'cecilia', sheet: 'turnaround', id: 'winter', model: 'nano_banana' };
    const a = await generateElementSheet(root, spec, { runner: {}, ...d });
    const b = await generateElementSheet(root, spec, { runner: {}, ...d });
    assert.match(a.outputPath, /winter\/v001\.png$/);
    assert.match(b.outputPath, /winter\/v002\.png$/);
  });
});

test('generateElementSheet resolves the canonical prompt and passes images', async () => {
  await withTemp(async (root) => {
    await seedElement(root, 'cecilia', 'pose', 'combat', 'pose prompt');
    const ref = path.join(root, 'ref.png');
    await writeFile(ref, 'x');
    const d = deps();
    await generateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'pose', id: 'combat', model: 'nano_banana',
      images: [ref],
    }, { runner: {}, ...d });
    assert.equal(deps._lastRequest.opts.prompt, 'pose prompt');
    assert.deepEqual(deps._lastRequest.opts.imageReferences, [ref]);
  });
});

test('generateElementSheet throws on a hard failure (missing element)', async () => {
  await withTemp(async (root) => {
    await assert.rejects(
      () => generateElementSheet(root, {
        type: 'characters', name: 'ghost', sheet: 'turnaround', id: 'x', model: 'nano_banana',
        prompt: 'p',
      }, { runner: {}, ...deps() }),
      /cannot generate.*element exists/i,
    );
  });
});

test('generateShotDraft reads the draft prompt.md and saves output', async () => {
  await withTemp(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    const { dir } = await newDraft(root, 's1');
    await writeFile(path.join(dir, 'prompt.md'), 'shot prompt');
    const d = deps();
    const res = await generateShotDraft(root, {
      shotId: 's1', version: 1, model: 'seedance_2_0_mini',
    }, { runner: {}, ...d });
    assert.equal(path.dirname(res.outputPath), dir);
    assert.match(res.outputPath, /drafts\/v001\/output\./);
    assert.equal(deps._lastRequest.opts.prompt, 'shot prompt');
  });
});

test('generateShotDraft throws when the draft prompt is empty', async () => {
  await withTemp(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    await newDraft(root, 's1'); // newDraft writes a comment-only stub prompt.md
    await writeFile(path.join(root, 'shots', 's1', 'drafts', 'v001', 'prompt.md'), '   ');
    await assert.rejects(
      () => generateShotDraft(root, { shotId: 's1', version: 1, model: 'm' }, { runner: {}, ...deps() }),
      /cannot generate.*empty/i,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/generate.test.js`
Expected: FAIL — the current `generateElementSheet` signature uses `sheet`/no `id`, so path/snapshot assertions fail.

- [ ] **Step 3: Rewrite `src/generate.js`**

Replace the entire contents of `src/generate.js` with:

```js
import path from 'node:path';
import { readdir, writeFile } from 'node:fs/promises';
import { runBatch as defaultRunBatch } from './batch.js';
import { downloadTo as defaultDownloadTo } from './download.js';
import { appendGeneration } from './element.js';
import { sheetInstanceDir, shotDraftDir } from './paths.js';
import { validateElementSheet, validateShotGenerate } from './validate.js';

// Highest vNNN in a directory (matches v001.png, v001.prompt.md, ...), + 1.
async function nextVersion(dir) {
  let entries = [];
  try { entries = await readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const nums = entries.map((e) => /^v(\d+)/.exec(e)).filter(Boolean).map((m) => Number(m[1]));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

function formatVersion(n) { return 'v' + String(n).padStart(3, '0'); }

function extFromUrl(url, fallback) {
  return path.extname(new URL(url).pathname) || fallback;
}

// Throw a clear error if validation has any hard failure; warn on any ⚠.
function enforce(v, what) {
  for (const c of v.checks) if (c.status === 'warn') console.warn(`warning: ${c.detail}`);
  if (!v.ok) {
    const fails = v.checks.filter((c) => c.status === 'fail').map((c) => `${c.label}: ${c.detail}`);
    throw new Error(`cannot generate ${what} — ${fails.join('; ')}`);
  }
}

export async function generateElementSheet(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
} = {}) {
  const { type, name, sheet, id, model, prompt, promptFile, images = [] } = spec;

  const v = await validateElementSheet(root, { type, name, sheet, id, prompt, promptFile, images });
  enforce(v, `${type}/${name} ${sheet}/${id}`);

  const opts = { prompt: v.promptText };
  if (images.length) opts.imageReferences = images;

  const [result] = await runBatch(runner, [{ ref: `${name}/${sheet}/${id}`, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    throw new Error(`generation for ${name}/${sheet}/${id} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  const dir = sheetInstanceDir(root, type, name, sheet, id);
  const vtag = formatVersion(await nextVersion(dir));
  const outputPath = path.join(dir, `${vtag}${extFromUrl(result.outputUrl, '.png')}`);
  await downloadTo(result.outputUrl, outputPath);
  await writeFile(path.join(dir, `${vtag}.prompt.md`), v.promptText);

  await appendGeneration(root, type, name, {
    sheetType: sheet, sheetId: id, version: vtag, model, jobId: result.id,
    prompt: v.promptText, promptFile: path.join(dir, `${vtag}.prompt.md`),
    imageReferences: images, output: outputPath, status: 'generated',
  });
  return { outputPath, jobId: result.id, version: vtag, sheetId: id };
}

export async function generateShotDraft(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
} = {}) {
  const { shotId, version, model, prompt, promptFile, images = [] } = spec;
  const dir = shotDraftDir(root, shotId, version);
  const canonicalPath = path.join(dir, 'prompt.md');

  // Existence of shot + draft is implied by the canonical prompt living in the
  // draft dir; validateShotGenerate reports a clear error if it's missing/empty.
  const v = await validateShotGenerate(root, { shotId, version, prompt, promptFile, images },
    { canonicalPath });
  enforce(v, `shot ${shotId} v${version}`);

  const opts = { prompt: v.promptText };
  if (images.length) opts.imageReferences = images;

  const [result] = await runBatch(runner, [{ ref: `${shotId}/v${version}`, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    throw new Error(`shot draft ${shotId} v${version} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  const outputPath = path.join(dir, `output${extFromUrl(result.outputUrl, '.mp4')}`);
  await downloadTo(result.outputUrl, outputPath);
  return { outputPath, jobId: result.id };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/generate.test.js`
Expected: PASS — all six tests green.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. (Sheet-instance change is isolated to generate.js + paths.js + validate.js; batch/download/cli/element/shot suites unaffected.)

- [ ] **Step 6: Commit**

```bash
git add src/generate.js test/generate.test.js
git commit -m "feat: sheet-instance generation with shared validation and per-version prompt snapshots"
```

---

## Task 4: CLI — `--id`, `--prompt-file`, and validation wiring

**Files:**
- Modify: `bin/pipeline.js`

- [ ] **Step 1: Update the `element sheet` command**

In `bin/pipeline.js`, replace the whole `element sheet` branch (the block starting `} else if (cmd === 'element' && sub === 'sheet') {`) with:

```js
  } else if (cmd === 'element' && sub === 'sheet') {
    const f = parseFlags(rest);
    if (!f.type || !f.name || !f.sheet || !f.id || !f.model) {
      fail('usage: pipeline element sheet --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> --model <m> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--root <dir>]');
    }
    const res = await generateElementSheet(projectRoot(f.root), {
      type: f.type, name: f.name, sheet: f.sheet, id: f.id, model: f.model,
      prompt: f.prompt, promptFile: f['prompt-file'], images: collectFlag(rest, 'image'),
    }, { runner: createRunner() });
    console.log(`saved ${res.version}: ${res.outputPath}`);
  }
```

- [ ] **Step 2: Update the `shot generate` command**

Replace the whole `shot generate` branch with:

```js
  } else if (cmd === 'shot' && sub === 'generate') {
    const f = parseFlags(rest);
    if (!f.id || !f.version || !f.model) {
      fail('usage: pipeline shot generate --id <shotId> --version <n> --model <m> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--root <dir>]');
    }
    const genVersion = Number(f.version);
    if (!Number.isInteger(genVersion) || genVersion < 1) {
      fail('shot generate: --version must be a positive integer');
    }
    const res = await generateShotDraft(projectRoot(f.root), {
      shotId: f.id, version: genVersion, model: f.model,
      prompt: f.prompt, promptFile: f['prompt-file'], images: collectFlag(rest, 'image'),
    }, { runner: createRunner() });
    console.log(`saved shot draft output: ${res.outputPath}`);
  }
```

- [ ] **Step 3: Update the usage block**

In the final `fail([...])` usage array, replace the two generate lines with:

```js
      '  pipeline element sheet --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> --model <m> [--prompt <p> | --prompt-file <file>] [--image <file> ...]',
      '  pipeline shot generate --id <shotId> --version <n> --model <m> [--prompt <p> | --prompt-file <file>] [--image <file> ...]',
```

- [ ] **Step 4: Smoke-test usage (no credits)**

Run: `node bin/pipeline.js element sheet --type characters --name x --sheet turnaround`
Expected: prints the usage line (missing `--id`/`--model`), exit 1.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (bin has no unit tests; this confirms nothing else broke).

- [ ] **Step 6: Commit**

```bash
git add bin/pipeline.js
git commit -m "feat: element sheet --id/--prompt-file and shot generate --prompt-file"
```

---

## Task 5: `pipeline verify` command

**Files:**
- Modify: `bin/pipeline.js`

- [ ] **Step 1: Import the validators**

At the top of `bin/pipeline.js`, add:

```js
import { validateElementSheet, validateShotGenerate } from '../src/validate.js';
import path from 'node:path';
import { shotDraftDir } from '../src/paths.js';
```

- [ ] **Step 2: Add a checklist printer and the `verify` command**

Add this helper near `fail` (top of file):

```js
// Print a ✓/⚠/✗ checklist and return true if there are no failures.
function printChecklist(result) {
  const mark = { pass: '✓', warn: '⚠', fail: '✗' };
  for (const c of result.checks) {
    console.log(`  ${mark[c.status] || '?'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(result.ok ? 'OK — inputs are valid.' : 'FAILED — fix the ✗ items above.');
  return result.ok;
}
```

Add a new `else if` branch inside `main()`, immediately before the final `else` (usage):

```js
  } else if (cmd === 'verify' && sub === 'element') {
    const f = parseFlags(rest);
    if (!f.type || !f.name || !f.sheet || !f.id) {
      fail('usage: pipeline verify element --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--root <dir>]');
    }
    const result = await validateElementSheet(projectRoot(f.root), {
      type: f.type, name: f.name, sheet: f.sheet, id: f.id,
      prompt: f.prompt, promptFile: f['prompt-file'], images: collectFlag(rest, 'image'),
    });
    if (!printChecklist(result)) process.exit(1);
  } else if (cmd === 'verify' && sub === 'shot') {
    const f = parseFlags(rest);
    if (!f.id || !f.version) {
      fail('usage: pipeline verify shot --id <shotId> --version <n> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--root <dir>]');
    }
    const root = projectRoot(f.root);
    const canonicalPath = path.join(shotDraftDir(root, f.id, Number(f.version)), 'prompt.md');
    const result = await validateShotGenerate(root, {
      shotId: f.id, version: Number(f.version),
      prompt: f.prompt, promptFile: f['prompt-file'], images: collectFlag(rest, 'image'),
    }, { canonicalPath });
    if (!printChecklist(result)) process.exit(1);
  }
```

- [ ] **Step 3: Add `verify` to the usage block**

In the final `fail([...])` usage array, add before the closing lines:

```js
      '  pipeline verify element --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> [--prompt <p> | --prompt-file <file>] [--image <file> ...]',
      '  pipeline verify shot --id <shotId> --version <n> [--prompt <p> | --prompt-file <file>] [--image <file> ...]',
```

- [ ] **Step 4: Smoke-test verify (no credits) against a real temp element**

Run:
```bash
node bin/pipeline.js element create --type characters --name vtest --root /tmp/pv
node bin/pipeline.js verify element --type characters --name vtest --sheet turnaround --id demo --prompt "hi" --root /tmp/pv; echo "exit=$?"
```
Expected: a checklist with `✓ element exists`, `✓ sheet id valid`, `✓ prompt present`, `⚠ style-lock present`, ending `OK`, `exit=0`. Then:
```bash
node bin/pipeline.js verify element --type characters --name vtest --sheet turnaround --id "Bad Id" --root /tmp/pv; echo "exit=$?"
rm -rf /tmp/pv
```
Expected: `✗ sheet id valid`, `✗ prompt present`, ending `FAILED`, `exit=1`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bin/pipeline.js
git commit -m "feat: add pipeline verify command (authoring-time validity checklist)"
```

---

## Self-review

- **Spec coverage:** two-level sheet model (Task 1, 3) ✓; slug id required + validated (Task 2 `SLUG_RE`, Task 4 `--id` required, Task 2/3 checks) ✓; implicit versioning within instance (Task 3 `nextVersion`) ✓; prompt source precedence + `--prompt-file` + canonical fallback (Task 2 `resolvePrompt`, Task 4) ✓; per-version prompt snapshot + `generations.jsonl` schema (Task 3) ✓; style-lock warns not blocks (Task 2 warn, Task 3 `enforce` warns) ✓; shared validator single source of truth used by generate + verify (Task 2, 3, 5) ✓; `verify` checklist + exit code (Task 5) ✓; zero-credit (all tests use fakes; verify never calls the API) ✓. **Deferred to Plan B (correctly out of scope here):** `pipeline init`, `CLAUDE.md` template, `element-author` skill, `npm link` docs.
- **Placeholder scan:** no TBD/TODO; every code step is complete; no "add validation"/"handle errors" hand-waves (validation is the concrete `validate.js`).
- **Type consistency:** `validateElementSheet`/`validateShotGenerate` return `{ checks, ok, promptText }` and are consumed with those fields in `generate.js` (`enforce`, `v.promptText`) and `bin` (`printChecklist`). `resolvePrompt` returns `{ text | error, file? }`, matched by callers. `sheetInstanceDir`/`sheetPromptPath` signatures `(root, type, name, sheetType, slug)` are identical across `paths.js`, `validate.js`, `generate.js`, and tests. CLI reads `f['prompt-file']` (parseFlags strips the leading `--`, key is `prompt-file`) consistently. Generate spec fields (`type,name,sheet,id,model,prompt,promptFile,images`) match between `bin`, `generate.js`, and tests.

---

## Migration note

`test-cecilia` uses the old flat `sheets/<type>/vNNN.png` layout. It's gitignored throwaway user data; the new layout applies going forward. No migration code (per spec).
