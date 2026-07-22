# Animation Pipeline Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic mechanics of the animation pipeline — element/shot scaffolding, style-lock and generation-log persistence, and a thin, testable wrapper over the Higgsfield CLI — as a Node library plus a `pipeline` CLI entrypoint.

**Architecture:** Plain-ESM Node modules with one clean seam: every unverified assumption about the Higgsfield CLI's behavior (job-output shape, exit codes, `--wait`) lives in `src/cli.js` + `src/jobresult.js`, which take an **injectable subprocess executor**. Everything is therefore unit-testable with a mock executor and costs **zero Higgsfield credits to build**. Pure path math is separated from disk I/O so it can be tested without a filesystem. The on-disk layout matches the `elements/` + `shots/` structure already specified in `animation-automation-handoff.md`.

**Tech Stack:** Node.js (ESM, `"type": "module"`), built-in `node:test` + `node:assert`, `node:fs/promises`, `node:child_process`, and the `yaml` package for style-lock/shot files. No build step.

**Scope note:** This plan delivers working, testable software on its own: a user can scaffold elements, persist style-lock data, log generations, invoke the CLI to produce artifacts, create shots, iterate low-res drafts, and promote/upscale a final. The **AI-in-the-loop layer** (Claude critiques output → decides regenerate, batch queue with concurrency, retry/backoff tuning) depends on sanity-check results still being gathered and is deferred to a follow-up plan — see the final section.

---

## Assumptions this plan isolates (pending sanity checks)

These are carried from `animation-automation-handoff.md` and are **not yet verified**. Each is confined to one module so a wrong guess is a one-file fix, not a rewrite:

| Assumption | Confined to | Confirmed by |
|---|---|---|
| Job submission stdout contains a parseable id | `src/jobresult.js` `parseJobId` | Sanity check 5 |
| Failed generation exits non-zero | `src/cli.js` `generate` error path | Sanity check 2 |
| `generate get <id>` returns retrievable result after exit | `src/cli.js` `get` | Sanity check 5 |
| Local file path in `--start-image` is auto-uploaded | `src/cli.js` arg building | Sanity check 5 |

When those checks land, adjust only the named module + its test. No task below calls the real API.

---

## File structure

```
package.json                 # add "type":"module", yaml dep, test script (Task 1)
src/
  config.js                  # repo root + higgsfield bin resolution, element-type constants
  paths.js                   # pure path builders (no I/O)
  jobresult.js               # parse CLI stdout -> job id / result (isolates output-shape assumption)
  cli.js                     # injectable subprocess wrapper over higgsfield
  element.js                 # element scaffolding + style-lock + generations log
  shot.js                    # shot scaffolding + draft iteration + promote-to-final
bin/
  pipeline.js                # CLI entrypoint dispatching to the modules above
test/
  paths.test.js
  jobresult.test.js
  cli.test.js
  element.test.js
  shot.test.js
docs/
  style-lock-schema.md       # field reference for style-lock.yaml (photoreal vs illustrated)
```

Responsibilities: `paths.js` is pure and holds the single source of truth for on-disk layout (DRY — every other module builds paths through it). `config.js` resolves environment-specific values (repo root, local CLI binary). `jobresult.js` + `cli.js` are the CLI seam. `element.js` / `shot.js` are the two domain entities. `bin/pipeline.js` is thin arg-parsing glue.

---

## Task 1: Project setup (ESM, test runner, yaml dependency)

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add ESM mode, the yaml dependency, and a test script**

Edit `package.json` so it reads exactly:

```json
{
  "name": "2d-animation-pipeline",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Local workspace for pipeline tooling. Dependencies (e.g. the Higgsfield CLI) install here, not globally.",
  "bin": {
    "pipeline": "bin/pipeline.js"
  },
  "scripts": {
    "higgsfield": "higgsfield",
    "check-auth": "bash scripts/check-auth.sh",
    "sanity:free": "bash scripts/sanity-checks/run-free-checks.sh",
    "test": "node --test",
    "pipeline": "node bin/pipeline.js"
  },
  "dependencies": {
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@higgsfield/cli": "^1.1.19"
  }
}
```

- [ ] **Step 2: Install the new dependency**

Run: `npm install`
Expected: `yaml` added, no errors, `node_modules/yaml` present.

