# Review From Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pipeline review shots --folder <dir>` builds a review page from a flat, manually-curated folder of shot files, deriving shots and versions from filenames (`<shotId>-vNNN.ext`; no suffix → single `v001`).

**Architecture:** A new `scanFolder(projectRoot, dir)` in `src/review-scan.js` emits the **same shot-model shape** as `scanShots`, so filters, all-versions selection, asset vendoring, and the renderer are reused with no changes. `buildReviewPage` gains a `folder` option that swaps the scan source; `parseReviewArgs` captures `--folder`.

**Tech Stack:** Node ESM, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-review-from-folder-design.md`

---

## File structure

- Modify `src/review-scan.js` — add `scanFolder(projectRoot, dir)` (reuses `listFiles`, `relTo`).
- Modify `src/review-page.js` — `buildReviewPage` `folder` option; `parseReviewArgs` `--folder`.
- Modify `bin/pipeline.js` — add `[--folder <dir>]` to the `review` usage string.
- Modify `test/review-scan.test.js` — `scanFolder` tests.
- Modify `test/review-page.test.js` — `buildReviewPage({folder})` + `parseReviewArgs` tests.
- Modify `README.md`, `templates/CLAUDE.md` — document `--folder`.

**Shot-model shape scanFolder must emit (identical to `scanShots`):**
```
{ generatedAt, type:'shots', shots:[ {
    shotId, episode:null, description:'', mode:null, duration:null,
    promotedVersion:null, characters:[],
    versions:[ { version, kind:'draft', promoted:false, video, variants:{alpha:null,upscaled:[],qc:[]}, meta:{} } ]
} ] }
```

---

## Task 1: `scanFolder` — flat folder → shot model

**Files:**
- Modify: `src/review-scan.js`
- Test: `test/review-scan.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/review-scan.test.js`:

```js
import { scanFolder } from '../src/review-scan.js';

test('scanFolder: filenames -> shots/versions, single-version fallback, skips non-video', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, 'episodes', '2', 'shots', 'candidates');
    await mkdir(dir, { recursive: true });
    for (const n of ['ai-1-v003.mp4', 'ai-1-v006.mp4', 'art-2-v015.mp4', 'intro.mp4', 'notes.txt']) {
      await writeFile(path.join(dir, n), 'x');
    }
    const model = await scanFolder(root, dir);
    assert.equal(model.type, 'shots');
    const ids = model.shots.map((s) => s.shotId);
    assert.deepEqual(ids, ['ai-1', 'art-2', 'intro']);            // sorted, notes.txt skipped
    const ai1 = model.shots.find((s) => s.shotId === 'ai-1');
    assert.deepEqual(ai1.versions.map((v) => v.version), ['v003', 'v006']);
    assert.equal(ai1.episode, null);
    assert.deepEqual(ai1.characters, []);
    assert.equal(ai1.promotedVersion, null);
    assert.ok(ai1.versions[0].video.endsWith('candidates/ai-1-v003.mp4'));
    const intro = model.shots.find((s) => s.shotId === 'intro');
    assert.deepEqual(intro.versions.map((v) => v.version), ['v001']);   // no -vNNN -> single v001
    assert.equal(intro.versions[0].kind, 'draft');
  });
});

