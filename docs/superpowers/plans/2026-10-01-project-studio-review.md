# Project Studio — Phase 1 (Review) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web UI, `pipeline studio`, that shows a project's structure (elements, episodes, shots — whatever exists on disk) as a navigable tree, and for each node opens a review view where versions are compared side by side and selected. Phase 1 is **read-only on artifacts**. It writes only under `<project>/.pipeline/studio/`: the reviewer's selections and cached matte preview composites.

**Architecture:** A zero-dependency `node:http` server (`src/studio/server.js`) bound to `127.0.0.1`. It reuses the existing scanners (`scanShots`, `scanImages`, `discoverShotRoots` in `src/review-scan.js`) to answer a small JSON API, and serves project media **in place** at `/media/<project-relative path>` (with HTTP Range so video seeks), so nothing is vendored or copied. The front end is plain ES modules with no build step (`src/studio/web/`). Its look comes from the static review page: the server serves the existing `STYLE` from `src/review-render.js` as `/review.css`, and the studio reuses the same class names (`.row`, `.cols`, `.col`, `.vrow`, `.select`, `.hide`, `.hmark`, `.badge`, …). Design changes to the shared look then land in one place. Rendering lives in pure functions that return HTML strings (`views.js`), the same approach `review-render.js` takes, so `node:test` can test it without a DOM.

**Mattes are never played raw.** Browsers can't reliably play ProRes 4444, and alpha in VP9 webm is inconsistent across browsers. The server instead composites each matte over a standard background (checkerboard by default, or solid white, black, gray or chroma green) with `ffmpeg` and caches the result as an H.264 mp4 under `<project>/.pipeline/studio/previews/`. The UI shows only those composites. Renders are on demand, deduplicated, limited to 2 at a time, and redone when the source matte is newer than the cached preview. `ffmpeg` is already a pipeline prerequisite.

**Tech Stack:** Node 24 ESM, `node:http`, `node:test`, global `fetch` in tests. Client: vanilla JS modules with hash routing. No new npm dependencies.

**Phase 2 (creation UI) is out of scope here.** It gets its own plan once the Phase 1 design settles. See "Phase 2 roadmap" at the end, which lists the hook points so Phase 1 avoids decisions that would block it.

---

## Ground rules for the executor

- Work on a fresh branch off `main` in a worktree (superpowers:using-git-worktrees). The current checkout (`feat/keyedit-spike`) has unrelated dirty files, so keep them out of these commits.
- Ship as **two PRs**, per the repo's PR convention: **PR A** = Tasks 1–7 (server + API + matte previews + CLI, which can be tested with curl). **PR B** = Tasks 8–11 (UI). Open each PR with `gh` and **ask the user before merging**.
- Run the full suite with `npm test` before each commit. Expected: all pass. The baseline already passes on `main`.

## File structure

| File | Responsibility |
|---|---|
| `src/review-scan.js` (modify) | Also detect `alpha.webm` as a matte variant (`--format webm` output was invisible to the scanner). |
| `src/studio/matte-preview.js` (create) | `buildPreviewArgs()` (pure ffmpeg args), `previewRelPath()`, `createPreviewer()` (cache check, dedupe, concurrency-limited queue). |
| `src/review-render.js` (modify) | Export the existing `STYLE` string as `REVIEW_STYLE` (no other change). |
| `src/studio/tree.js` (create) | `scanProjectTree(root)` gives a compact project tree. `shotKey()` and `sheetKey()` give stable selection keys. |
| `src/studio/media.js` (create) | `resolveWithin(base, rel)` path-traversal guard. `sendFile(req, res, abs)` with MIME + Range. |
| `src/studio/selections.js` (create) | Read/write `.pipeline/studio/selections.json` (validated, atomic, serialized writes). |
| `src/studio/server.js` (create) | `createStudioServer({ root })`, `startStudio({ root, port, host })`. Routing, Host check, JSON API. |
| `bin/pipeline.js` (modify) | `pipeline studio [--root <dir>] [--port <n>]` subcommand + usage line. |
| `src/studio/web/index.html` (create) | Shell: rail (tree), toolbar, grid. Loads `/review.css`, `studio.css`, `app.js`. |
| `src/studio/web/studio.css` (create) | Studio-only additions: tree nav, mode toggle, matte background swatches, preview placeholders, home cards. |
| `src/studio/web/views.js` (create) | Pure HTML builders: `parseRoute`, `treeHTML`, `homeHTML`, `shotRowsHTML`, `sheetRowsHTML`, `mediaUrl`, `esc`. |
| `src/studio/web/app.js` (create) | Wiring: fetch, routing, state, event delegation, selection save/export. |
| `test/studio-tree.test.js`, `test/studio-media.test.js`, `test/studio-selections.test.js`, `test/studio-matte-preview.test.js`, `test/studio-server.test.js`, `test/studio-views.test.js` (create) | Unit/integration tests. |
| `README.md` (modify) | Short "Studio" section. |

### Data shapes (used across tasks; keep names exactly)

```text
Tree (GET /api/tree):
{ project: string,                       // basename of root
  elements: [{ type, name, sheets: n, versions: n }],
  episodes: [{ id, shots: [ShotSummary] }],
  shots:    [ShotSummary] }              // flat (non-episodic) shots
ShotSummary = { shotId, versions: n, promotedVersion: string|null, mattes: n }

GET /api/shots?episode=<id|_>[&id=<shotId>]  -> { shots: [Shot] }   // Shot = scanShots() shape
GET /api/element?type=<t>&name=<n>          -> { type, name, sheets: [Sheet] }  // scanImages() shape
GET /api/selections                         -> { version: 1, selected: { [key]: ["v001", ...] } }
PUT /api/selections  body { key, versions } -> same as GET (whole document)
GET /api/matte-preview?src=<project-rel alpha path>&bg=<checker|white|black|gray|green>
    -> { state: 'ready', url: '/media/.pipeline/studio/previews/...mp4' }
     | { state: 'pending' }            // render queued/running; client polls
     | { state: 'error', error }       // ffmpeg failed (message = last stderr lines)

Selection keys:
  shotKey  = episode ? `${episode}/${shotId}` : shotId
  sheetKey = `${type}/${name}/${sheetType}/${slug}`
Client selection set entries: `${key}::${version}`
Episode route token for "no episode": "_"
```

---

## PR A — server, API, CLI

### Task 1: Detect `alpha.webm` mattes

`pipeline shot matte --format webm` writes `alpha.webm`, but the scanner only recognizes `alpha.mov`/`alpha.mp4`, so webm mattes never show up in review. The studio composites every matte server-side (Task 5), so the format only matters for discovery.

**Files:**
- Modify: `src/review-scan.js:54`
- Test: `test/review-scan.test.js` (append)

- [ ] **Step 1: Write the failing test** (append to `test/review-scan.test.js`; add `scanShots` to the existing import from `../src/review-scan.js`)

```js
test('scanShots: alpha.webm is surfaced as the matte variant', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, 'shots', 's1', 'drafts', 'v001');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'output.mp4'), 'x');
    await writeFile(path.join(dir, 'alpha.webm'), 'x');
    const m = await scanShots(root);
    assert.equal(m.shots[0].versions[0].variants.alpha, path.join('shots', 's1', 'drafts', 'v001', 'alpha.webm'));
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (`variants.alpha` is `null`)

Run: `node --test test/review-scan.test.js`

- [ ] **Step 3: Implement.** In `readVariants`, replace the alpha line:

```js
    if (name === 'alpha.mov' || name === 'alpha.mp4' || name === 'alpha.webm') out.alpha = path.join(versionDir, name);
```

- [ ] **Step 4: Run, expect PASS.** `node --test test/review-scan.test.js`
- [ ] **Step 5: Commit** `git commit -am "feat(review-scan): surface alpha.webm mattes"` (with the Co-Authored-By trailer)

### Task 2: Project tree scanner

**Files:**
- Create: `src/studio/tree.js`
- Test: `test/studio-tree.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/studio-tree.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanProjectTree, shotKey, sheetKey } from '../src/studio/tree.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-tree-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function seedDraft(shotRoot, id, v, extra = []) {
  const dir = path.join(shotRoot, 'shots', id, 'drafts', v);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'output.mp4'), 'x');
  for (const f of extra) await writeFile(path.join(dir, f), 'x');
}

test('scanProjectTree: elements (incl. empty), episodes, flat shots', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'elements', 'characters', 'mira', 'sheets', 'turnaround', 'hero'), { recursive: true });
    await writeFile(path.join(root, 'elements', 'characters', 'mira', 'sheets', 'turnaround', 'hero', 'v001.png'), 'x');
    await mkdir(path.join(root, 'elements', 'props', 'lamp'), { recursive: true });       // created, no sheets yet
    await seedDraft(path.join(root, 'episodes', '1'), 'ai-1', 'v001');
    await seedDraft(path.join(root, 'episodes', '1'), 'ai-1', 'v002', ['alpha.mov']);
    await mkdir(path.join(root, 'episodes', '2', 'shots'), { recursive: true });          // empty episode
    await seedDraft(root, 'pilot-1', 'v001');

    const t = await scanProjectTree(root);
    assert.equal(t.project, path.basename(root));
    assert.deepEqual(t.elements, [
      { type: 'characters', name: 'mira', sheets: 1, versions: 1 },
      { type: 'props', name: 'lamp', sheets: 0, versions: 0 },
    ]);
    assert.deepEqual(t.episodes.map((e) => e.id), ['1', '2']);
    assert.deepEqual(t.episodes[0].shots, [{ shotId: 'ai-1', versions: 2, promotedVersion: null, mattes: 1 }]);
    assert.deepEqual(t.episodes[1].shots, []);
    assert.deepEqual(t.shots.map((s) => s.shotId), ['pilot-1']);
  });
});

