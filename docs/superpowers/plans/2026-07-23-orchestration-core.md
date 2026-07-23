# Orchestration Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the orchestration layer that turns the deterministic pipeline mechanics into a working generate-and-persist engine: submit generation jobs to Higgsfield, poll them to completion in parallel, download results into the element/shot directory structure, log credit cost, and expose it all through the `pipeline` CLI so an interactive Claude Code critique loop can drive iteration.

**Architecture:** A thin async batch engine on top of the existing `createRunner` CLI wrapper. It submits jobs with `generate create --json` (no `--wait`, which returns a job-id array), then polls `generate get <id> --json` for all outstanding jobs on an interval — exploiting the **verified parallel backend** for throughput. Results (`result_url` + low-res `min_result_url`) are downloaded via an injectable fetcher. High-level operations wire this to `element.js`/`shot.js` (save into `sheets/` or `drafts/vNNN/`, append `generations.jsonl`). Credit cost is read from `account transactions` (the balance field is cached and unreliable). Everything is unit-tested with injected fakes — **zero credits to build**.

**Tech Stack:** Node.js (ESM, `node:test`, `node:fs/promises`, global `fetch`), building on `src/{config,paths,cli,jobresult,element,shot}.js`.

**Interactive critique (design decision):** The accept/regenerate critique loop is **interactive through Claude Code**, not a headless script. This plan builds the *mechanics* the loop uses (generate a low-res draft, download its `min_result_url`, record accept/reject, regenerate a new version). Claude, in the Claude Code session, views the output against the element's `style-lock.yaml` and decides — that judgment is not automated here.

---

## Grounding: verified facts from the sanity checks

Every design choice below traces to a confirmed finding in `animation-automation-handoff.md`:

| Fact (verified) | Design consequence |
|---|---|
| Async `create --json` (no `--wait`) returns a JSON **array of job-id strings** | `submitJob` reads the array; one submit may yield >1 id |
| Backend runs jobs **in parallel** (2× 90s videos → 92s total) | Submit whole batch first, then poll all outstanding |
| `get <id> --json` → `{id, status, result_url, min_result_url, created_at, params}` | Poll `get`; terminal on `status==="completed"` / failure |
| Only `completed` status observed; no duration/timestamp beyond `created_at` | Treat `completed` as success; `/fail|error|cancel/i` as failure; poll on a timer |
| Credit **balance field is cached**; `account transactions` is authoritative | Log cost by reading transactions, not balance deltas |
| Input flags are **per-model** (`--image` vs `--start-image` …) | Caller supplies the media option key; document per-model |
| `min_result_url` is a low-res preview | Download it for the cheap interactive critique input |
| CLI wrapper appends `--json` to every command already | Poller/parsers receive JSON |

---

## File structure

```
src/
  batch.js       # async submit-all + poll-all engine (uses createRunner)
  download.js    # fetch result_url / min_result_url to disk (injectable fetcher)
  generate.js    # high-level ops: generate element sheet / shot draft, wire to disk
  credits.js     # parse `account transactions` for per-run cost
bin/
  pipeline.js    # extend with generate/draft/promote-aware subcommands (modify)
test/
  batch.test.js
  download.test.js
  generate.test.js
  credits.test.js
```

Responsibilities: `batch.js` owns concurrency (submit then poll); `download.js` owns the HTTP-to-disk step (the one place `fetch` is used, injectable for tests); `generate.js` is the glue that turns "make a turnaround for element X" into submit→poll→download→log→`appendGeneration`; `credits.js` isolates the transactions-table parsing. `bin/pipeline.js` stays thin.

---

## Task 1: Batch engine — submit all, then poll all

