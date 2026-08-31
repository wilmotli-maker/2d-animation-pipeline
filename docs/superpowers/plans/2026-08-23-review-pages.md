# Review Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `pipeline review shots|images` command that generates and incrementally updates self-contained static review webpages under `web/<slug>/`, with combinable CLI filters and client-side side-by-side version comparison.

**Architecture:** Four pure modules plus thin CLI glue. `review-scan.js` turns the filesystem into normalized shot/image models; `review-filter.js` narrows a model by combinable filters; `review-render.js` renders a model+selection to a self-contained HTML string; `review-page.js` orchestrates scan→filter→select→vendor assets→write bundle→refresh the web index. `bin/pipeline.js` wires the `review` subcommand. Scanning is structure-agnostic (flat `shots/` and episodic `episodes/<N>/shots/`; image scanning is driven by each element's `generations.jsonl` with a filesystem fallback).

**Tech Stack:** Node ESM, `node:test`, `node:fs/promises`, `yaml`, `sharp` (already deps). No new dependencies. Vanilla JS in the generated page.

**Spec:** `docs/superpowers/specs/2026-08-23-shot-review-pages-design.md`

---

## File structure

- Create `src/review-scan.js` — `scanShots(root, {episodes})`, `scanImages(root)`, plus internal discovery helpers. No HTML.
- Create `src/review-filter.js` — `applyShotFilters(model, filters)`, `applyImageFilters(model, filters)`. Pure.
- Create `src/review-render.js` — `renderShotPage({model, selection, title})`, `renderImagePage({model, selection, title})` → HTML string. Pure.
- Create `src/review-page.js` — `buildReviewPage(root, opts)` orchestrator (scan, filter, select, vendor, write, refresh index).
- Modify `bin/pipeline.js` — add the `review` subcommand branch + usage text.
- Modify `.gitignore` — ignore `web/*/assets/`.
- Create tests: `test/review-scan.test.js`, `test/review-filter.test.js`, `test/review-render.test.js`, `test/review-page.test.js`.

**Key shapes (locked — reuse verbatim across tasks):**

Shot model:
```js
// { generatedAt, type: 'shots', shots: [ ShotEntry ] }
// ShotEntry = {
//   shotId, episode,                 // episode: string|null
//   description, mode, duration,
//   characters: [string],            // element names from shot.yaml elements[].name
//   versions: [ ShotVersion ]        // newest last; 'final' sorts newest
// }
// ShotVersion = {
//   version,                         // 'v001' | 'final'
//   kind,                            // 'draft' | 'final'
//   video,                           // repo-relative path, or null if absent
//   variants: { alpha, upscaled: [string], qc: [string] },
//   meta: { model, prompt, resolution, aspectRatio, mode, ts } // {} when unknown
// }
```

Image model:
```js
// { generatedAt, type: 'images', characters: [ CharacterEntry ] }
// CharacterEntry = { type, name, sheets: [ SheetEntry ] }
// SheetEntry = {
//   sheetType,                       // 'turnaround' | 'pose' | 'cycles' | other
//   slug,                            // sheetId, or '' when the layout has no slug level
//   versions: [ SheetVersion ]       // newest last
// }
// SheetVersion = {
//   version,                         // 'v001'
//   images: [string],                // repo-relative image paths (panels or the sheet)
//   upscaled: [string],
//   meta: { model, prompt, ts }      // {} when unknown
// }
```

Filters:
```js
// shot filters:  { match?: string(regex), characters?: [string], episodes?: [string] }
// image filters: { match?: string(regex), characters?: [string], sheets?: [string] }
```

Selection (what versions to show per item, plus layout):
```js
// { layout: 'side-by-side'|'stacked', versions: { [key]: [versionId] } }
//   shot key = shotId ; image key = `${name}/${sheetType}/${slug}`
//   default per item = the up-to-2 most recent versions ('final' is newest)
```

---

## Task 1: Repo-relative helper + episode discovery

**Files:**
- Create: `src/review-scan.js`
- Test: `test/review-scan.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/review-scan.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverShotRoots } from '../src/review-scan.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('discoverShotRoots: flat layout yields one root with episode null', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'shots', 's1'), { recursive: true });
    const roots = await discoverShotRoots(root);
    assert.deepEqual(roots, [{ root, episode: null }]);
  });
});

test('discoverShotRoots: episodic layout yields one root per episode', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'episodes', '1', 'shots', 'a'), { recursive: true });
    await mkdir(path.join(root, 'episodes', '2', 'shots', 'b'), { recursive: true });
    const roots = await discoverShotRoots(root);
    assert.deepEqual(roots.map((r) => r.episode).sort(), ['1', '2']);
    assert.equal(roots.find((r) => r.episode === '1').root, path.join(root, 'episodes', '1'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review-scan.test.js`
Expected: FAIL — `discoverShotRoots` is not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/review-scan.js
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {
  shotDir, shotDraftsDir, shotFinalDir, shotVersionDir, formatVersion,
  generationsLogPath,
} from './paths.js';

async function isDir(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

async function listDirs(p) {
  try {
    return (await readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// A "shot root" is a directory containing a shots/ folder. Episodic projects have
// one per episodes/<N>; flat projects have the top-level project dir itself. Both
// may coexist during a migration — union them.
export async function discoverShotRoots(root) {
  const out = [];
  if (await isDir(path.join(root, 'shots'))) out.push({ root, episode: null });
  const episodesDir = path.join(root, 'episodes');
  for (const n of (await listDirs(episodesDir)).sort()) {
    const epRoot = path.join(episodesDir, n);
    if (await isDir(path.join(epRoot, 'shots'))) out.push({ root: epRoot, episode: n });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/review-scan.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review-scan.js test/review-scan.test.js
git commit -m "feat(review): discover flat and episodic shot roots"
```

---

## Task 2: `scanShots` — filesystem to shot model

**Files:**
- Modify: `src/review-scan.js`
- Test: `test/review-scan.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to test/review-scan.test.js
import { scanShots } from '../src/review-scan.js';

async function seedShot(root, id, { drafts = [], final = null, elements = [] } = {}) {
  await mkdir(path.join(root, 'shots', id, 'drafts'), { recursive: true });
  await mkdir(path.join(root, 'shots', id, 'final'), { recursive: true });
  await writeFile(path.join(root, 'shots', id, 'shot.yaml'),
    YAMLstringify({ shotId: id, elements, duration: 6, mode: 'narrative', description: 'd' }));
  for (const d of drafts) {
    const dir = path.join(root, 'shots', id, 'drafts', d.version);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'output.mp4'), 'x');
    if (d.output) await writeFile(path.join(dir, 'output.json'), JSON.stringify(d.output));
  }
  if (final) await writeFile(path.join(root, 'shots', id, 'final', final), 'x');
}
// tiny inline YAML.stringify to avoid another import in the helper
import YAML2 from 'yaml';
function YAMLstringify(o) { return YAML2.stringify(o); }

test('scanShots: builds versions, characters, and graceful meta', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'art-talk-01', {
      elements: [{ type: 'characters', name: 'mira' }, { type: 'characters', name: 'joh' }],
      drafts: [
        { version: 'v001' },                                   // no output.json -> meta {}
        { version: 'v002', output: { model: 'seedance_2_5', resolution: '480p', ts: 'T' } },
      ],
      final: 'art-talk-01-v002.mp4',
    });
    const model = await scanShots(root, {});
    assert.equal(model.type, 'shots');
    const s = model.shots.find((x) => x.shotId === 'art-talk-01');
    assert.deepEqual(s.characters, ['mira', 'joh']);
    assert.equal(s.episode, null);
    assert.deepEqual(s.versions.map((v) => v.version), ['v001', 'v002', 'final']);
    assert.equal(s.versions[0].meta.model, undefined); // graceful: {}
    assert.equal(s.versions[1].meta.model, 'seedance_2_5');
    assert.equal(s.versions[2].kind, 'final');
    assert.ok(s.versions[2].video.endsWith('art-talk-01-v002.mp4'));
  });
});

test('scanShots: episodic tags episode and filters by --episode later', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'episodes', '1'), { recursive: true });
    await seedShot(path.join(root, 'episodes', '1'), 'a', { drafts: [{ version: 'v001' }] });
    const model = await scanShots(root, {});
    assert.equal(model.shots[0].episode, '1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review-scan.test.js`
Expected: FAIL — `scanShots` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review-scan.js`:

```js
function relTo(root, p) { return p == null ? null : path.relative(root, p); }

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// Collect alpha.*, upscaled-*.mp4, and a qc/ listing from a version's dir.
async function readVariants(versionDir) {
  const out = { alpha: null, upscaled: [], qc: [] };
  for (const name of await listFiles(versionDir)) {
    if (name === 'alpha.mov' || name === 'alpha.mp4') out.alpha = path.join(versionDir, name);
    else if (/^upscaled-.*\.mp4$/.test(name)) out.upscaled.push(path.join(versionDir, name));
  }
  const qcDir = path.join(versionDir, 'qc');
  if (await isDir(qcDir)) out.qc = (await listFiles(qcDir)).map((n) => path.join(qcDir, n));
  return out;
}

async function listFiles(p) {
  try {
    return (await readdir(p, { withFileTypes: true }))
      .filter((e) => e.isFile()).map((e) => e.name);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function readShotYaml(shotRoot, id) {
  try {
    const y = YAML.parse(await readFile(path.join(shotRoot, 'shots', id, 'shot.yaml'), 'utf8'));
    return y || {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function readMeta(dir) {
  try {
    const j = JSON.parse(await readFile(path.join(dir, 'output.json'), 'utf8'));
    const { model, prompt, resolution, aspectRatio, mode, ts } = j;
    return { model, prompt, resolution, aspectRatio, mode, ts };
  } catch { return {}; }
}

async function scanOneShot(projectRoot, shotRoot, episode, id) {
  const y = await readShotYaml(shotRoot, id);
  const characters = Array.isArray(y.elements)
    ? y.elements.map((e) => (typeof e === 'string' ? e : e && e.name)).filter(Boolean) : [];
  const versions = [];

  const draftsDir = shotDraftsDir(shotRoot, id);
  const draftNames = (await listDirs(draftsDir)).filter((n) => /^v\d+$/.test(n))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const v of draftNames) {
    const dir = shotVersionDir(shotRoot, id, Number(v.slice(1)));
    const video = path.join(dir, 'output.mp4');
    versions.push({
      version: v, kind: 'draft',
      video: (await fileExists(video)) ? relTo(projectRoot, video) : null,
      variants: mapVariants(projectRoot, await readVariants(dir)),
      meta: await readMeta(dir),
    });
  }

  const finalDir = shotFinalDir(shotRoot, id);
  const finalMp4 = (await listFiles(finalDir)).find((n) => n.endsWith('.mp4'));
  if (finalMp4) {
    versions.push({
      version: 'final', kind: 'final',
      video: relTo(projectRoot, path.join(finalDir, finalMp4)),
      variants: mapVariants(projectRoot, await readVariants(finalDir)),
      meta: await readMeta(finalDir),
    });
  }

  return {
    shotId: id, episode,
    description: y.description ?? '', mode: y.mode ?? null, duration: y.duration ?? null,
    characters, versions,
  };
}

function mapVariants(projectRoot, v) {
  return {
    alpha: relTo(projectRoot, v.alpha),
    upscaled: v.upscaled.map((p) => relTo(projectRoot, p)),
    qc: v.qc.map((p) => relTo(projectRoot, p)),
  };
}

export async function scanShots(projectRoot, { episodes } = {}) {
  const roots = await discoverShotRoots(projectRoot);
  const shots = [];
  for (const { root: shotRoot, episode } of roots) {
    if (episodes && episodes.length && (episode == null || !episodes.includes(episode))) continue;
    for (const id of (await listDirs(path.join(shotRoot, 'shots'))).sort()) {
      shots.push(await scanOneShot(projectRoot, shotRoot, episode, id));
    }
  }
  return { generatedAt: new Date().toISOString(), type: 'shots', shots };
}
```

Note: `shotDir` / `generationsLogPath` imports stay for Task 3; unused-in-this-task imports are fine.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/review-scan.test.js`
Expected: PASS (all scan tests).

- [ ] **Step 5: Commit**

```bash
git add src/review-scan.js test/review-scan.test.js
git commit -m "feat(review): scanShots builds normalized shot model"
```

---

## Task 3: `scanImages` — log-driven image model

**Files:**
- Modify: `src/review-scan.js`
- Test: `test/review-scan.test.js`

Reads each `elements/<type>/<name>/generations.jsonl` (authoritative: `sheetType`, `sheetId`, `version`, `output`, `panels`, `model`, `prompt`, `ts`). Groups by `(sheetType, sheetId)`; each log line is a version. Falls back to a filesystem walk of `sheets/<sheetType>/**` for elements with no log (handles the slug-less `sheets/turnaround/v001.png` layout).

- [ ] **Step 1: Write the failing test**

```js
// append to test/review-scan.test.js
import { scanImages } from '../src/review-scan.js';

test('scanImages: log-driven versions and panels', async () => {
  await withTempRoot(async (root) => {
    const el = path.join(root, 'elements', 'characters', 'mira');
    await mkdir(path.join(el, 'sheets', 'turnaround', 'main'), { recursive: true });
    const out = path.join(el, 'sheets', 'turnaround', 'main', 'v001.png');
    await writeFile(out, 'x');
    await writeFile(path.join(el, 'generations.jsonl'),
      JSON.stringify({ sheetType: 'turnaround', sheetId: 'main', version: 'v001',
        model: 'nano_banana_pro', prompt: 'p', output: out, panels: [], ts: 'T' }) + '\n');
    const model = await scanImages(root);
    assert.equal(model.type, 'images');
    const c = model.characters.find((x) => x.name === 'mira');
    assert.equal(c.type, 'characters');
    const sheet = c.sheets.find((s) => s.sheetType === 'turnaround' && s.slug === 'main');
    assert.equal(sheet.versions[0].version, 'v001');
    assert.equal(sheet.versions[0].meta.model, 'nano_banana_pro');
    assert.ok(sheet.versions[0].images[0].endsWith('v001.png'));
  });
});

test('scanImages: filesystem fallback for slug-less layout, no log', async () => {
  await withTempRoot(async (root) => {
    const el = path.join(root, 'elements', 'characters', 'joh');
    await mkdir(path.join(el, 'sheets', 'pose'), { recursive: true });
    await writeFile(path.join(el, 'sheets', 'pose', 'v001.png'), 'x');
    const model = await scanImages(root);
    const c = model.characters.find((x) => x.name === 'joh');
    const sheet = c.sheets.find((s) => s.sheetType === 'pose');
    assert.equal(sheet.slug, '');
    assert.equal(sheet.versions[0].version, 'v001');
    assert.ok(sheet.versions[0].images[0].endsWith('v001.png'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review-scan.test.js`
Expected: FAIL — `scanImages` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review-scan.js`:

```js
function pushVersion(map, key, entry) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(entry);
}

async function readGenerationsLog(elDir) {
  try {
    const text = await readFile(path.join(elDir, 'generations.jsonl'), 'utf8');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Walk sheets/<sheetType>/(<slug>/)?vNNN.<img> for elements without a usable log.
async function walkSheets(projectRoot, elDir) {
  const sheetsDir = path.join(elDir, 'sheets');
  const found = new Map(); // `${sheetType} ${slug}` -> [{version, images}]
  for (const sheetType of await listDirs(sheetsDir)) {
    const typeDir = path.join(sheetsDir, sheetType);
    const direct = (await listFiles(typeDir)).filter((n) => /^v\d+\.(png|jpe?g|webp)$/i.test(n));
    for (const f of direct) {
      pushVersion(found, `${sheetType} `, {
        version: f.replace(/\.[^.]+$/, ''),
        images: [relTo(projectRoot, path.join(typeDir, f))], upscaled: [], meta: {},
      });
    }
    for (const slug of await listDirs(typeDir)) {
      const slugDir = path.join(typeDir, slug);
      const imgs = (await listFiles(slugDir)).filter((n) => /\.(png|jpe?g|webp)$/i.test(n));
      const byV = new Map();
      for (const f of imgs) {
        const m = /^(v\d+)/.exec(f);
        const v = m ? m[1] : 'v001';
        if (!byV.has(v)) byV.set(v, []);
        byV.get(v).push(relTo(projectRoot, path.join(slugDir, f)));
      }
      for (const [v, images] of byV) {
        pushVersion(found, `${sheetType} ${slug}`, { version: v, images, upscaled: [], meta: {} });
      }
    }
  }
  return found;
}

function sheetEntriesFromMap(map) {
  const sheets = [];
  for (const [key, versions] of map) {
    const [sheetType, slug] = key.split(' ');
    versions.sort((a, b) => Number(a.version.slice(1)) - Number(b.version.slice(1)));
    sheets.push({ sheetType, slug, versions });
  }
  return sheets.sort((a, b) => (a.sheetType + a.slug).localeCompare(b.sheetType + b.slug));
}

async function scanOneElement(projectRoot, type, name, elDir) {
  const log = await readGenerationsLog(elDir);
  const map = new Map();
  if (log && log.some((e) => e.sheetType)) {
    for (const e of log) {
      if (!e.sheetType) continue;
      const slug = e.sheetId ?? '';
      const images = e.panels && e.panels.length
        ? e.panels.map((p) => relTo(projectRoot, path.isAbsolute(p) ? p : path.join(projectRoot, p)))
        : (e.output ? [relTo(projectRoot, path.isAbsolute(e.output) ? e.output : path.join(projectRoot, e.output))] : []);
      pushVersion(map, `${e.sheetType} ${slug}`, {
        version: e.version ?? 'v001', images, upscaled: [],
        meta: { model: e.model, prompt: e.prompt, ts: e.ts },
      });
    }
  } else {
    for (const [k, v] of await walkSheets(projectRoot, elDir)) map.set(k, v);
  }
  return { type, name, sheets: sheetEntriesFromMap(map) };
}

export async function scanImages(projectRoot) {
  const elementsDir = path.join(projectRoot, 'elements');
  const characters = [];
  for (const type of await listDirs(elementsDir)) {
    for (const name of await listDirs(path.join(elementsDir, type))) {
      const elDir = path.join(elementsDir, type, name);
      const entry = await scanOneElement(projectRoot, type, name, elDir);
      if (entry.sheets.length) characters.push(entry);
    }
  }
  return { generatedAt: new Date().toISOString(), type: 'images', characters };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/review-scan.test.js`
Expected: PASS (all scan tests).

- [ ] **Step 5: Commit**

```bash
git add src/review-scan.js test/review-scan.test.js
git commit -m "feat(review): scanImages log-driven with filesystem fallback"
```

---

## Task 4: Filters

**Files:**
- Create: `src/review-filter.js`
- Test: `test/review-filter.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/review-filter.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyShotFilters, applyImageFilters } from '../src/review-filter.js';

const shotModel = {
  type: 'shots', shots: [
    { shotId: 'art-talk-01', episode: '1', characters: ['mira'], versions: [] },
    { shotId: 'art-walk-02', episode: '1', characters: ['joh'], versions: [] },
    { shotId: 'bg-plate-01', episode: '2', characters: [], versions: [] },
  ],
};

test('applyShotFilters: regex, characters, episode intersect', () => {
  assert.deepEqual(
    applyShotFilters(shotModel, { match: '^art-' }).shots.map((s) => s.shotId),
    ['art-talk-01', 'art-walk-02']);
  assert.deepEqual(
    applyShotFilters(shotModel, { characters: ['mira'] }).shots.map((s) => s.shotId),
    ['art-talk-01']);
  assert.deepEqual(
    applyShotFilters(shotModel, { match: '^art-', episodes: ['1'], characters: ['joh'] })
      .shots.map((s) => s.shotId),
    ['art-walk-02']);
  assert.equal(applyShotFilters(shotModel, {}).shots.length, 3);
});

const imageModel = {
  type: 'images', characters: [
    { type: 'characters', name: 'mira', sheets: [
      { sheetType: 'turnaround', slug: 'a', versions: [] },
      { sheetType: 'pose', slug: 'b', versions: [] }] },
    { type: 'characters', name: 'joh', sheets: [
      { sheetType: 'pose', slug: 'c', versions: [] }] },
  ],
};

test('applyImageFilters: characters + sheets intersect, prune empties', () => {
  const r = applyImageFilters(imageModel, { characters: ['mira'], sheets: ['pose'] });
  assert.equal(r.characters.length, 1);
  assert.equal(r.characters[0].name, 'mira');
  assert.deepEqual(r.characters[0].sheets.map((s) => s.sheetType), ['pose']);
  assert.equal(applyImageFilters(imageModel, { sheets: ['pose'] }).characters.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review-filter.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/review-filter.js
function reOrNull(s) { return s ? new RegExp(s) : null; }
function anyOf(list, set) { return !set || !set.length || list.some((x) => set.includes(x)); }

export function applyShotFilters(model, { match, characters, episodes } = {}) {
  const re = reOrNull(match);
  const shots = model.shots.filter((s) =>
    (!re || re.test(s.shotId)) &&
    (!characters || !characters.length || anyOf(s.characters, characters)) &&
    (!episodes || !episodes.length || (s.episode != null && episodes.includes(s.episode))));
  return { ...model, shots };
}

export function applyImageFilters(model, { match, characters, sheets } = {}) {
  const re = reOrNull(match);
  const nameSet = characters && characters.length ? characters : null;
  const out = [];
  for (const c of model.characters) {
    if (nameSet && !nameSet.includes(c.name)) continue;
    const keptSheets = c.sheets.filter((s) =>
      (!sheets || !sheets.length || sheets.includes(s.sheetType)) &&
      (!re || re.test(s.slug)));
    if (keptSheets.length) out.push({ ...c, sheets: keptSheets });
  }
  return { ...model, characters: out };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/review-filter.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review-filter.js test/review-filter.test.js
git commit -m "feat(review): combinable shot and image filters"
```

---

## Task 5: Default selection

**Files:**
- Modify: `src/review-filter.js` (co-locates selection logic with model narrowing)
- Test: `test/review-filter.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to test/review-filter.test.js
import { defaultShotSelection, defaultImageSelection } from '../src/review-filter.js';

test('defaultShotSelection: up to 2 most recent, final newest', () => {
  const m = { type: 'shots', shots: [
    { shotId: 's', versions: [
      { version: 'v001' }, { version: 'v002' }, { version: 'final' }] }] };
  const sel = defaultShotSelection(m);
  assert.deepEqual(sel.versions.s, ['v002', 'final']);
  assert.equal(sel.layout, 'side-by-side');
});

test('defaultImageSelection: up to 2 most recent per sheet', () => {
  const m = { type: 'images', characters: [
    { name: 'mira', sheets: [
      { sheetType: 'pose', slug: 'a', versions: [
        { version: 'v001' }, { version: 'v002' }, { version: 'v003' }] }] }] };
  const sel = defaultImageSelection(m);
  assert.deepEqual(sel.versions['mira/pose/a'], ['v002', 'v003']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review-filter.test.js`
Expected: FAIL — selection helpers not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to src/review-filter.js
function lastN(arr, n) { return arr.slice(Math.max(0, arr.length - n)); }

export function defaultShotSelection(model, layout = 'side-by-side') {
  const versions = {};
  for (const s of model.shots) versions[s.shotId] = lastN(s.versions.map((v) => v.version), 2);
  return { layout, versions };
}

export function defaultImageSelection(model, layout = 'side-by-side') {
  const versions = {};
  for (const c of model.characters) {
    for (const sh of c.sheets) {
      versions[`${c.name}/${sh.sheetType}/${sh.slug}`] = lastN(sh.versions.map((v) => v.version), 2);
    }
  }
  return { layout, versions };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/review-filter.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review-filter.js test/review-filter.test.js
git commit -m "feat(review): default 2-most-recent version selection"
```

---

## Task 6: HTML renderer

**Files:**
- Create: `src/review-render.js`
- Test: `test/review-render.test.js`

The renderer is pure: it takes a model whose asset paths have **already been rewritten to page-relative `assets/...` paths** (Task 7 does the rewrite before calling render) and a selection, and returns one self-contained HTML string. It embeds the model+selection as inline JSON and ships vanilla JS that builds the grid and wires facet checkboxes. Uses the existing `web/` dark-theme tokens.

- [ ] **Step 1: Write the failing test**

```js
// test/review-render.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderShotPage, renderImagePage } from '../src/review-render.js';

test('renderShotPage: self-contained, embeds model, references videos', () => {
  const model = { type: 'shots', shots: [
    { shotId: 's1', episode: '1', characters: ['mira'], description: 'd', versions: [
      { version: 'v002', kind: 'draft', video: 'assets/s1/v002/output.mp4',
        variants: { alpha: null, upscaled: [], qc: [] }, meta: { model: 'seedance_2_5' } },
      { version: 'final', kind: 'final', video: 'assets/s1/final/clip.mp4',
        variants: { alpha: null, upscaled: [], qc: [] }, meta: {} }] }] };
  const sel = { layout: 'side-by-side', versions: { s1: ['v002', 'final'] } };
  const html = renderShotPage({ model, selection: sel, title: 'Shots' });
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /https?:\/\//);              // no external resources
  assert.match(html, /assets\/s1\/final\/clip\.mp4/);
  assert.match(html, /<script[^>]*id="review-data"[^>]*>/);
  assert.match(html, /"shotId": ?"s1"/);
});

test('renderImagePage: renders images and title', () => {
  const model = { type: 'images', characters: [
    { type: 'characters', name: 'mira', sheets: [
      { sheetType: 'pose', slug: 'a', versions: [
        { version: 'v001', images: ['assets/mira/pose/a/v001.png'], upscaled: [], meta: {} }] }] }] };
  const sel = { layout: 'side-by-side', versions: { 'mira/pose/a': ['v001'] } };
  const html = renderImagePage({ model, selection: sel, title: 'Sheets' });
  assert.match(html, /assets\/mira\/pose\/a\/v001\.png/);
  assert.match(html, /Sheets/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review-render.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/review-render.js
// Pure HTML rendering. Asset paths in `model` must already be page-relative.

const STYLE = `
:root { --bg:#14151a; --panel:#1c1e25; --line:#2c2f39; --fg:#e8e9ee;
  --dim:#9aa0b0; --accent:#7cc4ff; --warn:#ffcc66; --good:#7ddba0; }
* { box-sizing:border-box; }
body { margin:0; padding:1.5rem 1.25rem 5rem; background:var(--bg); color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
.wrap { max-width:1400px; margin:0 auto; display:grid; grid-template-columns:220px 1fr; gap:1.5rem; }
h1 { font-size:1.5rem; margin:0 0 .3rem; letter-spacing:-.01em; }
.sub { color:var(--dim); margin:0 0 1.5rem; }
.rail { position:sticky; top:1rem; align-self:start; }
.rail h3 { font-size:.8rem; text-transform:uppercase; letter-spacing:.05em; color:var(--dim); margin:1.2rem 0 .4rem; }
.rail label { display:block; font-size:.9rem; padding:.15rem 0; cursor:pointer; }
.rail input { margin-right:.5rem; }
.row { border-top:1px solid var(--line); padding:1.2rem 0; }
.row h2 { font-size:1rem; margin:0 0 .1rem; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent); }
.row .tags { color:var(--dim); font-size:.82rem; margin:0 0 .7rem; }
.cols { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); }
.cols.stacked { grid-template-columns:1fr; }
.col { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.7rem; }
.col .v { font-family:ui-monospace,Menlo,monospace; color:var(--good); font-size:.85rem; margin-bottom:.4rem; }
.col video, .col img { width:100%; border-radius:6px; display:block; background:#000; }
.col .m { color:var(--dim); font-size:.78rem; margin-top:.4rem; }
.missing { color:var(--warn); font-size:.85rem; padding:2rem 0; text-align:center; }
.links a { color:var(--accent); font-size:.78rem; margin-right:.6rem; }
`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// JSON embedded in a <script type="application/json"> — only </script> needs escaping.
function embed(data) {
  return JSON.stringify(data, null, 2).replace(/<\/script>/gi, '<\\/script>');
}

function page({ title, subtitle, data, script }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style></head>
<body>
<div class="wrap">
  <aside class="rail" id="rail"></aside>
  <main>
    <h1>${esc(title)}</h1>
    <p class="sub">${esc(subtitle)}</p>
    <div id="grid"></div>
  </main>
</div>
<script type="application/json" id="review-data">${embed(data)}</script>
<script>${script}</script>
</body></html>`;
}

const SHOT_SCRIPT = `
const DATA = JSON.parse(document.getElementById('review-data').textContent);
const state = { characters: new Set(), episodes: new Set(), text: '' };
const rail = document.getElementById('rail'), grid = document.getElementById('grid');
const allChars = [...new Set(DATA.model.shots.flatMap(s => s.characters))].sort();
const allEps = [...new Set(DATA.model.shots.map(s => s.episode).filter(Boolean))].sort();
function facet(title, values, set) {
  if (!values.length) return '';
  return '<h3>' + title + '</h3>' + values.map(v =>
    '<label><input type="checkbox" data-set="' + title + '" value="' + v + '">' + v + '</label>').join('');
}
rail.innerHTML = '<h3>Filter</h3><label><input id="txt" placeholder="regex" style="width:100%"></label>'
  + facet('Characters', allChars, state.characters)
  + facet('Episodes', allEps, state.episodes);
rail.addEventListener('input', (e) => {
  if (e.target.id === 'txt') state.text = e.target.value;
  else if (e.target.dataset.set === 'Characters') toggle(state.characters, e.target);
  else if (e.target.dataset.set === 'Episodes') toggle(state.episodes, e.target);
  render();
});
function toggle(set, el){ el.checked ? set.add(el.value) : set.delete(el.value); }
function visible(s) {
  if (state.text) { try { if (!new RegExp(state.text).test(s.shotId)) return false; } catch {} }
  if (state.characters.size && !s.characters.some(c => state.characters.has(c))) return false;
  if (state.episodes.size && !state.episodes.has(s.episode)) return false;
  return true;
}
function col(v) {
  const media = v.video
    ? '<video src="' + v.video + '" controls preload="metadata"></video>'
    : '<div class="missing">missing artifact</div>';
  const links = (v.variants.upscaled||[]).map(u => '<a href="' + u + '">upscaled</a>').join('')
    + (v.variants.alpha ? '<a href="' + v.variants.alpha + '">alpha</a>' : '');
  const m = [v.meta.model, v.meta.resolution, v.meta.ts].filter(Boolean).join(' · ');
  return '<div class="col"><div class="v">' + v.version + '</div>' + media
    + '<div class="m">' + m + '</div><div class="links">' + links + '</div></div>';
}
function render() {
  grid.innerHTML = DATA.model.shots.filter(visible).map(s => {
    const picks = new Set(DATA.selection.versions[s.shotId] || []);
    const cols = s.versions.filter(v => picks.has(v.version)).map(col).join('');
    return '<section class="row"><h2>' + s.shotId + '</h2><div class="tags">'
      + [s.episode && 'ep ' + s.episode, s.characters.join(', '), s.description].filter(Boolean).join(' — ')
      + '</div><div class="cols ' + DATA.selection.layout + '">' + cols + '</div></section>';
  }).join('') || '<p class="missing">No shots match.</p>';
}
render();
`;

const IMAGE_SCRIPT = `
const DATA = JSON.parse(document.getElementById('review-data').textContent);
const state = { characters: new Set(), sheets: new Set(), text: '' };
const rail = document.getElementById('rail'), grid = document.getElementById('grid');
const rows = DATA.model.characters.flatMap(c => c.sheets.map(sh => ({
  key: c.name + '/' + sh.sheetType + '/' + sh.slug, name: c.name,
  sheetType: sh.sheetType, slug: sh.slug, versions: sh.versions })));
const allChars = [...new Set(DATA.model.characters.map(c => c.name))].sort();
const allSheets = [...new Set(rows.map(r => r.sheetType))].sort();
function facet(title, values) {
  if (!values.length) return '';
  return '<h3>' + title + '</h3>' + values.map(v =>
    '<label><input type="checkbox" data-set="' + title + '" value="' + v + '">' + v + '</label>').join('');
}
rail.innerHTML = '<h3>Filter</h3><label><input id="txt" placeholder="slug regex" style="width:100%"></label>'
  + facet('Characters', allChars) + facet('Sheets', allSheets);
rail.addEventListener('input', (e) => {
  if (e.target.id === 'txt') state.text = e.target.value;
  else if (e.target.dataset.set === 'Characters') toggle(state.characters, e.target);
  else if (e.target.dataset.set === 'Sheets') toggle(state.sheets, e.target);
  render();
});
function toggle(set, el){ el.checked ? set.add(el.value) : set.delete(el.value); }
function visible(r) {
  if (state.text) { try { if (!new RegExp(state.text).test(r.slug)) return false; } catch {} }
  if (state.characters.size && !state.characters.has(r.name)) return false;
  if (state.sheets.size && !state.sheets.has(r.sheetType)) return false;
  return true;
}
function col(v) {
  const imgs = (v.images||[]).map(s => '<img src="' + s + '" loading="lazy">').join('')
    || '<div class="missing">missing artifact</div>';
  const m = [v.meta.model, v.meta.ts].filter(Boolean).join(' · ');
  return '<div class="col"><div class="v">' + v.version + '</div>' + imgs + '<div class="m">' + m + '</div></div>';
}
function render() {
  grid.innerHTML = rows.filter(visible).map(r => {
    const picks = new Set(DATA.selection.versions[r.key] || []);
    const cols = r.versions.filter(v => picks.has(v.version)).map(col).join('');
    return '<section class="row"><h2>' + r.key + '</h2><div class="cols ' + DATA.selection.layout + '">' + cols + '</div></section>';
  }).join('') || '<p class="missing">No sheets match.</p>';
}
render();
`;

export function renderShotPage({ model, selection, title = 'Shot review' }) {
  return page({ title, subtitle: `${model.shots.length} shot(s) · generated ${model.generatedAt || ''}`,
    data: { model, selection }, script: SHOT_SCRIPT });
}

export function renderImagePage({ model, selection, title = 'Image review' }) {
  const n = model.characters.reduce((a, c) => a + c.sheets.length, 0);
  return page({ title, subtitle: `${n} sheet(s) · generated ${model.generatedAt || ''}`,
    data: { model, selection }, script: IMAGE_SCRIPT });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/review-render.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review-render.js test/review-render.test.js
git commit -m "feat(review): self-contained HTML renderer for shot/image pages"
```

---

## Task 7: Orchestrator — vendor assets, write bundle, update, refresh index

**Files:**
- Create: `src/review-page.js`
- Test: `test/review-page.test.js`

`buildReviewPage(root, { type, slug, filters, selection, update, title })`:
1. Scan (`scanShots`/`scanImages`) → apply filters → error if empty.
2. Selection = provided, else on update merge stored `review.json` selection with fresh defaults for new items, else fresh defaults.
3. Refuse if `web/<slug>/` exists and not `update`.
4. **Vendor**: copy each selected artifact into `web/<slug>/assets/...`; build a page-relative clone of the model (paths rewritten to `assets/...`).
5. Render HTML from the page-relative model; write `index.html`, `review.json` (original model + selection + filters).
6. Run `scripts/update-web-index.js` to refresh `web/README.md`.

- [ ] **Step 1: Write the failing test**

```js
// test/review-page.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { buildReviewPage } from '../src/review-page.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-page-'));
  // minimal web/README.md with markers so the index refresh has something to update
  await mkdir(path.join(root, 'web'), { recursive: true });
  await writeFile(path.join(root, 'web', 'README.md'),
    '# Web\n<!-- pages:start -->\n<!-- pages:end -->\n');
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function seedShot(root, id) {
  const dir = path.join(root, 'shots', id, 'drafts', 'v001');
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(root, 'shots', id, 'final'), { recursive: true });
  await writeFile(path.join(dir, 'output.mp4'), 'video-bytes');
  await writeFile(path.join(dir, 'output.json'),
    JSON.stringify({ model: 'seedance_2_5', resolution: '480p', ts: 'T' }));
  await writeFile(path.join(root, 'shots', id, 'shot.yaml'),
    YAML.stringify({ shotId: id, elements: [{ type: 'characters', name: 'mira' }] }));
}

test('buildReviewPage: vendors clips and writes a self-contained bundle', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'art-talk-01');
    const res = await buildReviewPage(root, { type: 'shots', slug: 'ep1', title: 'Ep 1' });
    const html = await readFile(path.join(root, 'web', 'ep1', 'index.html'), 'utf8');
    assert.match(html, /assets\//);
    assert.doesNotMatch(html, /https?:\/\//);
    // vendored clip exists under web/ep1/assets and is referenced page-relative
    const vendored = path.join(root, 'web', 'ep1', 'assets', 'art-talk-01', 'v001', 'output.mp4');
    assert.ok((await stat(vendored)).isFile());
    const saved = JSON.parse(await readFile(path.join(root, 'web', 'ep1', 'review.json'), 'utf8'));
    assert.equal(saved.selection.versions['art-talk-01'][0], 'v001');
    assert.equal(res.pageDir, path.join(root, 'web', 'ep1'));
  });
});

test('buildReviewPage: refuses existing slug without update', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'a');
    await buildReviewPage(root, { type: 'shots', slug: 'ep1' });
    await assert.rejects(() => buildReviewPage(root, { type: 'shots', slug: 'ep1' }), /--update/);
  });
});

test('buildReviewPage: errors on empty result', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'shots'), { recursive: true });
    await assert.rejects(
      () => buildReviewPage(root, { type: 'shots', slug: 'x', filters: { match: 'zzz' } }),
      /no .* match/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review-page.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/review-page.js
import { mkdir, copyFile, writeFile, readFile, stat, cp } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanShots, scanImages } from './review-scan.js';
import {
  applyShotFilters, applyImageFilters, defaultShotSelection, defaultImageSelection,
} from './review-filter.js';
import { renderShotPage, renderImagePage } from './review-render.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }
async function readJson(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }

// Merge a stored selection with fresh defaults: keep stored picks for items that
// still exist; add default picks for items that appeared since.
function mergeSelection(stored, fresh) {
  if (!stored) return fresh;
  const versions = { ...fresh.versions };
  for (const [k, v] of Object.entries(stored.versions || {})) {
    if (k in versions) versions[k] = v;
  }
  return { layout: stored.layout || fresh.layout, versions };
}

// Copy one source file into the page's assets/ tree and return its page-relative path.
async function vendorFile(projectRoot, pageDir, relSrc) {
  if (!relSrc) return null;
  const src = path.join(projectRoot, relSrc);
  if (!(await exists(src))) return null;
  const destRel = path.join('assets', relSrc.replace(/^(\.\.[/\\])+/, ''));
  const dest = path.join(pageDir, destRel);
  await mkdir(path.dirname(dest), { recursive: true });
  if ((await stat(src)).isDirectory()) await cp(src, dest, { recursive: true });
  else await copyFile(src, dest);
  return destRel.split(path.sep).join('/');
}

// Rewrite every artifact path in the model to a vendored page-relative path.
async function vendorShotModel(projectRoot, pageDir, model) {
  const shots = [];
  for (const s of model.shots) {
    const versions = [];
    for (const v of s.versions) {
      versions.push({
        ...v,
        video: await vendorFile(projectRoot, pageDir, v.video),
        variants: {
          alpha: await vendorFile(projectRoot, pageDir, v.variants.alpha),
          upscaled: (await Promise.all(v.variants.upscaled.map((u) => vendorFile(projectRoot, pageDir, u)))).filter(Boolean),
          qc: (await Promise.all(v.variants.qc.map((q) => vendorFile(projectRoot, pageDir, q)))).filter(Boolean),
        },
      });
    }
    shots.push({ ...s, versions });
  }
  return { ...model, shots };
}

async function vendorImageModel(projectRoot, pageDir, model) {
  const characters = [];
  for (const c of model.characters) {
    const sheets = [];
    for (const sh of c.sheets) {
      const versions = [];
      for (const v of sh.versions) {
        versions.push({
          ...v,
          images: (await Promise.all(v.images.map((i) => vendorFile(projectRoot, pageDir, i)))).filter(Boolean),
          upscaled: (await Promise.all((v.upscaled || []).map((u) => vendorFile(projectRoot, pageDir, u)))).filter(Boolean),
        });
      }
      sheets.push({ ...sh, versions });
    }
    characters.push({ ...c, sheets });
  }
  return { ...model, characters };
}

async function refreshWebIndex(projectRoot) {
  const script = path.join(__dirname, '..', 'scripts', 'update-web-index.js');
  if (!(await exists(script)) || !(await exists(path.join(projectRoot, 'web', 'README.md')))) return;
  try { await execFileP(process.execPath, [script], { cwd: projectRoot }); } catch { /* index is best-effort */ }
}

export async function buildReviewPage(root, opts) {
  const { type, slug, filters = {}, selection: providedSelection, update = false, title } = opts;
  if (!slug) throw new Error('review: --slug is required');

  const raw = type === 'images' ? await scanImages(root) : await scanShots(root, { episodes: filters.episodes });
  const filtered = type === 'images' ? applyImageFilters(raw, filters) : applyShotFilters(raw, filters);
  const count = type === 'images'
    ? filtered.characters.reduce((a, c) => a + c.sheets.length, 0) : filtered.shots.length;
  if (count === 0) throw new Error(`review: no ${type} match the given filters`);

  const pageDir = path.join(root, 'web', slug);
  const pageExists = await exists(pageDir);
  if (pageExists && !update) {
    throw new Error(`review: web/${slug}/ already exists — pass --update to refresh it or choose a new --slug`);
  }

  const fresh = type === 'images' ? defaultImageSelection(filtered) : defaultShotSelection(filtered);
  const stored = update ? await readJson(path.join(pageDir, 'review.json')) : null;
  const selection = providedSelection || mergeSelection(stored && stored.selection, fresh);

  await mkdir(pageDir, { recursive: true });
  const pageModel = type === 'images'
    ? await vendorImageModel(root, pageDir, filtered)
    : await vendorShotModel(root, pageDir, filtered);

  const html = type === 'images'
    ? renderImagePage({ model: pageModel, selection, title: title || 'Image review' })
    : renderShotPage({ model: pageModel, selection, title: title || 'Shot review' });

  await writeFile(path.join(pageDir, 'index.html'), html);
  await writeFile(path.join(pageDir, 'review.json'),
    JSON.stringify({ type, filters, selection, model: filtered, generatedAt: new Date().toISOString() }, null, 2) + '\n');

  await refreshWebIndex(root);
  return { pageDir, count };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/review-page.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review-page.js test/review-page.test.js
git commit -m "feat(review): orchestrate scan, vendor assets, write bundle, refresh index"
```

---

## Task 8: CLI wiring + `.gitignore`

**Files:**
- Modify: `bin/pipeline.js` (add `review` branch; import; usage text)
- Modify: `.gitignore` (ignore `web/*/assets/`)
- Test: `test/review-page.test.js` (CLI arg parsing via a small exported parser)

To keep the CLI testable without spawning a process, factor arg parsing into a pure exported `parseReviewArgs(sub, rest)` in `src/review-page.js`, then the CLI calls it.

- [ ] **Step 1: Write the failing test**

```js
// append to test/review-page.test.js
import { parseReviewArgs } from '../src/review-page.js';

test('parseReviewArgs: shots filters and boolean --update', () => {
  const o = parseReviewArgs('shots',
    ['--slug', 'ep1', '--match', '^art-', '--characters', 'mira,joh', '--episode', '1,2', '--update']);
  assert.equal(o.type, 'shots');
  assert.equal(o.slug, 'ep1');
  assert.deepEqual(o.filters.characters, ['mira', 'joh']);
  assert.deepEqual(o.filters.episodes, ['1', '2']);
  assert.equal(o.filters.match, '^art-');
  assert.equal(o.update, true);
});

test('parseReviewArgs: images sheets filter', () => {
  const o = parseReviewArgs('images', ['--slug', 's', '--sheets', 'turnaround,pose']);
  assert.equal(o.type, 'images');
  assert.deepEqual(o.filters.sheets, ['turnaround', 'pose']);
  assert.equal(o.update, false);
});

test('parseReviewArgs: rejects unknown subcommand', () => {
  assert.throws(() => parseReviewArgs('bogus', ['--slug', 's']), /shots\|images/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review-page.test.js`
Expected: FAIL — `parseReviewArgs` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review-page.js`:

```js
function splitList(s) { return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined; }

// Pure arg parser for `pipeline review <sub> ...`. `--update` is a valueless boolean.
export function parseReviewArgs(sub, rest) {
  if (sub !== 'shots' && sub !== 'images') {
    throw new Error('usage: pipeline review <shots|images> --slug <name> [filters]');
  }
  const argv = rest.filter((t) => t !== '--update');
  const update = argv.length !== rest.length;
  const f = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`review: expected --flag, got "${argv[i]}"`);
    f[argv[i].slice(2)] = argv[i + 1];
  }
  const filters = {};
  if (f.match) filters.match = f.match;
  if (f.characters) filters.characters = splitList(f.characters);
  if (sub === 'shots' && f.episode) filters.episodes = splitList(f.episode);
  if (sub === 'images' && f.sheets) filters.sheets = splitList(f.sheets);
  return { type: sub, slug: f.slug, title: f.title, root: f.root, layout: f.layout, filters, update };
}
```

Then wire the CLI. In `bin/pipeline.js`, add the import near the other `src/` imports:

```js
import { buildReviewPage, parseReviewArgs } from '../src/review-page.js';
```

Add this branch in `main()` alongside the other `cmd === '…'` branches (e.g. right after the `shot promote` branch):

```js
  } else if (cmd === 'review') {
    const opts = parseReviewArgs(sub, rest);
    if (!opts.slug) fail('usage: pipeline review <shots|images> --slug <name> [--match <re>] [--characters a,b] [--episode N,M] [--sheets turnaround,pose] [--layout side-by-side|stacked] [--update] [--title ..] [--root <dir>]');
    const res = await buildReviewPage(projectRoot(opts.root), opts);
    console.log(`review page: ${res.pageDir}  (${res.count} item(s))`);
```

- [ ] **Step 4: Add the gitignore rule**

Append to `.gitignore` (after the existing `web`-related comments, or at end):

```
# Vendored review-page assets (copies of shot clips / sheet images). Pages are
# local review artifacts; the copied media is not versioned.
web/*/assets/
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/review-page.test.js`
Expected: PASS (parser + build tests).

Run the whole suite to confirm nothing regressed:
Run: `node --test`
Expected: PASS.

- [ ] **Step 6: Manual smoke test**

Run (uses the real `elements/characters/test-cecilia` fixture already on disk):
```bash
node bin/pipeline.js review images --slug smoke-images --title "Smoke"
```
Expected: prints `review page: .../web/smoke-images (N item(s))`; open `web/smoke-images/index.html` in a browser and confirm the turnaround sheet renders with character/sheet facets. Then clean up: `rm -rf web/smoke-images`.

- [ ] **Step 7: Commit**

```bash
git add bin/pipeline.js src/review-page.js test/review-page.test.js .gitignore
git commit -m "feat(review): wire pipeline review CLI and ignore vendored assets"
```

---

## Task 9: Docs — README + templates/CLAUDE.md

**Files:**
- Modify: `README.md` (document the `review` command)
- Modify: `templates/CLAUDE.md` (add the command to the per-project command list)

- [ ] **Step 1: Add to `templates/CLAUDE.md`** the command line (near the shot/element command bullets):

```markdown
- `pipeline review shots --slug <name> [--match <re>] [--characters a,b] [--episode N,M] [--layout side-by-side|stacked] [--update]` · `pipeline review images --slug <name> [--characters a,b] [--sheets turnaround,pose,cycles] [--update]` — build/refresh a self-contained review page under `web/<slug>/` with client-side filtering and side-by-side version comparison. Filters combine (intersection). Vendored clips/images under `web/<slug>/assets/` are gitignored.
```

- [ ] **Step 2: Add a short section to `README.md`** describing `pipeline review shots|images`, the combinable filters, that pages are self-contained static HTML opened directly in a browser, and that `web/<slug>/assets/` is gitignored (pages are local review artifacts).

- [ ] **Step 3: Refresh the web index** so any smoke page is not left in the table:

Run: `npm run web:index:check`
Expected: exit 0 (table up to date; no stray pages committed).

- [ ] **Step 4: Commit**

```bash
git add README.md templates/CLAUDE.md
git commit -m "docs(review): document pipeline review command"
```

---

## Self-review notes (author)

- **Spec coverage:** two page types (Tasks 6–8), combinable filters shots+images (Task 4), episodic+flat (Tasks 1–2), image log-driven+fallback (Task 3), side-by-side versions (Tasks 5–6), vendor assets (Task 7), gitignore no-version (Task 8), auto-refresh index (Task 7), update flow (Task 7 `mergeSelection`), error handling (Task 7 empty/collision; render missing-artifact placeholder). All covered.
- **Type consistency:** model/selection shapes defined once in the header and reused; `buildReviewPage`, `parseReviewArgs`, `vendorFile`, `mergeSelection` names consistent across tasks.
- **Note for executor:** `web/<slug>/assets/` is gitignored, so `index.html` + `review.json` are the only committable page files; that's intended (pages are local artifacts). The `shotDir`/`generationsLogPath` imports in Task 1's file header become used by Tasks 2–3.

## Open follow-ups (out of scope, do not build now)
- Synced multi-video play/scrub across a row (spec lists it as nice-to-have).
- Explicit `--versions <id>=v001,v003` per-shot override flag (default selection covers v1; add later if needed).