test('scanProjectTree: empty project yields empty lists', async () => {
  await withTempRoot(async (root) => {
    assert.deepEqual(await scanProjectTree(root),
      { project: path.basename(root), elements: [], episodes: [], shots: [] });
  });
});

test('shotKey/sheetKey', () => {
  assert.equal(shotKey({ episode: '1', shotId: 'ai-1' }), '1/ai-1');
  assert.equal(shotKey({ episode: null, shotId: 'pilot-1' }), 'pilot-1');
  assert.equal(sheetKey('characters', 'mira', { sheetType: 'turnaround', slug: 'hero' }), 'characters/mira/turnaround/hero');
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found). `node --test test/studio-tree.test.js`

- [ ] **Step 3: Implement**

```js
// src/studio/tree.js
// Compact project tree for the studio's navigation rail. Reuses the review
// scanners for shots/sheets so the studio and the static review pages agree on
// what a "version" is; adds element dirs with no sheets yet and empty episodes so
// the tree reflects everything the user has created, not only what has output.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { scanShots, scanImages, discoverShotRoots } from '../review-scan.js';

async function listDirs(p) {
  try {
    return (await readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function shotKey(s) { return s.episode ? `${s.episode}/${s.shotId}` : s.shotId; }
export function sheetKey(type, name, sh) { return `${type}/${name}/${sh.sheetType}/${sh.slug}`; }

function summarize(s) {
  return {
    shotId: s.shotId, versions: s.versions.length, promotedVersion: s.promotedVersion,
    mattes: s.versions.filter((v) => v.variants.alpha).length,
  };
}

export async function scanProjectTree(root) {
  const [shotModel, imageModel, shotRoots] = await Promise.all([
    scanShots(root), scanImages(root), discoverShotRoots(root),
  ]);

  const sheetsByEl = new Map(imageModel.characters.map((c) => [`${c.type}/${c.name}`, c.sheets]));
  const elements = [];
  const elementsDir = path.join(root, 'elements');
  for (const type of (await listDirs(elementsDir)).sort()) {
    for (const name of (await listDirs(path.join(elementsDir, type))).sort(naturalCompare)) {
      const sheets = sheetsByEl.get(`${type}/${name}`) || [];
      elements.push({ type, name, sheets: sheets.length,
        versions: sheets.reduce((a, sh) => a + sh.versions.length, 0) });
    }
  }

  const episodes = new Map();
  for (const r of shotRoots) if (r.episode != null) episodes.set(r.episode, []);
  const shots = [];
  for (const s of shotModel.shots) {
    if (s.episode == null) shots.push(summarize(s));
    else episodes.get(s.episode).push(summarize(s));
  }

  return {
    project: path.basename(root),
    elements,
    episodes: [...episodes.keys()].sort(naturalCompare).map((id) => ({ id, shots: episodes.get(id) })),
    shots,
  };
}
```

- [ ] **Step 4: Run, expect PASS.** `node --test test/studio-tree.test.js`
- [ ] **Step 5: Commit** `git add src/studio/tree.js test/studio-tree.test.js && git commit -m "feat(studio): project tree scanner"`

### Task 3: Media resolving + Range file serving

**Files:**
- Create: `src/studio/media.js`
- Test: `test/studio-media.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/studio-media.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveWithin, contentType, parseRange } from '../src/studio/media.js';

test('resolveWithin: accepts nested paths, rejects escapes', () => {
  const base = path.resolve('/proj');
  assert.equal(resolveWithin(base, 'shots/a/drafts/v001/output.mp4'), path.join(base, 'shots/a/drafts/v001/output.mp4'));
  assert.equal(resolveWithin(base, '../etc/passwd'), null);
  assert.equal(resolveWithin(base, 'shots/../../etc/passwd'), null);
  assert.equal(resolveWithin(base, '/etc/passwd'), null);
  assert.equal(resolveWithin(base, ''), null);
  assert.equal(resolveWithin(base, 'a\0b'), null);
  assert.equal(resolveWithin(base, '..foo/x.png'), path.join(base, '..foo/x.png'));
});

test('contentType: known media + fallback', () => {
  assert.equal(contentType('a.mp4'), 'video/mp4');
  assert.equal(contentType('a.WEBM'), 'video/webm');
  assert.equal(contentType('a.mov'), 'video/quicktime');
  assert.equal(contentType('a.png'), 'image/png');
  assert.equal(contentType('a.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('a.bin'), 'application/octet-stream');
});

test('parseRange: start-end, open-ended, suffix, invalid', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
  assert.equal(parseRange(undefined, 1000), null);          // no header -> full body
  assert.equal(parseRange('bytes=2000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-1', 1000), 'unsatisfiable');
  assert.equal(parseRange('items=0-1', 1000), null);        // unknown unit -> ignore, send full
});
```

- [ ] **Step 2: Run, expect FAIL.** `node --test test/studio-media.test.js`

- [ ] **Step 3: Implement**

```js
// src/studio/media.js
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

export function contentType(p) { return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

// Resolve a client-supplied relative path under `base`, or null if it is empty,
// contains NUL, is absolute, or escapes `base` after normalization.
export function resolveWithin(base, rel) {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const abs = path.resolve(base, rel);
  const r = path.relative(base, abs);
  if (r === '' || r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) return null;
  return abs;
}

// Single-range "bytes=" parser. Returns {start,end}, null (serve whole file), or
// 'unsatisfiable' (416). Multi-range requests are treated as "serve whole file".
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

export async function sendFile(req, res, abs) {
  let st;
  try { st = await stat(abs); } catch { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
  const headers = { 'Content-Type': contentType(abs), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const range = parseRange(req.headers.range, st.size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
    return res.end();
  }
  if (range) {
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`,
      'Content-Length': range.end - range.start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(abs, range).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(abs).pipe(res);
}
```

- [ ] **Step 4: Run, expect PASS.** `node --test test/studio-media.test.js`
- [ ] **Step 5: Commit** `git add src/studio/media.js test/studio-media.test.js && git commit -m "feat(studio): safe media path resolution and Range serving"`

### Task 4: Selection store

Selections live in `<project>/.pipeline/studio/selections.json`, the project's existing tool-state folder (it already holds `task`). That keeps them out of `elements/` and `shots/`. Selections never modify artifacts. Promoting a pick to `final/` is Phase 2 work.

**Files:**
- Create: `src/studio/selections.js`
- Test: `test/studio-selections.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/studio-selections.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSelections, setSelection, selectionsPath } from '../src/studio/selections.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-sel-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('readSelections: missing file -> empty doc', async () => {
  await withTempRoot(async (root) => {
    assert.deepEqual(await readSelections(root), { version: 1, selected: {} });
  });
});

test('setSelection: writes sorted, dedupes, empty list removes key', async () => {
  await withTempRoot(async (root) => {
    await setSelection(root, '1/ai-1', ['v010', 'v002', 'v002']);
    let doc = JSON.parse(await readFile(selectionsPath(root), 'utf8'));
    assert.deepEqual(doc.selected, { '1/ai-1': ['v002', 'v010'] });
    await setSelection(root, '1/ai-1', []);
    doc = await readSelections(root);
    assert.deepEqual(doc.selected, {});
  });
});

test('setSelection: rejects bad keys and versions', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(setSelection(root, '', ['v001']), /key/);
    await assert.rejects(setSelection(root, 'x'.repeat(600), ['v001']), /key/);
    await assert.rejects(setSelection(root, 'a', ['final']), /version/);
    await assert.rejects(setSelection(root, 'a', 'v001'), /versions/);
  });
});