**Files:**
- Create: `src/batch.js`
- Test: `test/batch.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/batch.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalStatus, runBatch } from '../src/batch.js';

test('isTerminalStatus recognizes completion and failure, not in-progress', () => {
  assert.equal(isTerminalStatus('completed'), true);
  assert.equal(isTerminalStatus('failed'), true);
  assert.equal(isTerminalStatus('error'), true);
  assert.equal(isTerminalStatus('canceled'), true);
  assert.equal(isTerminalStatus('queued'), false);
  assert.equal(isTerminalStatus('in_progress'), false);
  assert.equal(isTerminalStatus('unknown'), false);
});

// A fake runner: generate() hands back a submitted id; get() returns 'queued'
// once then 'completed', so the poller must loop at least once.
function fakeRunner() {
  const getCalls = {};
  return {
    generated: [],
    async generate(model, opts) {
      this.generated.push({ model, opts });
      return { id: `job_${this.generated.length}`, status: 'unknown', outputUrl: null };
    },
    async get(id) {
      getCalls[id] = (getCalls[id] || 0) + 1;
      const done = getCalls[id] >= 2;
      return {
        id,
        status: done ? 'completed' : 'queued',
        outputUrl: done ? `https://cdn/${id}.png` : null,
      };
    },
  };
}

test('runBatch submits every request without waiting, then polls to completion', async () => {
  const runner = fakeRunner();
  const requests = [
    { ref: 'a', model: 'nano_banana', opts: { prompt: 'x' } },
    { ref: 'b', model: 'nano_banana', opts: { prompt: 'y' } },
  ];
  const results = await runBatch(runner, requests, { pollIntervalMs: 0 });

  // Submitted async (wait:false) before any polling.
  assert.equal(runner.generated.length, 2);
  assert.equal(runner.generated[0].opts.wait, false);

  assert.equal(results.length, 2);
  assert.equal(results[0].ref, 'a');
  assert.equal(results[0].id, 'job_1');
  assert.equal(results[0].status, 'completed');
  assert.equal(results[0].outputUrl, 'https://cdn/job_1.png');
});