test('scanFolder: empty/no-video folder yields no shots', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, 'empty');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'readme.txt'), 'x');
    const model = await scanFolder(root, dir);
    assert.equal(model.shots.length, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review-scan.test.js`
Expected: FAIL — `scanFolder` not exported.

- [ ] **Step 3: Add `scanFolder` to `src/review-scan.js`**

Append at the end of the file:

```js
// A flat, manually-curated folder of shot files (e.g. episodes/N/shots/candidates/).
// Filenames encode shot + version as "<shotId>-vNNN.<ext>"; a file with no -vNNN
// suffix is a single-version shot (v001). Non-video files are skipped. Emits the
// same model shape as scanShots so filtering/selection/vendoring/rendering are reused.
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v']);

export async function scanFolder(projectRoot, dir) {
  const byShot = new Map();
  for (const name of await listFiles(dir)) {
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
    if (!VIDEO_EXT.has(ext)) continue;
    const stem = name.slice(0, dot);
    const m = /^(.+)-(v\d+)$/.exec(stem);       // "-v003" (empty stem) fails .+ -> falls through
    const shotId = m ? m[1] : stem;
    const version = m ? m[2] : 'v001';
    if (!byShot.has(shotId)) byShot.set(shotId, []);
    byShot.get(shotId).push({
      version, kind: 'draft', promoted: false,
      video: relTo(projectRoot, path.join(dir, name)),
      variants: { alpha: null, upscaled: [], qc: [] }, meta: {},
    });
  }
  const shots = [...byShot.entries()].map(([shotId, versions]) => {
    versions.sort((a, b) => (parseInt(a.version.slice(1), 10) || 0) - (parseInt(b.version.slice(1), 10) || 0));
    return { shotId, episode: null, description: '', mode: null, duration: null, promotedVersion: null, characters: [], versions };
  }).sort((a, b) => a.shotId.localeCompare(b.shotId));
  return { generatedAt: new Date().toISOString(), type: 'shots', shots };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/review-scan.test.js`
Expected: PASS (all scan tests).

Then the full suite:
Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review-scan.js test/review-scan.test.js
git commit -m "feat(review): scanFolder derives shots/versions from filenames in a flat folder"
```

---

## Task 2: `--folder` in `buildReviewPage` and the CLI

**Files:**
- Modify: `src/review-page.js`
- Modify: `bin/pipeline.js`
- Test: `test/review-page.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/review-page.test.js`:

```js
async function seedFolder(root, files) {
  const dir = path.join(root, 'candidates');
  await mkdir(dir, { recursive: true });
  for (const n of files) await writeFile(path.join(dir, n), 'v');
  return dir;
}

test('buildReviewPage: --folder builds a page from filenames and vendors the files', async () => {
  await withTempRoot(async (root) => {
    const dir = await seedFolder(root, ['ai-1-v003.mp4', 'ai-1-v006.mp4', 'art-2-v015.mp4']);
    const res = await buildReviewPage(root, { type: 'shots', slug: 'cand', folder: dir });
    assert.equal(res.count, 2);                          // ai-1, art-2
    const saved = JSON.parse(await readFile(path.join(root, 'web', 'cand', 'review.json'), 'utf8'));
    assert.deepEqual(saved.selection.versions['ai-1'], ['v003', 'v006']);   // all versions
    const vendored = path.join(root, 'web', 'cand', 'assets', 'candidates', 'ai-1-v003.mp4');
    assert.ok((await stat(vendored)).isFile());
  });
});

test('buildReviewPage: --folder with images is rejected', async () => {
  await withTempRoot(async (root) => {
    const dir = await seedFolder(root, ['x-v001.mp4']);
    await assert.rejects(
      () => buildReviewPage(root, { type: 'images', slug: 'x', folder: dir }),
      /only valid with 'shots'/);
  });
});

test('buildReviewPage: --folder with no video files is rejected', async () => {
  await withTempRoot(async (root) => {
    const dir = await seedFolder(root, ['readme.txt']);
    await assert.rejects(
      () => buildReviewPage(root, { type: 'shots', slug: 'x', folder: dir }),
      /no video files/);
  });
});

test('parseReviewArgs: --folder captured on opts', () => {
  const o = parseReviewArgs('shots', ['--slug', 'cand', '--folder', '/tmp/candidates']);
  assert.equal(o.folder, '/tmp/candidates');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/review-page.test.js`
Expected: FAIL — `folder` not handled / `parseReviewArgs` doesn't return it.

- [ ] **Step 3: Handle `folder` in `buildReviewPage`**

In `src/review-page.js`, update the import:

```js
import { scanShots, scanImages, scanFolder } from './review-scan.js';
```

Change the destructure line:

```js
  const { type, slug, filters = {}, selection: providedSelection, update = false, title, out } = opts;
```
to:
```js
  const { type, slug, filters = {}, selection: providedSelection, update = false, title, out, folder } = opts;
```

Replace the scan block:

```js
  const raw = type === 'images' ? await scanImages(root) : await scanShots(root, { episodes: filters.episodes });
  warnUnknownFilters(type, raw, filters);
  const filtered = type === 'images' ? applyImageFilters(raw, filters) : applyShotFilters(raw, filters);
  const count = type === 'images'
    ? filtered.characters.reduce((a, c) => a + c.sheets.length, 0) : filtered.shots.length;
  if (count === 0) throw new Error(`review: no ${type} match the given filters`);
```

with:

```js
  if (folder && type !== 'shots') throw new Error("review: --folder is only valid with 'shots'");
  const folderAbs = folder ? path.resolve(folder) : null;

  const raw = folderAbs
    ? await scanFolder(root, folderAbs)
    : (type === 'images' ? await scanImages(root) : await scanShots(root, { episodes: filters.episodes }));
  if (folderAbs && raw.shots.length === 0) throw new Error(`review: no video files in ${folderAbs}`);

  warnUnknownFilters(type, raw, filters);
  const filtered = type === 'images' ? applyImageFilters(raw, filters) : applyShotFilters(raw, filters);
  const count = type === 'images'
    ? filtered.characters.reduce((a, c) => a + c.sheets.length, 0) : filtered.shots.length;
  if (count === 0) throw new Error(`review: no ${type} match the given filters`);
```

In `parseReviewArgs`, change the return line:

```js
  return { type: sub, slug: f.slug, title: f.title, root: f.root, out: f.out, layout: f.layout, filters, update };
```
to:
```js
  return { type: sub, slug: f.slug, title: f.title, root: f.root, out: f.out, folder: f.folder, layout: f.layout, filters, update };
```

- [ ] **Step 4: Add `--folder` to the CLI usage string**

In `bin/pipeline.js`, find the `review` usage `fail(...)` string and add `[--folder <dir>]` after `[--exclude <re>]`:

```js
    if (!opts.slug) fail('usage: pipeline review <shots|images> --slug <name> [--match <re>] [--exclude <re>] [--folder <dir>] [--characters a,b] [--episode N,M] [--sheets turnaround,pose] [--layout side-by-side|stacked] [--update] [--title ..] [--out <dir>] [--root <dir>]');
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/review-page.test.js`
Expected: PASS.

Full suite:
Run: `node --test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/review-page.js bin/pipeline.js test/review-page.test.js
git commit -m "feat(review): --folder source for review shots (buildReviewPage + CLI)"
```

---

## Task 3: Smoke test + docs

**Files:**
- Modify: `README.md`, `templates/CLAUDE.md`

- [ ] **Step 1: Manual smoke test against the real curated folder**

Run:
```bash
cd "/Users/wilmotli/Projects/Seedance Animation/ArtAI"
node /Users/wilmotli/Projects/2d-animation-pipeline/bin/pipeline.js review shots \
  --folder episodes/2/shots/candidates --slug ep2-candidates --title "ArtAI — Ep2 candidates"
```
Expected: `review page: …/web/ep2-candidates (N item(s))` where N is the number of distinct shot ids (e.g. `ai-1`, `ai-2`, … `monster-5`). Confirm `web/ep2-candidates/index.html` exists and (headless) that it references vendored clips under `assets/episodes/2/shots/candidates/…`, e.g. `grep -c 'candidates/ai-2-v009.mp4' web/ep2-candidates/index.html` is ≥1, and that `ai-2` shows its four versions (v003/v006/v007/v009). Report the stdout and grep counts. Do NOT commit anything under the ArtAI project.

- [ ] **Step 2: Add the README bullet**

In `README.md`, in the "Review pages" section, add after the filters bullet:

```markdown
- Point `review shots --folder <dir>` at a flat, manually-curated folder of clips
  named `<shotId>-vNNN.ext` (e.g. `episodes/2/shots/candidates/`); shots and versions
  are read from the filenames (a name with no `-vNNN` is a single `v001`). `--match`/
  `--exclude` still apply; `--episode` is ignored.
```

- [ ] **Step 3: Add the `templates/CLAUDE.md` note**

Append to the `pipeline review shots …` bullet in `templates/CLAUDE.md`, before the trailing period of the shots clause, a mention:

```markdown
  Add `--folder <dir>` to build the page from a flat folder of `<shotId>-vNNN.ext` clips instead of the `shots/` tree.
```
(Place it as a sentence within that bullet so it reads naturally alongside the existing `review shots` description.)

- [ ] **Step 4: Refresh check + commit**

Run: `node --test`
Expected: PASS.

```bash
git add README.md templates/CLAUDE.md
git commit -m "docs(review): document review shots --folder"
```

---

## Self-review notes (author)

- **Spec coverage:** `--folder` flag (Task 2), filename parsing + single-version fallback + non-video skip (Task 1), same-model-shape reuse (Task 1 shape matches `scanShots`), folder+images rejection and no-video rejection (Task 2), `parseReviewArgs` capture (Task 2), cwd-relative resolution via `path.resolve(folder)` (Task 2), docs (Task 3). All covered.
- **Reuse:** `scanFolder` uses the existing `listFiles`/`relTo`; downstream (`applyShotFilters`, `defaultShotSelection`, asset wipe+vendor, render, `warnUnknownFilters`) is untouched — `folder` forces `type:'shots'`, so every existing shots branch applies.
- **Type consistency:** the emitted shot/version fields (`episode`, `characters`, `promotedVersion`, `variants`, `meta`, `kind`, `promoted`) match what `scanShots` produces and what the renderer reads.
- **Edge:** empty stem (`-v003.mp4`) → `.+` fails, `shotId` becomes the full stem `-v003`, nothing dropped.
- **No placeholders**; every step has full code and exact commands.

## Out of scope (do not build)
- Recursing into subfolders; images-from-folder; inferring characters/episode/promotion.