test('setSelection: concurrent writes to different keys all land', async () => {
  await withTempRoot(async (root) => {
    await Promise.all(['a', 'b', 'c', 'd'].map((k) => setSelection(root, k, ['v001'])));
    assert.deepEqual(Object.keys((await readSelections(root)).selected).sort(), ['a', 'b', 'c', 'd']);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `node --test test/studio-selections.test.js`

- [ ] **Step 3: Implement**

```js
// src/studio/selections.js
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function selectionsPath(root) { return path.join(root, '.pipeline', 'studio', 'selections.json'); }

export async function readSelections(root) {
  try {
    const doc = JSON.parse(await readFile(selectionsPath(root), 'utf8'));
    return { version: 1, selected: doc && typeof doc.selected === 'object' && doc.selected ? doc.selected : {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, selected: {} };
    throw err;
  }
}

// Writes are read-modify-write on one file; chain them so concurrent PUTs from
// the page (fast checkbox clicks) can't drop each other's keys.
let chain = Promise.resolve();

export function setSelection(root, key, versions) {
  if (typeof key !== 'string' || !key || key.length > 512) return Promise.reject(new Error('selection: invalid key'));
  if (!Array.isArray(versions)) return Promise.reject(new Error('selection: versions must be an array'));
  for (const v of versions) {
    if (typeof v !== 'string' || !/^v\d+$/.test(v)) return Promise.reject(new Error(`selection: invalid version "${v}"`));
  }
  const sorted = [...new Set(versions)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const run = chain.then(async () => {
    const doc = await readSelections(root);
    if (sorted.length) doc.selected[key] = sorted; else delete doc.selected[key];
    const file = selectionsPath(root);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n');
    await rename(tmp, file);
    return doc;
  });
  chain = run.catch(() => {});
  return run;
}
```

- [ ] **Step 4: Run, expect PASS.** `node --test test/studio-selections.test.js`
- [ ] **Step 5: Commit** `git add src/studio/selections.js test/studio-selections.test.js && git commit -m "feat(studio): persisted version selections"`

### Task 5: Matte preview composites

The UI never plays a raw matte. The server composites the matte's alpha over a standard background and serves the resulting H.264 mp4. The filter graph below was verified on 2026-10-01 against synthetic ProRes 4444 `.mov` and VP9 `.webm` clips with opaque and 50% alpha regions. Note that **webm must be decoded with `-c:v libvpx-vp9`**: ffmpeg's native VP9 decoder silently drops alpha, and the composite comes out as a solid color.

The background is built from the matte stream itself (`split` → `[b]` → recolor), so it always matches the matte's size, frame rate and duration. No ffprobe step is needed.

Cache layout: `<root>/.pipeline/studio/previews/<source path minus extension>.<bg>.mp4`, e.g. `.pipeline/studio/previews/episodes/1/shots/ai-1/drafts/v002/alpha.checker.mp4`. A preview is stale when the source's mtime is newer, for example after re-pulling the matte.

**Files:**
- Create: `src/studio/matte-preview.js`
- Test: `test/studio-matte-preview.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/studio-matte-preview.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PREVIEW_BGS, buildPreviewArgs, previewRelPath, createPreviewer, runFfmpeg,
} from '../src/studio/matte-preview.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-mpv-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function seedAlpha(root, rel) {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), 'alpha');
}
// Fake ffmpeg: records calls, writes the output file (last arg) after a tick.
function fakeRun({ fail = false } = {}) {
  const calls = []; let active = 0; let maxActive = 0;
  const run = async (args) => {
    calls.push(args); active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    if (fail) throw new Error('ffmpeg exit 1: boom');
    await writeFile(args[args.length - 1], 'mp4');
  };
  return { run, calls, max: () => maxActive };
}

test('PREVIEW_BGS: the standard background set', () => {
  assert.deepEqual(Object.keys(PREVIEW_BGS), ['checker', 'white', 'black', 'gray', 'green']);
});

test('buildPreviewArgs: checker uses geq; solid uses drawbox color; webm forces libvpx decoder', () => {
  const c = buildPreviewArgs('/p/alpha.mov', '/o.mp4', 'checker');
  const graph = c[c.indexOf('-filter_complex') + 1];
  assert.match(graph, /geq=lum=/);
  assert.match(graph, /overlay=format=auto/);
  assert.ok(!c.includes('libvpx-vp9'));
  assert.equal(c[c.length - 1], '/o.mp4');
  const g = buildPreviewArgs('/p/alpha.webm', '/o.mp4', 'green');
  assert.match(g[g.indexOf('-filter_complex') + 1], /drawbox=.*color=0x00B140/);
  assert.ok(g.indexOf('libvpx-vp9') < g.indexOf('-i'), 'decoder flag must precede -i');
  assert.throws(() => buildPreviewArgs('/p/a.mov', '/o.mp4', 'plaid'), /unknown bg/);
});

test('previewRelPath mirrors the source under .pipeline/studio/previews', () => {
  assert.equal(previewRelPath('shots/a/drafts/v001/alpha.mov', 'checker'),
    path.join('.pipeline', 'studio', 'previews', 'shots', 'a', 'drafts', 'v001', 'alpha.checker.mp4'));
});

test('previewer: pending -> dedupes in-flight -> ready; re-renders when source is newer', async () => {
  await withTempRoot(async (root) => {
    const rel = 'shots/a/drafts/v001/alpha.mov';
    await seedAlpha(root, rel);
    const f = fakeRun();
    const pv = createPreviewer({ root, run: f.run });
    assert.deepEqual(await pv.request(rel, 'checker'), { state: 'pending' });
    assert.deepEqual(await pv.request(rel, 'checker'), { state: 'pending' });
    await pv.drain();
    assert.equal(f.calls.length, 1);
    const ready = await pv.request(rel, 'checker');
    assert.equal(ready.state, 'ready');
    assert.equal(ready.url, '/media/.pipeline/studio/previews/shots/a/drafts/v001/alpha.checker.mp4');
    assert.ok((await stat(path.join(root, previewRelPath(rel, 'checker')))).isFile());
    // Re-pulled matte: source mtime moves past the preview's.
    const future = new Date(Date.now() + 60_000);
    await utimes(path.join(root, rel), future, future);
    assert.deepEqual(await pv.request(rel, 'checker'), { state: 'pending' });
    await pv.drain();
    assert.equal(f.calls.length, 2);
  });
});

test('previewer: concurrency limit, failures are sticky per source version, missing source', async () => {
  await withTempRoot(async (root) => {
    const rels = ['a', 'b', 'c', 'd'].map((s) => `shots/${s}/drafts/v001/alpha.mov`);
    for (const r of rels) await seedAlpha(root, r);
    const f = fakeRun();
    const pv = createPreviewer({ root, run: f.run, concurrency: 2 });
    for (const r of rels) await pv.request(r, 'white');
    await pv.drain();
    assert.equal(f.max(), 2);

    const bad = fakeRun({ fail: true });
    const pv2 = createPreviewer({ root, run: bad.run });
    await pv2.request(rels[0], 'black');
    await pv2.drain();
    const err = await pv2.request(rels[0], 'black');
    assert.equal(err.state, 'error');
    assert.match(err.error, /boom/);
    assert.equal(bad.calls.length, 1, 'no retry loop until the source changes');

    assert.deepEqual(await pv.request('shots/zzz/alpha.mov', 'checker'), { state: 'error', error: 'source not found' });
    await assert.rejects(pv.request(rels[0], 'plaid'), /unknown bg/);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('previewer + real ffmpeg: ProRes 4444 alpha composites to an mp4', { skip: !hasFfmpeg && 'ffmpeg not on PATH' }, async () => {
  await withTempRoot(async (root) => {
    const rel = 'shots/a/drafts/v001/alpha.mov';
    await mkdir(path.join(root, 'shots/a/drafts/v001'), { recursive: true });
    const src = "color=c=red:s=64x48:d=0.2,format=rgba,geq=r=255:g=0:b=0:a='if(lt(X,32),255,0)'";
    assert.equal(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', src,
      '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', path.join(root, rel)]).status, 0);
    const pv = createPreviewer({ root, run: runFfmpeg });
    await pv.request(rel, 'checker');
    await pv.drain();
    const r = await pv.request(rel, 'checker');
    assert.equal(r.state, 'ready', JSON.stringify(r));
    assert.ok((await stat(path.join(root, previewRelPath(rel, 'checker')))).size > 0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `node --test test/studio-matte-preview.test.js`

- [ ] **Step 3: Implement**

```js
// src/studio/matte-preview.js
// Composites a matte (alpha .mov/.webm) over a standard background into a
// browser-playable H.264 mp4, cached under .pipeline/studio/previews/. The UI
// shows only these composites, never the raw ProRes/VP9-alpha file.
import { spawn } from 'node:child_process';
import { mkdir, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';

// Solid colors as ffmpeg hex; `checker` is generated with geq.
export const PREVIEW_BGS = {
  checker: null, white: '0xFFFFFF', black: '0x000000', gray: '0x808080', green: '0x00B140',
};
const PREVIEW_DIR = path.join('.pipeline', 'studio', 'previews');

export function previewRelPath(srcRel, bg) {
  return path.join(PREVIEW_DIR, `${srcRel.replace(/\.[^./\\]+$/, '')}.${bg}.mp4`);
}

// The background is derived from the matte stream itself ([b]), so it always
// matches the matte's size/fps/duration with no ffprobe step.
export function buildPreviewArgs(input, output, bg) {
  if (!Object.hasOwn(PREVIEW_BGS, bg)) throw new Error(`matte preview: unknown bg "${bg}"`);
  const bgChain = bg === 'checker'
    ? "format=gray,geq=lum='if(mod(floor(X/16)+floor(Y/16),2),204,255)',format=yuv420p"
    : `format=yuv420p,drawbox=x=0:y=0:w=iw:h=ih:color=${PREVIEW_BGS[bg]}:t=fill`;
  const graph = `[0:v]format=rgba,split[fg][b];[b]${bgChain}[bg];`
    + '[bg][fg]overlay=format=auto,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[out]';
  // ffmpeg's native VP9 decoder drops alpha; libvpx keeps it.
  const decoder = /\.webm$/i.test(input) ? ['-c:v', 'libvpx-vp9'] : [];
  return ['-y', '-v', 'error', ...decoder, '-i', input, '-filter_complex', graph,
    '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-movflags', '+faststart', output];
}

export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let err = '';
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg not found on PATH' : e.message)));
    child.on('close', (code) => (code === 0 ? resolve()
      : reject(new Error(`ffmpeg exit ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

function mediaUrl(rel) { return '/media/' + rel.split(path.sep).map(encodeURIComponent).join('/'); }
async function mtime(p) { try { return (await stat(p)).mtimeMs; } catch { return null; } }

export function createPreviewer({ root, run = runFfmpeg, concurrency = 2 }) {
  const inflight = new Set();   // preview rel paths queued or rendering
  const failed = new Map();     // preview rel -> { srcM, message }; sticky until the source changes
  const jobs = new Set();       // running job promises (for drain())
  const queue = [];
  let active = 0;

  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active++;
      const p = job().finally(() => { active--; jobs.delete(p); pump(); });
      jobs.add(p);
    }
  }

  // Never waits for a render: returns the current state and queues work if needed.
  async function request(srcRel, bg) {
    if (!Object.hasOwn(PREVIEW_BGS, bg)) throw new Error(`matte preview: unknown bg "${bg}"`);
    const src = path.join(root, srcRel);
    const srcM = await mtime(src);
    if (srcM == null) return { state: 'error', error: 'source not found' };
    const rel = previewRelPath(srcRel, bg);
    const out = path.join(root, rel);
    const outM = await mtime(out);
    if (outM != null && outM >= srcM) return { state: 'ready', url: mediaUrl(rel) };
    if (inflight.has(rel)) return { state: 'pending' };
    const f = failed.get(rel);
    if (f && f.srcM === srcM) return { state: 'error', error: f.message };
    failed.delete(rel);
    inflight.add(rel);
    queue.push(async () => {
      const tmp = `${out}.tmp.mp4`;
      try {
        await mkdir(path.dirname(out), { recursive: true });
        await run(buildPreviewArgs(src, tmp, bg));
        await rename(tmp, out);
      } catch (err) {
        failed.set(rel, { srcM, message: err.message });
        await rm(tmp, { force: true });
      } finally {
        inflight.delete(rel);
      }
    });
    pump();
    return { state: 'pending' };
  }

  // Test helper: resolves once the queue is empty and nothing is running.
  async function drain() {
    while (jobs.size || queue.length) await Promise.all([...jobs]);
  }

  return { request, drain };
}
```

- [ ] **Step 4: Run, expect PASS.** `node --test test/studio-matte-preview.test.js`. The real-ffmpeg test should run, not be skipped, on this machine.
- [ ] **Step 5: Commit** `git add src/studio/matte-preview.js test/studio-matte-preview.test.js && git commit -m "feat(studio): cached matte-over-background preview composites"`

### Task 6: HTTP server + JSON API

**Files:**
- Modify: `src/review-render.js` (append one export line at the end)
- Create: `src/studio/server.js`
- Create (placeholder until Task 8 replaces it): `src/studio/web/index.html` containing `<!doctype html><title>Studio</title>`
- Test: `test/studio-server.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/studio-server.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startStudio } from '../src/studio/server.js';

let outer, root, server, base;
before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), 'studio-srv-'));
  root = path.join(outer, 'proj');
  const dir = path.join(root, 'episodes', '1', 'shots', 'ai-1', 'drafts', 'v001');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'output.mp4'), '0123456789');
  await mkdir(path.join(root, 'elements', 'characters', 'mira', 'sheets', 'pose', 'wave'), { recursive: true });
  await writeFile(path.join(root, 'elements', 'characters', 'mira', 'sheets', 'pose', 'wave', 'v001.png'), 'png');
  await writeFile(path.join(outer, 'secret.txt'), 'nope');
  // Stub previewer: the endpoint's validation + passthrough is what's under test here
  // (rendering is covered by test/studio-matte-preview.test.js).
  const previewer = { request: async (src, bg) => ({ state: 'pending', src, bg }) };
  ({ server, url: base } = await startStudio({ root, port: 0, previewer }));
});
after(async () => { server.close(); await rm(outer, { recursive: true, force: true }); });

test('GET / serves the shell; /review.css serves the shared review style', async () => {
  const html = await fetch(base).then((r) => r.text());
  assert.match(html, /<!doctype html>/i);
  const css = await fetch(base + 'review.css');
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.match(await css.text(), /--accent/);
});

test('GET /api/tree', async () => {
  const t = await fetch(base + 'api/tree').then((r) => r.json());
  assert.equal(t.episodes[0].shots[0].shotId, 'ai-1');
  assert.equal(t.elements[0].name, 'mira');
});

test('GET /api/shots filters by episode and id', async () => {
  const all = await fetch(base + 'api/shots?episode=1').then((r) => r.json());
  assert.equal(all.shots.length, 1);
  assert.equal(all.shots[0].versions[0].video, path.join('episodes', '1', 'shots', 'ai-1', 'drafts', 'v001', 'output.mp4'));
  const none = await fetch(base + 'api/shots?episode=_').then((r) => r.json());
  assert.equal(none.shots.length, 0);
  const one = await fetch(base + 'api/shots?episode=1&id=nope').then((r) => r.json());
  assert.equal(one.shots.length, 0);
});

test('GET /api/element', async () => {
  const el = await fetch(base + 'api/element?type=characters&name=mira').then((r) => r.json());
  assert.equal(el.sheets[0].sheetType, 'pose');
  const missing = await fetch(base + 'api/element?type=props&name=x').then((r) => r.json());
  assert.deepEqual(missing.sheets, []);
});

test('GET /media supports Range and blocks traversal', async () => {
  const p = 'media/episodes/1/shots/ai-1/drafts/v001/output.mp4';
  const r = await fetch(base + p, { headers: { Range: 'bytes=2-4' } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), '234');
  const esc = await fetch(base + 'media/shots%2F..%2F..%2Fsecret.txt');
  assert.equal(esc.status, 404);
});

test('PUT /api/selections round-trips; requires JSON content type', async () => {
  const put = await fetch(base + 'api/selections', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: '1/ai-1', versions: ['v001'] }) });
  assert.equal(put.status, 200);
  assert.deepEqual((await put.json()).selected, { '1/ai-1': ['v001'] });
  const got = await fetch(base + 'api/selections').then((r) => r.json());
  assert.deepEqual(got.selected, { '1/ai-1': ['v001'] });
  const bad = await fetch(base + 'api/selections', { method: 'PUT', body: '{"key":"a","versions":[]}' });
  assert.equal(bad.status, 415);
  const invalid = await fetch(base + 'api/selections', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'a', versions: ['final'] }) });
  assert.equal(invalid.status, 400);
});

test('GET /api/matte-preview validates src/bg and delegates to the previewer', async () => {
  const q = (src, bg) => fetch(`${base}api/matte-preview?src=${encodeURIComponent(src)}${bg ? `&bg=${bg}` : ''}`);
  const ok = await q('episodes/1/shots/ai-1/drafts/v001/alpha.mov');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(),
    { state: 'pending', src: path.join('episodes', '1', 'shots', 'ai-1', 'drafts', 'v001', 'alpha.mov'), bg: 'checker' });
  assert.equal((await q('episodes/1/shots/ai-1/drafts/v001/alpha.webm', 'green')).status, 200);
  assert.equal((await q('episodes/1/shots/ai-1/drafts/v001/output.mp4')).status, 400);   // not a matte
  assert.equal((await q('../secret/alpha.mov')).status, 400);                            // escapes root
  assert.equal((await q('.pipeline/studio/previews/x/alpha.mov')).status, 400);          // cache dir
  assert.equal((await q('shots/a/alpha.mov', 'plaid')).status, 400);                    // unknown bg
});

test('rejects foreign Host headers (DNS-rebinding guard)', async () => {
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: '/api/tree', headers: { Host: 'evil.example' } },
      (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 403);
});
```

- [ ] **Step 2: Run, expect FAIL.** `node --test test/studio-server.test.js`

- [ ] **Step 3: Export the shared style.** Append to the end of `src/review-render.js`:

```js
// Shared with the studio UI (served as /review.css) so both surfaces keep one look.
export { STYLE as REVIEW_STYLE };
```

- [ ] **Step 4: Create the placeholder shell** `src/studio/web/index.html`:

```html
<!doctype html><title>Studio</title>
```

- [ ] **Step 5: Implement the server**

```js
// src/studio/server.js
// Local-only review server. Binds to 127.0.0.1, serves the project's media in
// place (no vendoring), and answers a small JSON API built on the review scanners.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanShots, scanImages } from '../review-scan.js';
import { REVIEW_STYLE } from '../review-render.js';
import { scanProjectTree } from './tree.js';
import { resolveWithin, sendFile } from './media.js';
import { readSelections, setSelection } from './selections.js';
import { createPreviewer, PREVIEW_BGS } from './matte-preview.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_BODY = 64 * 1024;

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return null; } }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle({ root, previewer }, req, res) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return sendJson(res, 403, { error: 'forbidden host' });

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const get = req.method === 'GET' || req.method === 'HEAD';

  if (get && p === '/') return sendFile(req, res, path.join(WEB, 'index.html'));
  if (get && p === '/review.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(REVIEW_STYLE);
  }
  if (get && p.startsWith('/static/')) {
    const abs = resolveWithin(WEB, safeDecode(p.slice('/static/'.length)));
    return abs ? sendFile(req, res, abs) : sendJson(res, 404, { error: 'not found' });
  }
  if (get && p.startsWith('/media/')) {
    const abs = resolveWithin(root, safeDecode(p.slice('/media/'.length)));
    return abs ? sendFile(req, res, abs) : sendJson(res, 404, { error: 'not found' });
  }

  if (get && p === '/api/tree') return sendJson(res, 200, await scanProjectTree(root));

  if (get && p === '/api/shots') {
    const ep = url.searchParams.get('episode');
    const id = url.searchParams.get('id');
    const model = await scanShots(root, ep && ep !== '_' ? { episodes: [ep] } : {});
    let shots = model.shots;
    if (ep === '_') shots = shots.filter((s) => s.episode == null);
    if (id) shots = shots.filter((s) => s.shotId === id);
    return sendJson(res, 200, { shots });
  }

  if (get && p === '/api/element') {
    const type = url.searchParams.get('type');
    const name = url.searchParams.get('name');
    const model = await scanImages(root);
    const el = model.characters.find((c) => c.type === type && c.name === name);
    return sendJson(res, 200, { type, name, sheets: el ? el.sheets : [] });
  }

  if (get && p === '/api/matte-preview') {
    const src = url.searchParams.get('src');
    const bg = url.searchParams.get('bg') || 'checker';
    // Only real matte files inside the project; the previews cache itself is off-limits.
    if (!resolveWithin(root, src) || !/(^|[\\/])alpha\.(mov|webm|mp4)$/i.test(src)
      || src.startsWith('.pipeline') || !Object.hasOwn(PREVIEW_BGS, bg)) {
      return sendJson(res, 400, { error: 'invalid src or bg' });
    }
    return sendJson(res, 200, await previewer.request(path.normalize(src), bg));
  }

  if (p === '/api/selections') {
    if (get) return sendJson(res, 200, await readSelections(root));
    if (req.method === 'PUT') {
      // Requiring application/json forces a CORS preflight for cross-origin
      // pages, which this server never answers, so other sites can't write here.
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
        return sendJson(res, 415, { error: 'expected application/json' });
      }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }
      try {
        return sendJson(res, 200, await setSelection(root, body && body.key, body && body.versions));
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

export function createStudioServer({ root, previewer = createPreviewer({ root }) }) {
  const ctx = { root, previewer };
  return http.createServer((req, res) => {
    handle(ctx, req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.destroy(err);
    });
  });
}

export function startStudio({ root, port = 4870, host = '127.0.0.1', previewer }) {
  const server = createStudioServer({ root, previewer });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ server, url: `http://${host}:${server.address().port}/` });
    });
  });
}
```

- [ ] **Step 6: Run, expect PASS.** `node --test test/studio-server.test.js`, then `npm test` (full suite still green).
- [ ] **Step 7: Commit** `git add src/review-render.js src/studio/server.js src/studio/web/index.html test/studio-server.test.js && git commit -m "feat(studio): local review server and JSON API"`

### Task 7: `pipeline studio` CLI

**Files:**
- Modify: `bin/pipeline.js` (new branch before the final `else`; new usage line)

- [ ] **Step 1: Add the command.** Insert before `} else if (cmd === 'init') {`:

```js
  } else if (cmd === 'studio') {
    // Single-word command; `sub` may carry the first flag (like sync-skills).
    const f = parseFlags([sub, ...rest].filter((x) => x != null));
    const root = projectRoot(f.root);
    const port = f.port != null ? Number(f.port) : 4870;
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`studio: invalid --port "${f.port}"`);
    const { startStudio } = await import('../src/studio/server.js');
    const { url } = await startStudio({ root, port });
    console.log(`studio: ${url}  (project: ${root})  — Ctrl+C to stop`);
```

Add to the usage array, after the `sync-skills` line:

```js
      '  pipeline studio [--port <n=4870>] [--root <dir>]   # local web UI: browse the project tree, compare + select versions',
```

- [ ] **Step 2: Smoke test by hand** (from any project dir with shots):

```bash
node bin/pipeline.js studio --root /path/to/a/project --port 4871
```

In another shell, `curl -s localhost:4871/api/tree | head -c 400` should print JSON. `curl -sI -H 'Range: bytes=0-9' localhost:4871/media/<a real clip path>` should print `206`. Stop it with Ctrl+C. `EADDRINUSE` on a busy port should print a one-line error and exit 1 (through `main().catch`).

- [ ] **Step 3: Commit** `git commit -am "feat(cli): pipeline studio"`
- [ ] **Step 4: Open PR A** (`gh pr create`, title "studio: local review server + API"). The body lists the API and the security notes (localhost bind, Host check, JSON-only PUT, traversal guard). **Ask the user before merging.**

---

## PR B — review UI

Branch PR B off `main` after PR A merges, or stack it on PR A's branch and retarget later.

### Task 8: Shell + studio styles

**Files:**
- Replace: `src/studio/web/index.html`
- Create: `src/studio/web/studio.css`

- [ ] **Step 1: Write the shell.** It uses the same skeleton as `review-render.js`'s `page()` (rail / toolbar / grid) so `/review.css` applies unchanged.

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio</title>
<link rel="stylesheet" href="/review.css">
<link rel="stylesheet" href="/static/studio.css">
</head>
<body>
<div class="wrap">
  <aside class="rail" id="rail"></aside>
  <main>
    <div class="toolbar">
      <div class="toolbar-head">
        <h1 id="title">Studio</h1>
        <p class="sub" id="subtitle"></p>
        <div class="toolbar-actions" id="toolbar"></div>
      </div>
    </div>
    <div id="grid"></div>
  </main>
</div>
<script type="module" src="/static/app.js"></script>
</body></html>
```

- [ ] **Step 2: Write `studio.css`**. Studio-only additions; every color comes from the `review.css` tokens.

```css
/* Studio additions on top of /review.css (the static review page's style). */
.wrap { grid-template-columns:260px minmax(0,1fr); }
.rail .proj { font-size:1rem; color:var(--fg); text-transform:none; letter-spacing:0; margin-bottom:.8rem; }
.rail .grp { color:var(--dim); font-size:.75rem; margin:.5rem 0 .1rem; text-transform:lowercase; }
.rail a.node { display:flex; justify-content:space-between; gap:.5rem; color:var(--fg); text-decoration:none;
  font-size:.88rem; padding:.12rem .4rem; border-radius:5px; }
.rail a.node:hover { background:var(--panel); }
.rail a.node.on { background:var(--panel); color:var(--accent); box-shadow:inset 2px 0 0 var(--accent); }
.rail a.node .meta { color:var(--dim); font-size:.72rem; font-family:ui-monospace,Menlo,monospace; }
.rail .nested a.node { padding-left:1.1rem; font-family:ui-monospace,Menlo,monospace; font-size:.8rem; }
.rail .empty { color:var(--dim); font-size:.8rem; padding:.1rem .4rem; }
.toolbar .seg { display:inline-flex; }
.toolbar .seg button { border-radius:0; }
.toolbar .seg button:first-child { border-radius:6px 0 0 6px; }
.toolbar .seg button:last-child { border-radius:0 6px 6px 0; border-left:none; }
.mpv { aspect-ratio:16/9; display:flex; align-items:center; justify-content:center; text-align:center;
  border:1px dashed var(--line); border-radius:6px; color:var(--dim); font-size:.8rem; padding:.5rem; }
.mpv.err { color:var(--warn); border-color:var(--warn); }
.toolbar .bgs { display:inline-flex; gap:.25rem; align-items:center; color:var(--dim); font-size:.75rem; }
.toolbar .bgs button { width:22px; height:22px; padding:0; border-radius:50%; }
.toolbar .bgs button.on { box-shadow:0 0 0 2px var(--accent); }
.toolbar .bgs [data-bg="checker"] { background:repeating-conic-gradient(#cfd2d8 0 25%, #fff 0 50%) 0 0/10px 10px; }
.toolbar .bgs [data-bg="white"] { background:#fff; }
.toolbar .bgs [data-bg="black"] { background:#000; }
.toolbar .bgs [data-bg="gray"] { background:#808080; }
.toolbar .bgs [data-bg="green"] { background:#00b140; }
.qc { display:grid; grid-template-columns:repeat(auto-fill,minmax(70px,1fr)); gap:.3rem; margin-top:.4rem; }
.qc img { border-radius:4px; }
.cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:1rem; }
.card { display:block; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.9rem;
  color:var(--fg); text-decoration:none; }
.card:hover { border-color:var(--accent); }
.card .n { font-size:1.6rem; font-weight:600; }
.card .l { color:var(--dim); font-size:.82rem; }
@media (max-width: 760px) { .wrap { grid-template-columns:1fr; } .rail { position:static; max-height:none; } }
```

- [ ] **Step 3: Commit** `git add src/studio/web && git commit -m "feat(studio): UI shell and styles"`

### Task 9: Pure view builders

**Files:**
- Create: `src/studio/web/views.js`
- Test: `test/studio-views.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/studio-views.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esc, mediaUrl, parseRoute, treeHTML, homeHTML, shotRowsHTML, sheetRowsHTML,
} from '../src/studio/web/views.js';

const TREE = {
  project: 'demo',
  elements: [{ type: 'characters', name: 'mira', sheets: 2, versions: 5 }, { type: 'props', name: 'lamp', sheets: 0, versions: 0 }],
  episodes: [{ id: '1', shots: [{ shotId: 'ai-1', versions: 3, promotedVersion: 'v002', mattes: 1 }] }],
  shots: [],
};
const SHOT = {
  shotId: 'ai-1', episode: '1', description: 'hello <b>', characters: ['mira'], promotedVersion: 'v002',
  versions: [
    { version: 'v001', promoted: false, video: 'episodes/1/shots/ai-1/drafts/v001/output.mp4', variants: { alpha: null, upscaled: [], qc: [] }, meta: { model: 'seedance' } },
    { version: 'v002', promoted: true, video: 'episodes/1/shots/ai-1/drafts/v002/output.mp4', variants: { alpha: 'episodes/1/shots/ai-1/drafts/v002/alpha.webm', upscaled: [], qc: ['episodes/1/shots/ai-1/drafts/v002/qc/f0.png'] }, meta: {} },
  ],
};
const empty = () => ({ selected: new Set(), hidden: new Set(), mode: 'clips', bg: 'checker', onlySelected: false });

test('esc + mediaUrl', () => {
  assert.equal(esc('<a "b">'), '&lt;a &quot;b&quot;&gt;');
  assert.equal(mediaUrl('shots/a b/v#1.mp4'), '/media/shots/a%20b/v%231.mp4');
  assert.equal(mediaUrl(null), null);
});

test('parseRoute', () => {
  assert.deepEqual(parseRoute(''), { view: 'home' });
  assert.deepEqual(parseRoute('#/element/characters/mira'), { view: 'element', type: 'characters', name: 'mira' });
  assert.deepEqual(parseRoute('#/episode/_'), { view: 'episode', episode: '_' });
  assert.deepEqual(parseRoute('#/shot/1/ai-1'), { view: 'shot', episode: '1', shotId: 'ai-1' });
  assert.deepEqual(parseRoute('#/bogus/x'), { view: 'home' });
});

test('treeHTML: lists elements by type, episodes with nested shots, marks current', () => {
  const h = treeHTML(TREE, '#/shot/1/ai-1');
  assert.match(h, /href="#\/element\/characters\/mira"/);
  assert.match(h, /href="#\/element\/props\/lamp"/);
  assert.match(h, /href="#\/episode\/1"/);
  assert.match(h, /class="node on" href="#\/shot\/1\/ai-1"/);
  assert.doesNotMatch(h, /All shots/);                  // no flat shots in this tree
});

test('homeHTML: counts', () => {
  const h = homeHTML(TREE);
  assert.match(h, />2<\/div><div class="l">elements/);
  assert.match(h, />1<\/div><div class="l">episodes/);
});

test('shotRowsHTML clips mode: videos, final badge, selection state, escaping', () => {
  const st = empty(); st.selected.add('1/ai-1::v001');
  const h = shotRowsHTML([SHOT], st);
  assert.match(h, /data-row="1\/ai-1"/);
  assert.match(h, /<video src="\/media\/episodes\/1\/shots\/ai-1\/drafts\/v001\/output.mp4"/);
  assert.match(h, /<span class="badge">final<\/span>/);
  assert.match(h, /class="col selected"/);
  assert.match(h, /hello &lt;b&gt;/);
});

test('shotRowsHTML mattes mode: composite placeholder (never the raw alpha), qc thumbs, "no matte"', () => {
  const st = empty(); st.mode = 'mattes'; st.bg = 'green';
  const h = shotRowsHTML([SHOT], st);
  assert.match(h, /<div class="mpv" data-src="episodes\/1\/shots\/ai-1\/drafts\/v002\/alpha.webm" data-bg="green">/);
  assert.doesNotMatch(h, /<video src="[^"]*alpha\./);
  assert.match(h, /<a href="\/media\/[^"]*alpha.webm" download>alpha<\/a>/);
  assert.match(h, /<div class="qc"><img src="\/media\/episodes\/1\/shots\/ai-1\/drafts\/v002\/qc\/f0.png"/);
  assert.match(h, /no matte/);
});

test('shotRowsHTML hidden + onlySelected', () => {
  const st = empty(); st.hidden.add('1/ai-1::v001');
  let h = shotRowsHTML([SHOT], st);
  assert.match(h, /class="hmark" data-key="1\/ai-1" data-v="v001"/);
  assert.match(h, /show 1 hidden/);
  const st2 = empty(); st2.onlySelected = true;
  h = shotRowsHTML([SHOT], st2);
  assert.match(h, /no selected versions/);
});

test('sheetRowsHTML: one row per sheet, images, keyed by type/name/sheet/slug', () => {
  const el = { type: 'characters', name: 'mira', sheets: [
    { sheetType: 'pose', slug: 'wave', versions: [{ version: 'v001', images: ['elements/characters/mira/sheets/pose/wave/v001.png'], upscaled: [], meta: {} }] },
  ] };
  const h = sheetRowsHTML(el, empty());
  assert.match(h, /data-row="characters\/mira\/pose\/wave"/);
  assert.match(h, /<img src="\/media\/elements\/characters\/mira\/sheets\/pose\/wave\/v001.png"/);
  assert.equal(sheetRowsHTML({ ...el, sheets: [] }, empty()).includes('No sheets yet'), true);
});
```

- [ ] **Step 2: Run, expect FAIL.** `node --test test/studio-views.test.js`

- [ ] **Step 3: Implement.** The markup and class names mirror `SHOT_SCRIPT`/`IMAGE_SCRIPT`/`COMMON_SCRIPT` in `src/review-render.js` so `/review.css` styles it unchanged.

```js
// src/studio/web/views.js
// Pure HTML builders for the studio. No DOM access, so node:test can import
// them. Markup mirrors src/review-render.js so the shared /review.css applies.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function mediaUrl(rel) {
  return rel ? '/media/' + rel.split(/[\\/]/).map(encodeURIComponent).join('/') : null;
}

const enc = encodeURIComponent;

// Must match PREVIEW_BGS keys in src/studio/matte-preview.js (the server 400s otherwise).
export const MATTE_BGS = ['checker', 'white', 'black', 'gray', 'green'];

export function parseRoute(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'element' && parts.length === 3) return { view: 'element', type: parts[1], name: parts[2] };
  if (parts[0] === 'episode' && parts.length === 2) return { view: 'episode', episode: parts[1] };
  if (parts[0] === 'shot' && parts.length === 3) return { view: 'shot', episode: parts[1], shotId: parts[2] };
  return { view: 'home' };
}

function node(href, label, meta, current) {
  return `<a class="node${href === current ? ' on' : ''}" href="${esc(href)}"><span>${esc(label)}</span>`
    + (meta ? `<span class="meta">${esc(meta)}</span>` : '') + '</a>';
}

function shotNodes(epToken, shots, current) {
  if (!shots.length) return '<div class="empty">no shots yet</div>';
  return '<div class="nested">' + shots.map((s) =>
    node(`#/shot/${enc(epToken)}/${enc(s.shotId)}`, s.shotId,
      `${s.versions}v${s.promotedVersion ? ' ★' : ''}`, current)).join('') + '</div>';
}