- [ ] **Step 3: Verify the test runner is wired**

Run: `npm test`
Expected: exits 0 with "no test files found" (or similar) — confirms `node --test` runs. If your Node prints an error instead, upgrade to Node ≥ 18.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: set up ESM Node workspace with test runner and yaml dep"
```

---

## Task 2: Config module

**Files:**
- Create: `src/config.js`
- Test: (covered indirectly; no dedicated test — pure environment resolution)

- [ ] **Step 1: Write the config module**

Create `src/config.js`:

```js
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Repo root = one level up from src/. Stable regardless of CWD.
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

// The four element categories from the handoff doc. Any other value is rejected
// by createElement so typos don't silently create a fifth category.
export const ELEMENT_TYPES = ['characters', 'props', 'scenes', 'other'];

// Prefer the workspace-local CLI binary over anything global. This mirrors the
// PATH logic in scripts/sanity-checks/lib.sh.
export function higgsfieldBin(root = REPO_ROOT) {
  return path.join(root, 'node_modules', '.bin', 'higgsfield');
}
```

- [ ] **Step 2: Sanity-check it loads**

Run: `node -e "import('./src/config.js').then(m => console.log(m.ELEMENT_TYPES, m.REPO_ROOT))"`
Expected: prints `[ 'characters', 'props', 'scenes', 'other' ]` and the absolute repo path.

- [ ] **Step 3: Commit**

```bash
git add src/config.js
git commit -m "feat: add config module (repo root, element types, local CLI bin)"
```

---

## Task 3: Pure path builders

**Files:**
- Create: `src/paths.js`
- Test: `test/paths.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/paths.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../src/paths.js';

const ROOT = '/tmp/root';

test('formatVersion zero-pads to v###', () => {
  assert.equal(p.formatVersion(1), 'v001');
  assert.equal(p.formatVersion(23), 'v023');
  assert.equal(p.formatVersion(100), 'v100');
});

test('element paths follow elements/<type>/<name>/...', () => {
  assert.equal(p.elementDir(ROOT, 'characters', 'cecilia'),
    '/tmp/root/elements/characters/cecilia');
  assert.equal(p.styleLockPath(ROOT, 'characters', 'cecilia'),
    '/tmp/root/elements/characters/cecilia/style-lock.yaml');
  assert.equal(p.generationsLogPath(ROOT, 'characters', 'cecilia'),
    '/tmp/root/elements/characters/cecilia/generations.jsonl');
  assert.equal(p.sheetDir(ROOT, 'characters', 'cecilia', 'turnaround'),
    '/tmp/root/elements/characters/cecilia/sheets/turnaround');
});