test('runBatch surfaces a submit that returned no id as an error result', async () => {
  const runner = {
    async generate() { return { id: null, status: 'unknown', outputUrl: null }; },
    async get() { throw new Error('should not be polled'); },
  };
  const results = await runBatch(runner, [{ ref: 'a', model: 'm', opts: {} }], { pollIntervalMs: 0 });
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /no job id/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/batch.test.js`
Expected: FAIL — cannot find module `../src/batch.js`.

- [ ] **Step 3: Write the implementation**

Create `src/batch.js`:

```js
// Async batch engine. Verified backend behavior (sanity checks 6 & 7):
// `create` without --wait returns immediately with a job id, and the backend
// runs jobs in PARALLEL. So we submit the whole batch first, then poll all
// outstanding jobs together — real throughput, not serialized waits.

const FAILURE_RE = /fail|error|cancel/i;

export function isTerminalStatus(status) {
  if (typeof status !== 'string') return false;
  return status === 'completed' || FAILURE_RE.test(status);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// requests: [{ ref, model, opts }]  (opts are createRunner.generate options)
// Returns one result per request, order preserved:
//   { ref, id, status, outputUrl, error? }
export async function runBatch(runner, requests, { pollIntervalMs = 4000, maxPolls = 900 } = {}) {
  // 1) Submit everything async (wait:false) — do not block between submits.
  const jobs = [];
  for (const req of requests) {
    try {
      const res = await runner.generate(req.model, { ...req.opts, wait: false });
      jobs.push({ ref: req.ref, id: res.id, status: res.id ? 'submitted' : 'error',
        outputUrl: null, error: res.id ? undefined : 'submit returned no job id' });
    } catch (err) {
      jobs.push({ ref: req.ref, id: null, status: 'error', outputUrl: null, error: err.message });
    }
  }

  // 2) Poll all outstanding jobs together until each is terminal.
  const pending = new Map(jobs.filter((j) => j.id && j.status === 'submitted').map((j) => [j.id, j]));
  let polls = 0;
  while (pending.size && polls < maxPolls) {
    for (const [id, job] of [...pending]) {
      let r;
      try {
        r = await runner.get(id);
      } catch (err) {
        job.status = 'error';
        job.error = err.message;
        pending.delete(id);
        continue;
      }
      if (isTerminalStatus(r.status)) {
        job.status = r.status;
        job.outputUrl = r.outputUrl || null;
        pending.delete(id);
      }
    }
    polls += 1;
    if (pending.size) await sleep(pollIntervalMs);
  }
  for (const job of pending.values()) {
    job.status = 'error';
    job.error = 'timed out waiting for completion';
  }
  return jobs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/batch.test.js`
Expected: PASS — all four tests green.

- [ ] **Step 5: Commit**

```bash
git add src/batch.js test/batch.test.js
git commit -m "feat: add async submit-all/poll-all batch engine"
```

---

## Task 2: Result download

**Files:**
- Create: `src/download.js`
- Test: `test/download.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/download.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadTo } from '../src/download.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dl-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// Fake fetch returning bytes with a content-type; records the URL requested.
function fakeFetch(bytes, { ok = true, contentType = 'image/png' } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return {
      ok,
      status: ok ? 200 : 500,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  return { fn, calls };
}

test('downloadTo writes the response body to the given path and returns it', async () => {
  await withTemp(async (dir) => {
    const { fn, calls } = fakeFetch(Buffer.from('PNGDATA'));
    const dest = path.join(dir, 'out.png');
    const res = await downloadTo('https://cdn/x.png', dest, { fetchImpl: fn });
    assert.equal(res, dest);
    assert.equal(await readFile(dest, 'utf8'), 'PNGDATA');
    assert.deepEqual(calls, ['https://cdn/x.png']);
  });
});

test('downloadTo infers the extension from the URL when the dest has none', async () => {
  await withTemp(async (dir) => {
    const { fn } = fakeFetch(Buffer.from('MP4DATA'));
    const dest = await downloadTo('https://cdn/clip.mp4', path.join(dir, 'output'), { fetchImpl: fn });
    assert.ok(dest.endsWith('output.mp4'));
    assert.ok((await stat(dest)).isFile());
  });
});

test('downloadTo throws on a non-ok response', async () => {
  await withTemp(async (dir) => {
    const { fn } = fakeFetch(Buffer.from(''), { ok: false });
    await assert.rejects(
      () => downloadTo('https://cdn/x.png', path.join(dir, 'o.png'), { fetchImpl: fn }),
      /download failed.*500/i,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/download.test.js`
Expected: FAIL — cannot find module `../src/download.js`.

- [ ] **Step 3: Write the implementation**

Create `src/download.js`:

```js
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Download a URL to a local path. fetchImpl is injectable for tests; defaults
// to the global fetch (Node 18+). If dest has no extension, borrow the URL's.
export async function downloadTo(url, dest, { fetchImpl = fetch } = {}) {
  let out = dest;
  if (!path.extname(out)) {
    const urlExt = path.extname(new URL(url).pathname);
    if (urlExt) out += urlExt;
  }
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`download failed for ${url} (status ${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, buf);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/download.test.js`
Expected: PASS — all three tests green.

- [ ] **Step 5: Commit**

```bash
git add src/download.js test/download.test.js
git commit -m "feat: add result download with injectable fetch"
```

---

## Task 3: Credit cost from the transactions log

**Files:**
- Create: `src/credits.js`
- Test: `test/credits.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/credits.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTransactions } from '../src/credits.js';

// Real shape (sanity check 4): `account transactions` prints a fixed-column
// table: DATE(16 chars) MODEL CREDITS ACTION.
const SAMPLE = [
  'DATE              MODEL            CREDITS  ACTION',
  '2026-07-23 00:24  Nano Banana Pro  -2       spend',
  '2026-07-16 21:49  Seedance 2.0     -22.5    spend',
].join('\n');

test('parseTransactions extracts date, model, credits, action rows', () => {
  const rows = parseTransactions(SAMPLE);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    date: '2026-07-23 00:24', model: 'Nano Banana Pro', credits: -2, action: 'spend',
  });
  assert.equal(rows[1].model, 'Seedance 2.0');
  assert.equal(rows[1].credits, -22.5);
});

test('parseTransactions ignores the header and blank lines', () => {
  assert.equal(parseTransactions('\n' + SAMPLE + '\n').length, 2);
  assert.equal(parseTransactions('').length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/credits.test.js`
Expected: FAIL — cannot find module `../src/credits.js`.

- [ ] **Step 3: Write the implementation**

Create `src/credits.js`:

```js
// Parse the `higgsfield account transactions` table — the authoritative record
// of credit spend (the account/workspace `credits` balance field is cached and
// unreliable, per sanity check 4). Columns: DATE(YYYY-MM-DD HH:MM) MODEL CREDITS
// ACTION, whitespace-separated with a multi-word MODEL in the middle.
const ROW_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(.+?)\s+(-?\d+(?:\.\d+)?)\s+(\S+)\s*$/;

export function parseTransactions(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    const m = ROW_RE.exec(line);
    if (!m) continue; // header, blanks, and malformed lines skipped
    rows.push({ date: m[1], model: m[2].trim(), credits: Number(m[3]), action: m[4] });
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/credits.test.js`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add src/credits.js test/credits.test.js
git commit -m "feat: parse account transactions for authoritative credit cost"
```

---

## Task 4: High-level generate operations (wire to disk)

**Files:**
- Create: `src/generate.js`
- Test: `test/generate.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/generate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement } from '../src/element.js';
import { createShot, newDraft } from '../src/shot.js';
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
    runBatch: async (_runner, requests) =>
      requests.map((r) => ({ ref: r.ref, id: 'job_1', status: 'completed',
        outputUrl: 'https://cdn/job_1.png' })),
    downloadTo: async (url, dest) => {
      downloaded.push({ url, dest });
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, 'BYTES');
      return dest;
    },
  };
}

test('generateElementSheet saves output under sheets/<type>/vNNN and logs it', async () => {
  await withTemp(async (root) => {
    await createElement(root, { type: 'characters', name: 'cecilia' });
    const d = deps();
    const res = await generateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'turnaround',
      model: 'nano_banana', prompt: 'turnaround of cecilia',
    }, { runner: {}, ...d });

    // File landed under the element's sheets/turnaround dir, versioned.
    assert.match(res.outputPath, /elements\/characters\/cecilia\/sheets\/turnaround\/v001\./);
    assert.ok((await stat(res.outputPath)).isFile());

    // generations.jsonl got an entry with the job id + model + output path.
    const log = await readFile(
      path.join(root, 'elements', 'characters', 'cecilia', 'generations.jsonl'), 'utf8');
    const entry = JSON.parse(log.trim());
    assert.equal(entry.jobId, 'job_1');
    assert.equal(entry.model, 'nano_banana');
    assert.equal(entry.sheet, 'turnaround');
    assert.ok(entry.output.endsWith(path.basename(res.outputPath)));
  });
});

test('generateShotDraft saves output into the draft dir', async () => {
  await withTemp(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    const { dir } = await newDraft(root, 's1');
    const d = deps();
    const res = await generateShotDraft(root, {
      shotId: 's1', version: 1, model: 'seedance_2_0_mini', prompt: 'a shot',
    }, { runner: {}, ...d });
    assert.equal(path.dirname(res.outputPath), dir);
    assert.match(res.outputPath, /drafts\/v001\/output\./);
    assert.ok((await stat(res.outputPath)).isFile());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/generate.test.js`
Expected: FAIL — cannot find module `../src/generate.js`.

- [ ] **Step 3: Write the implementation**

Create `src/generate.js`:

```js
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { runBatch as defaultRunBatch } from './batch.js';
import { downloadTo as defaultDownloadTo } from './download.js';
import { appendGeneration } from './element.js';
import { sheetDir, shotDraftDir } from './paths.js';

// Next vNNN inside a directory of vNNN-prefixed files (sheets are versioned by
// filename, e.g. v001.png). Starts at 1.
async function nextSheetVersion(dir) {
  let entries = [];
  try { entries = await readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const nums = entries.map((e) => /^v(\d+)\b/.exec(e)).filter(Boolean).map((m) => Number(m[1]));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

function extFromUrl(url, fallback) {
  const e = path.extname(new URL(url).pathname);
  return e || fallback;
}

// Generate one artifact for an element and save it under sheets/<sheet>/vNNN.
// deps (runBatch/downloadTo) are injectable for tests.
export async function generateElementSheet(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
} = {}) {
  const { type, name, sheet, model, prompt, mediaFlag, mediaPath } = spec;
  const opts = { prompt };
  if (mediaFlag && mediaPath) opts[mediaFlag] = mediaPath; // e.g. image: '/path'

  const [result] = await runBatch(runner, [{ ref: `${name}/${sheet}`, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    throw new Error(`generation for ${name}/${sheet} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  const dir = sheetDir(root, type, name, sheet);
  const version = await nextSheetVersion(dir);
  const vtag = 'v' + String(version).padStart(3, '0');
  const outputPath = path.join(dir, `${vtag}${extFromUrl(result.outputUrl, '.png')}`);
  await downloadTo(result.outputUrl, outputPath);

  await appendGeneration(root, type, name, {
    model, sheet, version: vtag, jobId: result.id,
    prompt, output: outputPath, status: 'generated',
  });
  return { outputPath, jobId: result.id, version: vtag };
}

// Generate the output for an existing shot draft (drafts/vNNN/output.<ext>).
export async function generateShotDraft(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
} = {}) {
  const { shotId, version, model, prompt, mediaFlag, mediaPath } = spec;
  const opts = { prompt };
  if (mediaFlag && mediaPath) opts[mediaFlag] = mediaPath;

  const [result] = await runBatch(runner, [{ ref: `${shotId}/v${version}`, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    throw new Error(`shot draft ${shotId} v${version} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  const dir = shotDraftDir(root, shotId, version);
  const outputPath = path.join(dir, `output${extFromUrl(result.outputUrl, '.mp4')}`);
  await downloadTo(result.outputUrl, outputPath);
  return { outputPath, jobId: result.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/generate.test.js`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add src/generate.js test/generate.test.js
git commit -m "feat: high-level generate ops wiring batch+download to element/shot dirs"
```

---

## Task 5: CLI commands for generation

**Files:**
- Modify: `bin/pipeline.js`

- [ ] **Step 1: Add the `generate` subcommands**

In `bin/pipeline.js`, add these imports at the top (alongside the existing ones):

```js
import { createRunner } from '../src/cli.js';
import { generateElementSheet, generateShotDraft } from '../src/generate.js';
```

Then add two new `else if` branches inside `main()`, immediately before the final `else` (the usage block):

```js
  } else if (cmd === 'element' && sub === 'sheet') {
    const f = parseFlags(rest);
    if (!f.type || !f.name || !f.sheet || !f.model || !f.prompt) {
      fail('usage: pipeline element sheet --type <t> --name <n> --sheet <turnaround|pose|cycles> --model <m> --prompt <p> [--image <file>] [--root <dir>]');
    }
    const res = await generateElementSheet(projectRoot(f.root), {
      type: f.type, name: f.name, sheet: f.sheet, model: f.model, prompt: f.prompt,
      mediaFlag: f.image ? 'image' : undefined, mediaPath: f.image,
    }, { runner: createRunner() });
    console.log(`saved ${res.version}: ${res.outputPath}`);
  } else if (cmd === 'shot' && sub === 'generate') {
    const f = parseFlags(rest);
    if (!f.id || !f.version || !f.model || !f.prompt) {
      fail('usage: pipeline shot generate --id <shotId> --version <n> --model <m> --prompt <p> [--image <file>] [--root <dir>]');
    }
    const res = await generateShotDraft(projectRoot(f.root), {
      shotId: f.id, version: Number(f.version), model: f.model, prompt: f.prompt,
      mediaFlag: f.image ? 'image' : undefined, mediaPath: f.image,
    }, { runner: createRunner() });
    console.log(`saved shot draft output: ${res.outputPath}`);
  }
```

Then extend the final usage array (the `fail([...])` block) with these lines before the closing `].join('\n'))`:

```js
      '  pipeline element sheet --type <t> --name <n> --sheet <turnaround|pose|cycles> --model <m> --prompt <p> [--image <file>]',
      '  pipeline shot generate --id <shotId> --version <n> --model <m> --prompt <p> [--image <file>]',
```

- [ ] **Step 2: Smoke-test the usage text (no credits)**

Run: `node bin/pipeline.js`
Expected: usage now lists `element sheet` and `shot generate`, exit 1.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS — all suites green (batch, download, credits, generate, plus prior).

- [ ] **Step 4: Commit**

```bash
git add bin/pipeline.js
git commit -m "feat: add element sheet / shot generate CLI commands"
```

---

## Interactive critique workflow (documentation, not code)

This plan deliberately stops at the mechanics. The accept/regenerate loop runs **interactively in Claude Code**:

1. **Generate a low-res draft** — `pipeline shot generate --id s010 --version 1 --model seedance_2_0_mini --prompt "…"` (low-res model/resolution to save credits, per the 2-vs-22.5 credit finding).
2. **Claude reviews** — reads the element's `style-lock.yaml` and views the downloaded output (prefer the `min_result_url` preview when wired) against it.
3. **Decide** — if it drifts, Claude records the critique in the draft's `notes.md` and calls `pipeline shot draft --id s010` to open a new version, then regenerates. If good, `pipeline shot promote --id s010 --version N --output <file>` and only then upscale at production resolution.

Automating step 2's judgment (headless critique via `ANTHROPIC_API_KEY`) is a future option; for now it is a human/Claude-in-the-loop step by design.

---

## Follow-up (later plans)

- **Downloading `min_result_url`** alongside the full result, and a `pipeline` view/compare helper for the critique step.
- **Credit-usage run log** — call `parseTransactions` after a batch and write a per-run cost summary.
- **Per-model arg building from `model get`** — a small model-schema registry so callers don't hand-pick `--image` vs `--start-image`.
- **Upscale command** — production-resolution promotion once the upscale model's flags are captured via `model get`.
- **Batch concurrency ceiling** — probe beyond 2-way parallel if large batches slow down.

---

## Self-review

- **Spec coverage:** async submit-all/poll-all engine exploiting the verified parallel backend (Task 1) ✓; result download (Task 2) ✓; authoritative credit parsing from transactions (Task 3) ✓; generation wired to `sheets/`/`drafts/` + `generations.jsonl` (Task 4) ✓; CLI surface for the interactive loop (Task 5) ✓; interactive critique documented as the human/Claude step per the stated decision ✓.
- **Placeholder scan:** every code step contains complete, runnable code; no TODO/"handle errors"/"similar to above".
- **Type consistency:** `runBatch(runner, requests, opts)` returns `{ref,id,status,outputUrl,error?}` and is consumed with those exact fields in `generate.js` and `test`. `downloadTo(url, dest, {fetchImpl})` signature matches its callers and the injected double in `generate.test.js`. `generateElementSheet`/`generateShotDraft` take `(root, spec, {runner, runBatch, downloadTo})` consistently across `generate.js`, its test, and `bin/pipeline.js`. `sheetDir`/`shotDraftDir` are the same builders from `paths.js` used earlier. `appendGeneration(root, type, name, entry)` matches `element.js`.
- **Grounding:** each task cites the verified sanity-check fact it depends on; no unverified CLI assumptions remain in the design.
```