export function treeHTML(tree, current) {
  let h = node('#/', tree.project, '', current).replace('class="node', 'class="node proj');
  h += '<h3>Elements</h3>';
  if (!tree.elements.length) h += '<div class="empty">none yet</div>';
  let lastType = null;
  for (const e of tree.elements) {
    if (e.type !== lastType) { h += `<div class="grp">${esc(e.type)}</div>`; lastType = e.type; }
    h += node(`#/element/${enc(e.type)}/${enc(e.name)}`, e.name, e.sheets ? `${e.sheets} sh` : '—', current);
  }
  if (tree.episodes.length) {
    h += '<h3>Episodes</h3>';
    for (const ep of tree.episodes) {
      h += node(`#/episode/${enc(ep.id)}`, `Episode ${ep.id}`, `${ep.shots.length}`, current);
      h += shotNodes(ep.id, ep.shots, current);
    }
  }
  if (tree.shots.length) {
    h += '<h3>Shots</h3>' + node('#/episode/_', 'All shots', `${tree.shots.length}`, current);
    h += shotNodes('_', tree.shots, current);
  }
  return h;
}

export function homeHTML(tree) {
  const nShots = tree.shots.length + tree.episodes.reduce((a, e) => a + e.shots.length, 0);
  const nMattes = [...tree.shots, ...tree.episodes.flatMap((e) => e.shots)].reduce((a, s) => a + s.mattes, 0);
  const card = (n, l) => `<div class="card"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;
  return '<div class="cards">' + card(tree.elements.length, 'elements') + card(tree.episodes.length, 'episodes')
    + card(nShots, 'shots') + card(nMattes, 'mattes') + '</div>';
}

function selectbox(key, v, state) {
  const on = state.selected.has(`${key}::${v}`) ? ' checked' : '';
  return `<label class="select"><input type="checkbox" class="selectbox" data-key="${esc(key)}" data-v="${esc(v)}"${on}>select</label>`;
}

function hmark(key, v) {
  return `<button class="hmark" data-key="${esc(key)}" data-v="${esc(v)}" title="Show ${esc(v)}">`
    + `<span class="lbl">${esc(v)}</span><span class="bar"></span></button>`;
}

function colShell(key, v, state, { badge = '', body, meta = '', links = '' }) {
  const on = state.selected.has(`${key}::${v}`) ? ' selected' : '';
  const hide = `<button class="hide" data-key="${esc(key)}" data-v="${esc(v)}">hide</button>`;
  return `<div class="col${on}"><div class="vrow"><span class="v">${esc(v)}${badge}</span>`
    + `<span class="ctl">${selectbox(key, v, state)}${hide}</span></div>${body}`
    + `<div class="m">${esc(meta)}</div><div class="links">${links}</div></div>`;
}

function shotCol(v, key, state) {
  const badge = v.promoted ? '<span class="badge">final</span>' : '';
  const meta = [v.meta.model, v.meta.resolution, v.meta.ts].filter(Boolean).join(' · ');
  let body;
  if (state.mode === 'mattes') {
    // Placeholder only: app.js asks /api/matte-preview for the composite of this
    // matte over state.bg and swaps in a <video> once it is ready.
    body = v.variants.alpha
      ? `<div class="mpv" data-src="${esc(v.variants.alpha)}" data-bg="${esc(state.bg)}">rendering ${esc(state.bg)} preview…</div>`
      : '<div class="missing">no matte</div>';
    if (v.variants.qc.length) {
      body += '<div class="qc">' + v.variants.qc.filter((q) => /\.(png|jpe?g|webp)$/i.test(q))
        .map((q) => `<img src="${esc(mediaUrl(q))}" loading="lazy">`).join('') + '</div>';
    }
  } else {
    body = v.video
      ? `<video src="${esc(mediaUrl(v.video))}" controls preload="metadata"></video>`
      : '<div class="missing">missing artifact</div>';
  }
  // The raw alpha file is linked for download only — never played inline.
  const links = (v.variants.upscaled || []).map((u) => `<a href="${esc(mediaUrl(u))}" target="_blank">upscaled</a>`).join('')
    + (v.variants.alpha ? `<a href="${esc(mediaUrl(v.variants.alpha))}" download>alpha</a>` : '');
  return colShell(key, v.version, state, { badge, body, meta, links });
}

function sheetCol(v, key, state) {
  const body = (v.images || []).map((s) => `<img src="${esc(mediaUrl(s))}" loading="lazy">`).join('')
    || '<div class="missing">missing artifact</div>';
  const meta = [v.meta.model, v.meta.ts].filter(Boolean).join(' · ');
  const links = (v.upscaled || []).map((u) => `<a href="${esc(mediaUrl(u))}" target="_blank">upscaled</a>`).join('');
  return colShell(key, v.version, state, { body, meta, links });
}

// One review row. `cols(v)` renders a visible column; hidden versions collapse
// to an hmark; onlySelected drops everything unselected. Same rules as the
// static review page's rowHTML.
export function rowHTML({ key, title, tags = '', versions, col }, state) {
  if (state.onlySelected) {
    const cols = versions.filter((v) => state.selected.has(`${key}::${v.version}`)).map(col).join('');
    return `<section class="row"><div class="rowhead"><h2>${esc(title)}</h2></div><div class="tags">${tags}</div>`
      + `<div class="cols selected-only" data-row="${esc(key)}">${cols || '<span class="m">no selected versions</span>'}</div></section>`;
  }
  const hiddenN = versions.filter((v) => state.hidden.has(`${key}::${v.version}`)).length;
  const cols = versions.map((v) => (state.hidden.has(`${key}::${v.version}`) ? hmark(key, v.version) : col(v))).join('');
  const reset = hiddenN ? `<button class="reset" data-key="${esc(key)}">show ${hiddenN} hidden</button>` : '';
  return `<section class="row"><div class="rowhead"><h2>${esc(title)}</h2>${reset}</div><div class="tags">${tags}</div>`
    + `<div class="cols" data-row="${esc(key)}">${cols || '<span class="m">no versions</span>'}</div></section>`;
}

export function shotKey(s) { return s.episode ? `${s.episode}/${s.shotId}` : s.shotId; }
export function sheetKey(type, name, sh) { return `${type}/${name}/${sh.sheetType}/${sh.slug}`; }

export function shotRowItems(shots) {
  return shots.map((s) => {
    const key = shotKey(s);
    const tags = [s.episode && `ep ${esc(s.episode)}`, s.promotedVersion && `final: ${esc(s.promotedVersion)}`,
      esc(s.characters.join(', ')), esc(s.description)].filter(Boolean).join(' — ');
    return { key, title: s.shotId, tags, versions: s.versions, kind: 'shot' };
  });
}

export function sheetRowItems(el) {
  return el.sheets.map((sh) => ({
    key: sheetKey(el.type, el.name, sh), title: [sh.sheetType, sh.slug].filter(Boolean).join(' / '),
    tags: '', versions: sh.versions, kind: 'sheet',
  }));
}

export function itemRowHTML(item, state) {
  const col = item.kind === 'shot' ? (v) => shotCol(v, item.key, state) : (v) => sheetCol(v, item.key, state);
  return rowHTML({ ...item, col }, state);
}

export function shotRowsHTML(shots, state) {
  return shotRowItems(shots).map((it) => itemRowHTML(it, state)).join('') || '<p class="missing">No shots here yet.</p>';
}

export function sheetRowsHTML(el, state) {
  return sheetRowItems(el).map((it) => itemRowHTML(it, state)).join('') || '<p class="missing">No sheets yet.</p>';
}
```

`shotKey`/`sheetKey` intentionally duplicate `src/studio/tree.js`. The browser can't import from `src/` outside `web/`, and the server never needs the client copy. The Task 2 and Task 9 tests both pin the format, so the two copies can't drift silently.

- [ ] **Step 4: Run, expect PASS.** `node --test test/studio-views.test.js`
- [ ] **Step 5: Commit** `git add src/studio/web/views.js test/studio-views.test.js && git commit -m "feat(studio): pure review view builders"`

### Task 10: App wiring

**Files:**
- Create: `src/studio/web/app.js`

- [ ] **Step 1: Implement**

```js
// src/studio/web/app.js
import {
  esc, parseRoute, treeHTML, homeHTML, shotRowItems, sheetRowItems, itemRowHTML, MATTE_BGS,
} from './views.js';

const rail = document.getElementById('rail');
const grid = document.getElementById('grid');
const toolbar = document.getElementById('toolbar');
const titleEl = document.getElementById('title');
const subEl = document.getElementById('subtitle');

const state = {
  tree: null, route: { view: 'home' }, items: [], byKey: {},
  selected: new Set(), hidden: new Set(), mode: 'clips', bg: loadBg(), onlySelected: false,
};

// Matte background is a per-viewer convenience, so localStorage is enough.
function loadBg() {
  try { const b = localStorage.getItem('studio:bg'); return MATTE_BGS.includes(b) ? b : 'checker'; } catch { return 'checker'; }
}
function saveBg() { try { localStorage.setItem('studio:bg', state.bg); } catch {} }

// Swap each .mpv placeholder for its composite <video>. The server renders on
// demand (max 2 at once), so poll pending ones; a placeholder that leaves the
// DOM (re-render, navigation, bg change) just stops polling.
function hydratePreviews(scope = grid) {
  for (const el of scope.querySelectorAll('.mpv:not([data-polling])')) {
    el.dataset.polling = '1';
    const q = `/api/matte-preview?src=${encodeURIComponent(el.dataset.src)}&bg=${encodeURIComponent(el.dataset.bg)}`;
    const tick = async () => {
      if (!el.isConnected) return;
      let r;
      try { r = await getJson(q); } catch (err) { r = { state: 'error', error: err.message }; }
      if (!el.isConnected) return;
      if (r.state === 'ready') {
        const v = document.createElement('video');
        Object.assign(v, { src: r.url, controls: true, loop: true, preload: 'metadata' });
        el.replaceWith(v);
      } else if (r.state === 'error') {
        el.classList.add('err');
        el.textContent = `preview failed: ${r.error}`;
      } else {
        setTimeout(tick, 1500);
      }
    };
    tick();
  }
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function loadSelections() {
  const doc = await getJson('/api/selections');
  state.selected = new Set(Object.entries(doc.selected).flatMap(([k, vs]) => vs.map((v) => `${k}::${v}`)));
}

function versionsFor(key) {
  const p = `${key}::`;
  return [...state.selected].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length));
}

async function saveKey(key) {
  const r = await fetch('/api/selections', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, versions: versionsFor(key) }) });
  if (!r.ok) throw new Error((await r.json()).error || r.status);
}

function flash(msg) { const e = document.getElementById('err'); if (e) e.textContent = msg; }

function renderToolbar() {
  const isShots = state.route.view === 'episode' || state.route.view === 'shot';
  const seg = isShots
    ? `<span class="seg"><button data-mode="clips" class="${state.mode === 'clips' ? 'on' : ''}">Clips</button>`
      + `<button data-mode="mattes" class="${state.mode === 'mattes' ? 'on' : ''}">Mattes</button></span>`
      + (state.mode === 'mattes'
        ? '<span class="bgs">bg ' + MATTE_BGS.map((b) =>
          `<button data-bg="${b}" title="${b}" class="${state.bg === b ? 'on' : ''}"></button>`).join('') + '</span>'
        : '')
    : '';
  const reviewing = state.route.view !== 'home';
  toolbar.innerHTML = seg
    + (reviewing ? `<button id="onlySelected" class="${state.onlySelected ? 'on' : ''}">Show only selected</button>` : '')
    + `<span class="count">${state.selected.size} selected (project)</span>`
    + '<button id="refresh">Rescan</button><button id="export">Export selection</button>'
    + '<span class="err" id="err"></span>';
}

function renderGrid() {
  if (state.route.view === 'home') { grid.innerHTML = homeHTML(state.tree); return; }
  const y = window.scrollY;
  grid.innerHTML = state.items.map((it) => itemRowHTML(it, state)).join('')
    || `<p class="missing">${state.route.view === 'element' ? 'No sheets yet.' : 'No shots here yet.'}</p>`;
  window.scrollTo(0, y);
  hydratePreviews();
}

// Re-render one row only, so other rows' loaded <video>s keep their state.
function rerenderRow(key) {
  const item = state.byKey[key];
  const cols = [...grid.querySelectorAll('.cols[data-row]')].find((c) => c.dataset.row === key);
  if (!item || !cols) return;
  const sx = cols.scrollLeft;
  const sec = cols.closest('section');
  sec.outerHTML = itemRowHTML(item, state);
  const fresh = [...grid.querySelectorAll('.cols[data-row]')].find((c) => c.dataset.row === key);
  if (fresh) { fresh.scrollLeft = sx; hydratePreviews(fresh); }
}

async function route() {
  state.route = parseRoute(location.hash);
  state.hidden.clear();
  rail.innerHTML = treeHTML(state.tree, location.hash || '#/');
  const r = state.route;
  try {
    if (r.view === 'element') {
      const el = await getJson(`/api/element?type=${encodeURIComponent(r.type)}&name=${encodeURIComponent(r.name)}`);
      state.items = sheetRowItems(el);
      titleEl.textContent = `${r.name}`;
      subEl.textContent = `${r.type} · ${state.items.length} sheet(s)`;
    } else if (r.view === 'episode' || r.view === 'shot') {
      const q = `episode=${encodeURIComponent(r.episode)}` + (r.view === 'shot' ? `&id=${encodeURIComponent(r.shotId)}` : '');
      const { shots } = await getJson(`/api/shots?${q}`);
      state.items = shotRowItems(shots);
      titleEl.textContent = r.view === 'shot' ? r.shotId : (r.episode === '_' ? 'All shots' : `Episode ${r.episode}`);
      subEl.textContent = `${shots.length} shot(s)`;
    } else {
      state.items = [];
      titleEl.textContent = state.tree.project;
      subEl.textContent = 'Project overview';
    }
  } catch (err) {
    state.items = [];
    subEl.textContent = `error: ${err.message}`;
  }
  state.byKey = Object.fromEntries(state.items.map((it) => [it.key, it]));
  document.title = `${titleEl.textContent} · Studio`;
  renderToolbar();
  renderGrid();
}

async function boot() {
  [state.tree] = await Promise.all([getJson('/api/tree'), loadSelections()]);
  await route();
}

function exportSelection() {
  const doc = { project: state.tree.project, exportedAt: new Date().toISOString(),
    selected: Object.fromEntries([...new Set([...state.selected].map((k) => k.slice(0, k.lastIndexOf('::'))))]
      .sort().map((key) => [key, versionsFor(key)])) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${state.tree.project}-selection.json` });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