test('shot paths follow shots/<shotId>/...', () => {
  assert.equal(p.shotDir(ROOT, 's010_kitchen'),
    '/tmp/root/shots/s010_kitchen');
  assert.equal(p.shotYamlPath(ROOT, 's010_kitchen'),
    '/tmp/root/shots/s010_kitchen/shot.yaml');
  assert.equal(p.shotDraftDir(ROOT, 's010_kitchen', 2),
    '/tmp/root/shots/s010_kitchen/drafts/v002');
  assert.equal(p.shotFinalDir(ROOT, 's010_kitchen'),
    '/tmp/root/shots/s010_kitchen/final');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paths.test.js`
Expected: FAIL — cannot find module `../src/paths.js`.

- [ ] **Step 3: Write the implementation**

Create `src/paths.js`:

```js
import path from 'node:path';

export function formatVersion(n) {
  return 'v' + String(n).padStart(3, '0');
}

export function elementDir(root, type, name) {
  return path.join(root, 'elements', type, name);
}
export function elementInputsDir(root, type, name) {
  return path.join(elementDir(root, type, name), 'inputs');
}
export function styleLockPath(root, type, name) {
  return path.join(elementDir(root, type, name), 'style-lock.yaml');
}
export function generationsLogPath(root, type, name) {
  return path.join(elementDir(root, type, name), 'generations.jsonl');
}
export function sheetDir(root, type, name, sheetType) {
  return path.join(elementDir(root, type, name), 'sheets', sheetType);
}

export function shotDir(root, shotId) {
  return path.join(root, 'shots', shotId);
}
export function shotYamlPath(root, shotId) {
  return path.join(shotDir(root, shotId), 'shot.yaml');
}
export function shotDraftsDir(root, shotId) {
  return path.join(shotDir(root, shotId), 'drafts');
}
export function shotDraftDir(root, shotId, version) {
  return path.join(shotDraftsDir(root, shotId), formatVersion(version));
}
export function shotFinalDir(root, shotId) {
  return path.join(shotDir(root, shotId), 'final');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/paths.test.js`
Expected: PASS — all three tests green.

- [ ] **Step 5: Commit**

```bash
git add src/paths.js test/paths.test.js
git commit -m "feat: add pure path builders for element and shot layout"
```

---

## Task 4: Job-result parsing (isolates CLI output-shape assumption)

**Files:**
- Create: `src/jobresult.js`
- Test: `test/jobresult.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/jobresult.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobId, parseJobResult } from '../src/jobresult.js';

test('parseJobId pulls a top-level id from JSON stdout', () => {
  const stdout = JSON.stringify({ id: 'job_abc123', status: 'queued' });
  assert.equal(parseJobId(stdout), 'job_abc123');
});

test('parseJobId falls back to a regex when stdout is not pure JSON', () => {
  const stdout = 'Submitted!\n{"id":"job_xyz","status":"queued"}\nDone.';
  assert.equal(parseJobId(stdout), 'job_xyz');
});

test('parseJobId returns null when no id is present', () => {
  assert.equal(parseJobId('nothing useful here'), null);
});

test('parseJobResult extracts id, status, and first output url', () => {
  const stdout = JSON.stringify({
    id: 'job_abc123',
    status: 'completed',
    results: [{ url: 'https://cdn.example/out.png' }],
  });
  const r = parseJobResult(stdout);
  assert.equal(r.id, 'job_abc123');
  assert.equal(r.status, 'completed');
  assert.equal(r.outputUrl, 'https://cdn.example/out.png');
});

test('parseJobResult tolerates missing output', () => {
  const r = parseJobResult(JSON.stringify({ id: 'j', status: 'queued' }));
  assert.equal(r.outputUrl, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/jobresult.test.js`
Expected: FAIL — cannot find module `../src/jobresult.js`.

- [ ] **Step 3: Write the implementation**

Create `src/jobresult.js`:

```js
// ⚠️ ASSUMPTION LAYER — verify against real CLI output (sanity check 5).
// The Higgsfield CLI's exact stdout shape is unconfirmed. Everything the rest
// of the pipeline believes about that shape is decided *here* and nowhere else.
// If the real output differs, fix these two functions + their test only.

// Try strict JSON.parse first; if the CLI wraps JSON in log lines, fall back to
// extracting the first {...} block, then a bare "id":"..." regex.
function tryParseJson(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace) {
    try {
      return JSON.parse(brace[0]);
    } catch {}
  }
  return null;
}

export function parseJobId(stdout) {
  const obj = tryParseJson(stdout);
  if (obj && typeof obj.id === 'string') return obj.id;
  const m = stdout.match(/"id"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

export function parseJobResult(stdout) {
  const obj = tryParseJson(stdout) || {};
  let outputUrl = null;
  if (Array.isArray(obj.results) && obj.results[0] && typeof obj.results[0].url === 'string') {
    outputUrl = obj.results[0].url;
  } else if (typeof obj.url === 'string') {
    outputUrl = obj.url;
  }
  return {
    id: typeof obj.id === 'string' ? obj.id : parseJobId(stdout),
    status: typeof obj.status === 'string' ? obj.status : 'unknown',
    outputUrl,
    raw: stdout,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/jobresult.test.js`
Expected: PASS — all five tests green.

- [ ] **Step 5: Commit**

```bash
git add src/jobresult.js test/jobresult.test.js
git commit -m "feat: add isolated CLI job-output parsing with verify-me markers"
```

---

## Task 5: CLI wrapper with injectable executor

**Files:**
- Create: `src/cli.js`
- Test: `test/cli.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/cli.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, HiggsfieldError, buildGenerateArgs } from '../src/cli.js';

// A fake executor records the args it was called with and returns a scripted result.
function fakeExec(result) {
  const calls = [];
  const exec = async (bin, args) => {
    calls.push({ bin, args });
    return result;
  };
  return { exec, calls };
}

test('buildGenerateArgs maps options to CLI flags', () => {
  const args = buildGenerateArgs('soul-model', {
    prompt: 'a red apple',
    startImage: '/tmp/a.png',
    wait: true,
  });
  assert.deepEqual(args, [
    'generate', 'create', 'soul-model',
    '--prompt', 'a red apple',
    '--start-image', '/tmp/a.png',
    '--wait',
  ]);
});

test('buildGenerateArgs omits --wait when wait is false', () => {
  const args = buildGenerateArgs('m', { prompt: 'x', wait: false });
  assert.deepEqual(args, ['generate', 'create', 'm', '--prompt', 'x']);
});

test('generate returns parsed job id on success', async () => {
  const { exec, calls } = fakeExec({ code: 0, stdout: '{"id":"job_1","status":"queued"}', stderr: '' });
  const runner = createRunner({ exec, bin: 'higgsfield' });
  const res = await runner.generate('m', { prompt: 'x' });
  assert.equal(res.id, 'job_1');
  assert.equal(calls[0].bin, 'higgsfield');
});

test('generate throws HiggsfieldError on non-zero exit', async () => {
  const { exec } = fakeExec({ code: 2, stdout: '', stderr: 'bad model' });
  const runner = createRunner({ exec });
  await assert.rejects(
    () => runner.generate('m', { prompt: 'x' }),
    (err) => err instanceof HiggsfieldError && err.code === 2 && /bad model/.test(err.message),
  );
});

test('get returns a normalized job result', async () => {
  const { exec, calls } = fakeExec({
    code: 0,
    stdout: '{"id":"job_1","status":"completed","results":[{"url":"https://x/out.png"}]}',
    stderr: '',
  });
  const runner = createRunner({ exec });
  const res = await runner.get('job_1');
  assert.equal(res.status, 'completed');
  assert.equal(res.outputUrl, 'https://x/out.png');
  assert.deepEqual(calls[0].args, ['generate', 'get', 'job_1']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli.test.js`
Expected: FAIL — cannot find module `../src/cli.js`.

- [ ] **Step 3: Write the implementation**

Create `src/cli.js`:

```js
import { execFile } from 'node:child_process';
import { higgsfieldBin } from './config.js';
import { parseJobId, parseJobResult } from './jobresult.js';

export class HiggsfieldError extends Error {
  constructor(message, { code, stdout, stderr } = {}) {
    super(message);
    this.name = 'HiggsfieldError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

// Default executor: run the binary, capture output, NEVER throw on non-zero —
// the runner decides what a non-zero code means (see generate()).
export function defaultExec(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: stdout || '',
        stderr: stderr || (err ? String(err.message) : ''),
      });
    });
  });
}

const MEDIA_FLAGS = {
  image: '--image',
  startImage: '--start-image',
  endImage: '--end-image',
  video: '--video',
  audio: '--audio',
  sketch: '--sketch',
};

// Exported for direct unit testing of arg construction.
export function buildGenerateArgs(model, opts = {}) {
  const args = ['generate', 'create', model];
  if (opts.prompt != null) args.push('--prompt', String(opts.prompt));
  for (const [key, flag] of Object.entries(MEDIA_FLAGS)) {
    // ⚠️ ASSUMPTION: a local file path here is auto-uploaded (sanity check 5).
    if (opts[key] != null) args.push(flag, String(opts[key]));
  }
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);
  if (opts.wait) args.push('--wait');
  return args;
}

export function createRunner({ exec = defaultExec, bin = higgsfieldBin() } = {}) {
  async function run(args) {
    const { code, stdout, stderr } = await exec(bin, args);
    // ⚠️ ASSUMPTION: failure => non-zero exit (sanity check 2).
    if (code !== 0) {
      throw new HiggsfieldError(
        `higgsfield ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`,
        { code, stdout, stderr },
      );
    }
    return stdout;
  }

  return {
    async generate(model, opts = {}) {
      const stdout = await run(buildGenerateArgs(model, opts));
      const id = parseJobId(stdout);
      return { id, ...parseJobResult(stdout) };
    },
    async get(jobId) {
      return parseJobResult(await run(['generate', 'get', jobId]));
    },
    async waitFor(jobId) {
      return parseJobResult(await run(['generate', 'wait', jobId]));
    },
    async listModels() {
      return run(['model', 'list']);
    },
    async getModel(modelType) {
      return run(['model', 'get', modelType]);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cli.test.js`
Expected: PASS — all five tests green.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat: add injectable Higgsfield CLI wrapper with typed errors"
```

---

## Task 6: Element scaffolding and persistence

**Files:**
- Create: `src/element.js`
- Test: `test/element.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/element.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement, writeStyleLock, readStyleLock, appendGeneration } from '../src/element.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'pipeline-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('createElement builds the full scaffold', async () => {
  await withTempRoot(async (root) => {
    const el = await createElement(root, { type: 'characters', name: 'cecilia' });
    for (const sub of ['inputs/reference-images', 'inputs/reference-videos',
      'inputs/speech-samples', 'sheets/turnaround', 'sheets/pose', 'sheets/cycles']) {
      const s = await stat(path.join(el.dir, sub));
      assert.ok(s.isDirectory(), `${sub} should exist`);
    }
    const prompt = await stat(path.join(el.dir, 'inputs', 'prompt.md'));
    assert.ok(prompt.isFile());
  });
});

test('createElement rejects an unknown type', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(() => createElement(root, { type: 'vehicles', name: 'x' }),
      /unknown element type/i);
  });
});

test('createElement refuses to clobber an existing element', async () => {
  await withTempRoot(async (root) => {
    await createElement(root, { type: 'props', name: 'lamp' });
    await assert.rejects(() => createElement(root, { type: 'props', name: 'lamp' }),
      /already exists/i);
  });
});

test('style-lock round-trips through YAML', async () => {
  await withTempRoot(async (root) => {
    await createElement(root, { type: 'characters', name: 'cecilia' });
    await writeStyleLock(root, 'characters', 'cecilia', { palette: ['#fff', '#f00'], lineWeight: 2 });
    const got = await readStyleLock(root, 'characters', 'cecilia');
    assert.deepEqual(got, { palette: ['#fff', '#f00'], lineWeight: 2 });
  });
});

test('readStyleLock returns null when absent', async () => {
  await withTempRoot(async (root) => {
    await createElement(root, { type: 'characters', name: 'nostyle' });
    assert.equal(await readStyleLock(root, 'characters', 'nostyle'), null);
  });
});

test('appendGeneration writes one JSON line per call with a timestamp', async () => {
  await withTempRoot(async (root) => {
    await createElement(root, { type: 'characters', name: 'cecilia' });
    await appendGeneration(root, 'characters', 'cecilia', { model: 'm', jobId: 'j1', status: 'accepted' });
    await appendGeneration(root, 'characters', 'cecilia', { model: 'm', jobId: 'j2', status: 'rejected' });
    const log = await readFile(
      path.join(root, 'elements', 'characters', 'cecilia', 'generations.jsonl'), 'utf8');
    const lines = log.trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.jobId, 'j1');
    assert.ok(typeof first.ts === 'string' && first.ts.length > 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/element.test.js`
Expected: FAIL — cannot find module `../src/element.js`.

- [ ] **Step 3: Write the implementation**

Create `src/element.js`:

```js
import { mkdir, writeFile, readFile, appendFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import YAML from 'yaml';
import { ELEMENT_TYPES } from './config.js';
import { elementDir, elementInputsDir, styleLockPath, generationsLogPath, sheetDir } from './paths.js';

const INPUT_SUBDIRS = ['reference-images', 'reference-videos', 'speech-samples'];
const SHEET_TYPES = ['turnaround', 'pose', 'cycles'];

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function createElement(root, { type, name }) {
  if (!ELEMENT_TYPES.includes(type)) {
    throw new Error(`unknown element type "${type}" (expected one of ${ELEMENT_TYPES.join(', ')})`);
  }
  const dir = elementDir(root, type, name);
  if (await exists(dir)) {
    throw new Error(`element already exists: ${dir}`);
  }
  const inputs = elementInputsDir(root, type, name);
  for (const sub of INPUT_SUBDIRS) {
    await mkdir(`${inputs}/${sub}`, { recursive: true });
  }
  for (const sheet of SHEET_TYPES) {
    await mkdir(sheetDir(root, type, name, sheet), { recursive: true });
  }
  await writeFile(`${inputs}/prompt.md`,
    `# ${name}\n\n<!-- Base creation prompt / description for this ${type} element. -->\n`);
  return { dir, type, name };
}

export async function writeStyleLock(root, type, name, obj) {
  await writeFile(styleLockPath(root, type, name), YAML.stringify(obj));
}

export async function readStyleLock(root, type, name) {
  try {
    const text = await readFile(styleLockPath(root, type, name), 'utf8');
    return YAML.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function appendGeneration(root, type, name, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  await appendFile(generationsLogPath(root, type, name), line);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/element.test.js`
Expected: PASS — all six tests green.

- [ ] **Step 5: Commit**

```bash
git add src/element.js test/element.test.js
git commit -m "feat: add element scaffolding, style-lock persistence, generation log"
```

---

## Task 7: Shot scaffolding, draft iteration, and promotion

**Files:**
- Create: `src/shot.js`
- Test: `test/shot.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/shot.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createShot, newDraft, promoteDraft } from '../src/shot.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'pipeline-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('createShot writes shot.yaml with the given metadata', async () => {
  await withTempRoot(async (root) => {
    await createShot(root, {
      shotId: 's010_kitchen',
      elements: [{ type: 'characters', name: 'cecilia' }],
      duration: 6,
      mode: 'narrative',
      description: 'Cecilia enters the kitchen',
    });
    const yaml = YAML.parse(
      await readFile(path.join(root, 'shots', 's010_kitchen', 'shot.yaml'), 'utf8'));
    assert.equal(yaml.shotId, 's010_kitchen');
    assert.equal(yaml.duration, 6);
    assert.deepEqual(yaml.elements, [{ type: 'characters', name: 'cecilia' }]);
    const finalDir = await stat(path.join(root, 'shots', 's010_kitchen', 'final'));
    assert.ok(finalDir.isDirectory());
  });
});

test('createShot rejects an existing shot', async () => {
  await withTempRoot(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    await assert.rejects(() => createShot(root, { shotId: 's1', elements: [] }), /already exists/i);
  });
});

test('newDraft creates sequential v001, v002 dirs with a prompt file', async () => {
  await withTempRoot(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    const d1 = await newDraft(root, 's1');
    assert.equal(d1.version, 1);
    assert.match(d1.dir, /drafts\/v001$/);
    const d2 = await newDraft(root, 's1');
    assert.equal(d2.version, 2);
    assert.match(d2.dir, /drafts\/v002$/);
    const promptFile = await stat(path.join(d2.dir, 'prompt.md'));
    assert.ok(promptFile.isFile());
  });
});

test('promoteDraft copies a draft output into final/ and records its source', async () => {
  await withTempRoot(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    const d = await newDraft(root, 's1');
    const src = path.join(d.dir, 'output.mp4');
    await writeFile(src, 'FAKEVIDEO');
    await promoteDraft(root, 's1', 1, src);
    const finalOut = await readFile(path.join(root, 'shots', 's1', 'final', 'output.mp4'), 'utf8');
    assert.equal(finalOut, 'FAKEVIDEO');
    const source = await readFile(path.join(root, 'shots', 's1', 'final', 'source-draft.txt'), 'utf8');
    assert.match(source.trim(), /v001/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/shot.test.js`
Expected: FAIL — cannot find module `../src/shot.js`.

- [ ] **Step 3: Write the implementation**

Create `src/shot.js`:

```js
import { mkdir, writeFile, copyFile, access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  shotDir, shotYamlPath, shotDraftsDir, shotDraftDir, shotFinalDir, formatVersion,
} from './paths.js';

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function createShot(root, { shotId, elements = [], duration = null, mode = null, description = '' }) {
  const dir = shotDir(root, shotId);
  if (await exists(dir)) {
    throw new Error(`shot already exists: ${dir}`);
  }
  await mkdir(shotDraftsDir(root, shotId), { recursive: true });
  await mkdir(shotFinalDir(root, shotId), { recursive: true });
  await writeFile(shotYamlPath(root, shotId),
    YAML.stringify({ shotId, elements, duration, mode, description }));
  return { dir, shotId };
}

// Next draft version = highest existing vNNN + 1, starting at 1.
async function nextVersion(root, shotId) {
  const draftsDir = shotDraftsDir(root, shotId);
  let entries = [];
  try {
    entries = await readdir(draftsDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const nums = entries
    .map((e) => /^v(\d+)$/.exec(e))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

export async function newDraft(root, shotId) {
  const version = await nextVersion(root, shotId);
  const dir = shotDraftDir(root, shotId, version);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'prompt.md'),
    `<!-- Prompt used for ${shotId} draft ${formatVersion(version)} (low-res). -->\n`);
  await writeFile(path.join(dir, 'notes.md'),
    `<!-- Critique / regenerate-or-accept decision log for ${formatVersion(version)}. -->\n`);
  return { version, dir };
}

export async function promoteDraft(root, shotId, version, outputFile) {
  const ext = path.extname(outputFile) || '.out';
  const dest = path.join(shotFinalDir(root, shotId), `output${ext}`);
  await copyFile(outputFile, dest);
  await writeFile(path.join(shotFinalDir(root, shotId), 'source-draft.txt'),
    `${formatVersion(version)}\n`);
  return { finalPath: dest };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/shot.test.js`
Expected: PASS — all four tests green.

- [ ] **Step 5: Commit**

```bash
git add src/shot.js test/shot.test.js
git commit -m "feat: add shot scaffolding, draft iteration, and promotion"
```

---

## Task 8: CLI entrypoint

**Files:**
- Create: `bin/pipeline.js`
- Test: (manual smoke test — thin arg glue over already-tested modules)

- [ ] **Step 1: Write the entrypoint**

Create `bin/pipeline.js`:

```js
#!/usr/bin/env node
import { REPO_ROOT } from '../src/config.js';
import { createElement } from '../src/element.js';
import { createShot, newDraft, promoteDraft } from '../src/shot.js';

const [, , cmd, sub, ...rest] = process.argv;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// Minimal --key value parser for the leaf commands below.
function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--')) fail(`expected --flag, got "${args[i]}"`);
    out[args[i].slice(2)] = args[i + 1];
  }
  return out;
}

async function main() {
  if (cmd === 'element' && sub === 'create') {
    const f = parseFlags(rest);
    if (!f.type || !f.name) fail('usage: pipeline element create --type <t> --name <n>');
    const el = await createElement(REPO_ROOT, { type: f.type, name: f.name });
    console.log(`created element: ${el.dir}`);
  } else if (cmd === 'shot' && sub === 'create') {
    const f = parseFlags(rest);
    if (!f.id) fail('usage: pipeline shot create --id <shotId> [--duration <s>] [--mode <m>] [--description <d>]');
    const shot = await createShot(REPO_ROOT, {
      shotId: f.id,
      elements: [],
      duration: f.duration ? Number(f.duration) : null,
      mode: f.mode || null,
      description: f.description || '',
    });
    console.log(`created shot: ${shot.dir}`);
  } else if (cmd === 'shot' && sub === 'draft') {
    const f = parseFlags(rest);
    if (!f.id) fail('usage: pipeline shot draft --id <shotId>');
    const d = await newDraft(REPO_ROOT, f.id);
    console.log(`created draft ${d.version}: ${d.dir}`);
  } else if (cmd === 'shot' && sub === 'promote') {
    const f = parseFlags(rest);
    if (!f.id || !f.version || !f.output) {
      fail('usage: pipeline shot promote --id <shotId> --version <n> --output <file>');
    }
    const r = await promoteDraft(REPO_ROOT, f.id, Number(f.version), f.output);
    console.log(`promoted to final: ${r.finalPath}`);
  } else {
    fail([
      'usage:',
      '  pipeline element create --type <characters|props|scenes|other> --name <name>',
      '  pipeline shot create --id <shotId> [--duration <s>] [--mode <m>] [--description <d>]',
      '  pipeline shot draft --id <shotId>',
      '  pipeline shot promote --id <shotId> --version <n> --output <file>',
    ].join('\n'));
  }
}

main().catch((err) => fail(err.message));
```

- [ ] **Step 2: Smoke-test element creation**

Run: `node bin/pipeline.js element create --type characters --name testchar`
Expected: prints `created element: .../elements/characters/testchar`, and that directory tree exists.

- [ ] **Step 3: Smoke-test shot lifecycle**

Run each and confirm the printed paths exist:
```bash
node bin/pipeline.js shot create --id s001_test --duration 6 --mode narrative
node bin/pipeline.js shot draft --id s001_test
```
Expected: shot dir with `shot.yaml`, then `drafts/v001/` with `prompt.md`.

- [ ] **Step 4: Clean up smoke-test artifacts**

Run: `rm -rf elements/characters/testchar shots/s001_test`
Expected: no error.

- [ ] **Step 5: Commit**

```bash
git add bin/pipeline.js
git commit -m "feat: add pipeline CLI entrypoint for element and shot commands"
```

---

## Task 9: Style-lock schema doc and full-suite green

**Files:**
- Create: `docs/style-lock-schema.md`

- [ ] **Step 1: Write the schema reference**

Create `docs/style-lock-schema.md`:

```markdown
# style-lock.yaml field reference

`style-lock.yaml` is the durable, per-element spec re-injected into the director
skills on every generation so style doesn't drift across a batch or across
separate chat sessions. It is a free-form YAML map; the fields below are the
conventional keys the director skills read. Two variants:

## Illustrated (illustration-director / illustration-worldbuilder)

```yaml
styleRegister: flat-cartoon        # e.g. flat-cartoon, anime, comic, children's-book
palette:                           # locked hex swatches
  - "#1b1b1b"
  - "#ff5a5f"
lineWeight: 2                      # relative stroke weight
proportions: chibi                 # e.g. chibi, realistic, elongated
wardrobe: "red hoodie, denim shorts"
notes: "no gradients; hard cel shading only"
```

## Photoreal (banana-pro-director / cinema-worldbuilder)

```yaml
skin: "visible pores, subsurface scattering"
hair: "strand-by-strand, warm brown"
fabric: "cotton weave, natural drape"
wardrobe: "charcoal wool coat"
grade: "Kodak Vision3, low contrast"
notes: "hyperreal stack locked"
```

Add or drop keys freely — the pipeline persists whatever object it's given.
Version history lives in git (the file is committed) and in each shot's
`shot.yaml` element pins.
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS — every test file green, exit 0.

- [ ] **Step 3: Commit**

```bash
git add docs/style-lock-schema.md
git commit -m "docs: add style-lock.yaml schema reference"
```

---

## Follow-up plan (deferred — depends on sanity-check results)

Do **not** attempt these here; they require live CLI behavior confirmed by the sanity checks the user is running:

1. **Live generation smoke test** — one real `runner.generate(...)` against a cheap model, wiring `appendGeneration` and saving the output file into the element's `sheets/` dir. Confirms Tasks 4–6 assumptions against reality. (Needs checks 2 & 5.)
2. **Video polling flow** — async submit + `runner.waitFor`, using a real shot draft. (Needs check 6 — resumability.)
3. **Batch queue runner** — read a queue of elements/shots, invoke the runner per item, with concurrency set from check 7's result (parallel vs. serialized) and retry/backoff tuned to check 2's exit-code behavior.
4. **Claude critique loop** — after each generation, hand the output + `style-lock.yaml` to Claude (interactive skill or `ANTHROPIC_API_KEY` headless call) to decide accept/regenerate, recording the verdict in `generations.jsonl` and the draft's `notes.md`.
5. **Upscale command** — final-resolution promotion, once `model get` (check 3) reveals the real upscale flags.

Write that as its own plan once the sanity results are recorded in `animation-automation-handoff.md`.

---

## Self-review

- **Spec coverage:** element scaffold (Task 6) ✓, style-lock persistence (Tasks 6 + 9) ✓, generations log (Task 6) ✓, shot scaffold + low-res drafts + promote (Task 7) ✓, CLI-invocation seam (Tasks 4–5) ✓, local-bin resolution (Task 2) ✓, on-disk layout matches handoff doc ✓. Live generation, batch, upscale, and Claude-critique are explicitly deferred with reasons.
- **Placeholder scan:** every code step contains complete, runnable code; no "TODO"/"add error handling"/"similar to above" left in.
- **Type consistency:** `createRunner`/`generate`/`get`/`waitFor` signatures match between `cli.js` and `test/cli.test.js`; path builder names (`shotDraftDir`, `sheetDir`, `generationsLogPath`) are identical across `paths.js` and every consumer; `formatVersion` is the single zero-pad helper used by both `paths.js` and `shot.js`.
```