toolbar.addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.mode) { state.mode = t.dataset.mode; renderToolbar(); renderGrid(); }
  else if (t.dataset.bg) { state.bg = t.dataset.bg; saveBg(); renderToolbar(); renderGrid(); }
  else if (t.id === 'onlySelected') { state.onlySelected = !state.onlySelected; renderToolbar(); renderGrid(); }
  else if (t.id === 'refresh') { await boot(); }
  else if (t.id === 'export') exportSelection();
});

grid.addEventListener('click', (e) => {
  const t = e.target;
  const mk = t.closest('.hmark');
  if (t.classList.contains('hide')) { state.hidden.add(`${t.dataset.key}::${t.dataset.v}`); rerenderRow(t.dataset.key); }
  else if (mk) { state.hidden.delete(`${mk.dataset.key}::${mk.dataset.v}`); rerenderRow(mk.dataset.key); }
  else if (t.classList.contains('reset')) {
    const p = `${t.dataset.key}::`;
    for (const k of [...state.hidden]) if (k.startsWith(p)) state.hidden.delete(k);
    rerenderRow(t.dataset.key);
  }
});

grid.addEventListener('change', async (e) => {
  const t = e.target; if (!t.classList.contains('selectbox')) return;
  const key = t.dataset.key, k = `${key}::${t.dataset.v}`;
  if (t.checked) state.selected.add(k); else state.selected.delete(k);
  if (state.onlySelected) rerenderRow(key); else t.closest('.col')?.classList.toggle('selected', t.checked);
  renderToolbar();
  try { await saveKey(key); flash(''); }
  catch (err) {
    if (t.checked) state.selected.delete(k); else state.selected.add(k);   // revert
    t.checked = !t.checked; t.closest('.col')?.classList.toggle('selected', t.checked);
    renderToolbar(); flash(`save failed: ${err.message}`);
  }
});

// Media errors don't bubble; capture them so a broken clip shows a message
// rather than a black box. (Mattes never reach here raw; they are composites.)
grid.addEventListener('error', (e) => {
  const v = e.target;
  if (v.tagName !== 'VIDEO') return;
  const div = document.createElement('div');
  div.className = 'missing';
  div.innerHTML = `can’t play this file · <a href="${esc(v.getAttribute('src'))}" download>download</a>`;
  v.replaceWith(div);
}, true);

window.addEventListener('hashchange', route);
boot().catch((err) => { grid.innerHTML = `<p class="missing">${esc(err.message)}</p>`; });
```

- [ ] **Step 2: Commit** `git add src/studio/web/app.js && git commit -m "feat(studio): app wiring — routing, selection, mattes mode"`

### Task 11: Browser verification + docs

- [ ] **Step 1: Run against a real project.** Use one with an episodic layout, elements with sheets, and at least one matte, e.g. the project from the `blue-matte-final` baseline:

```bash
node bin/pipeline.js studio --root /path/to/project
```

Open the printed URL in the built-in browser pane (`preview_start` with `url`). Verify each point, taking screenshots for the PR:

1. The tree shows every element type/name, including elements with no sheets. Episodes appear with nested shots, and flat shots appear under "Shots" if any exist.
2. Clicking an element shows one row per sheet, with versions side by side.
3. Clicking an episode shows all its shots. Clicking a shot shows only that shot. The promoted draft shows the `final` badge.
4. Video seeking works (Range).
5. Mattes mode, with a real ProRes 4444 `alpha.mov`, in **Chrome**:
   - Placeholders show "rendering…" and then turn into playable composites over the checkerboard.
   - Switching the bg swatch (white/black/gray/green) renders and swaps the new variants. Switching back to checker is instant because it's cached.
   - The chosen bg survives a reload.
   - Re-running `pipeline shot matte` on a version makes its next view re-render.
   - QC thumbnails appear.
   - The "alpha" link downloads the raw file rather than playing it.
   - `.pipeline/studio/previews/` mirrors the shot paths.
6. Selecting a version, reloading the page, and returning keeps the selection. `<root>/.pipeline/studio/selections.json` contains it.
7. Hide / show-hidden / "Show only selected" behave like the static review page.
8. Rescan picks up a new draft created from the CLI (`pipeline shot draft` + drop an `output.mp4`) without restarting the server.
9. At phone width (`resize_window` preset mobile), the rail stacks above the grid and nothing scrolls horizontally except the version rows.

- [ ] **Step 2: README.** Add a short "Studio" subsection next to "Review pages":

```md
### Studio (local review UI)

`pipeline studio [--root <project>] [--port 4870]` starts a local web UI (127.0.0.1 only)
that shows the project's elements, episodes and shots as a tree. Each node opens a side-by-side
version review. Shots can be viewed as clips or as mattes; mattes are composited (ffmpeg) over a
checkerboard or a solid white/black/gray/green background and cached in `.pipeline/studio/previews/`.
Selections are saved to `.pipeline/studio/selections.json`. Nothing outside `.pipeline/studio/` is written. Static, shareable
pages are still produced by `pipeline review`.
```

- [ ] **Step 3: Commit, open PR B** (`gh pr create`, screenshots in the body). **Ask the user before merging.**

---

## Phase 2 roadmap (separate plan, after design iteration)

Not implemented here. These notes record the hook points so Phase 1 choices stay compatible.

| UI action | Existing entry point | Notes |
|---|---|---|
| New element | `createElement(root, {type, name})` (`src/element.js`) | Instant. Tree refreshes. |
| New shot / new draft | `createShot`, `newDraft` (`src/shot.js`) | Instant. |
| Generate sheet | `generateElementSheet` / `prepareElementSheet` (`src/generate.js`), `validateElementSheet` | Spends credits. Show `createRunner().estimateCost()` and require confirm. `topaz_image` has no cost-estimate API, so show "~2 credits/panel" instead. |
| Generate shot draft | `generateShotDraft` / `validateShotGenerate` | Same cost gate. Long-running. |
| Pull matte | `matteShot(root, spec, { engine })` (`src/matte.js`) | Local python sidecar, minutes. Any `--format` works: the result is viewed through the Phase 1 preview composites. Optionally pre-warm the checker preview when the job finishes. |
| Upscale shot / sheet | `upscaleShot`, element upscale | Credits + long-running. |
| Promote selection → final | `promoteDraft(root, shotId, version, outputFile)` | Turns a Phase 1 *selection* into the pipeline's *promotion*. |

Phase 2 design points: an in-process job queue in the server (`POST /api/jobs`, `GET /api/jobs/stream` over SSE for progress/log lines). A job reuses the CLI functions directly rather than shelling out, except where the code already needs stderr inheritance (`inheritStderrExec`, matte sidecar). Jobs carry the credit `task` label (`readTaskState`). Mutating endpoints keep the Phase 1 protections (Host check, JSON-only bodies, `assertSegment` on names/ids). Forms live in `views.js`-style pure builders so they stay testable.
