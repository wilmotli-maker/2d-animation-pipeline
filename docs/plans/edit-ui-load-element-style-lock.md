# Edit-ui element style lock Implementation Plan

Status: implemented on `feat/edit-ui-element-style-lock`. The commit steps are not done; the user has not asked for a commit.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An edit-ui session can pick one project element and send that element's `style-lock.yaml` object as `request.styleLock`, with the existing textarea as a full replacement when it is non-empty.

**Architecture:** The video workspace stays `~/.pipeline/edit-ui`. Element files are read from `projectRoot()` (`--root`, then `ANIMATION_PIPELINE_ROOT`, then the current directory), passed into the edit server as `root`. `GET /api/elements` lists elements; `GET /api/elements/:type/:name/style-lock` returns the parsed object plus `styleLockToText` prose. The browser keeps the object in memory, persists only `{ type, name }`, and sends one `styleLock` value (`string | object`) on video generate and on-demand harmonize.

**Tech Stack:** Node.js (node:test), existing edit-ui HTTP server, browser module under `src/edit-ui/web/`.

**Spec:** The Global Constraints below. They are the decisions approved on 2026-10-28. There is no separate spec file.

## Global Constraints

- Picker only. Persist `{ type, name }` on `settings.styleLockElement`. A reload refetches the yaml. Do not persist the parsed object.
- Root is `projectRoot()`, passed into `startEditUi` / `createEditServer` as `root` from `pipeline edit-ui --root`. A missing or unreadable `elements/` directory yields an empty list. The video workspace is not the elements root.
- One element. The picker lists every `ELEMENT_TYPES` entry (`characters`, `props`, `scenes`, `other`). No concatenation.
- Override: a non-empty trimmed textarea sends that string. An empty textarea sends the loaded object. Neither present sends `''`. The preview is separate and server-rendered via `styleLockToText`. Do not copy the preview into the textarea.
- A missing `style-lock.yaml` on an existing element is no lock: the read returns `styleLock: null` and `text: ''`.
- Generate-time harmonize keeps forwarding `request.styleLock`. `POST /api/harmonize` sends the same resolved value from current settings.
- `ELEMENT_TYPES.includes(type)` and `assertSegment(name)` run before any path join. A name `assertSegment` rejects is not listed and is rejected on read.

## Review Focus

- A name `assertSegment` rejects (`..`, `undefined`, a separator) must not be joined onto the project root. Expected: HTTP 400, no read outside `root`. Test in Task 3.
- An existing element with no `style-lock.yaml` returns 200 `{ styleLock: null, text: '' }`. Expected: preview says there is no file; an empty textarea still sends `''`. Tests in Tasks 3 and 2.
- Whitespace-only free text does not override a loaded object. Expected: `resolveStyleLock` returns the object. Test in Task 2.
- A persisted `{ type, name }` that is not in the list is dropped. Expected: `matchSavedElement` returns null. Test in Task 2.
- On-demand harmonize with a structured lock delivers that object to the harmonizer. Test in Task 5.
- `root` omitted yields `{ elements: [] }` and a style-lock read of 404 `no project root`. Test in Task 3.

---

### Task 1: listElements

**Files:**
- Modify: `src/element.js`
- Test: `test/element.test.js`

**Interfaces:**
- Consumes: `ELEMENT_TYPES`, `assertSegment` (`src/config.js`)
- Produces: `listElements(root: string) -> Promise<Array<{ type: string, name: string }>>`

- [ ] **Step 1: Write the failing test**

```js
test('listElements lists every element type, skips files and illegal names, and is empty when elements/ is missing', async () => {
  await withTempRoot(async (root) => {
    assert.deepEqual(await listElements(root), []);
    await createElement(root, { type: 'characters', name: 'ada' });
    await createElement(root, { type: 'props', name: 'lamp' });
    await writeFile(path.join(root, 'elements', 'characters', 'notes.txt'), 'x');
    await mkdir(path.join(root, 'elements', 'characters', 'undefined'));
    const listed = await listElements(root);
    assert.deepEqual(listed, [
      { type: 'characters', name: 'ada' },
      { type: 'props', name: 'lamp' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/element.test.js`
Expected: FAIL — `listElements` is not exported.

- [ ] **Step 3: Implement `listElements(root)` in `src/element.js`**

Walk `ELEMENT_TYPES` in order. `readdir` each `elements/<type>` with file types. Skip `ENOENT` and `ENOTDIR`. Keep directories whose names pass `assertSegment`. Sort names with `localeCompare` within a type.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/element.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/element.js test/element.test.js
git commit -m "feat(elements): list style-lock elements by type"
```

### Task 2: resolve the wire value

**Files:**
- Create: `src/edit-ui/web/style-lock.js`
- Test: `test/edit-ui-style-lock.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `resolveStyleLock({ freeText = '', loaded = null } = {}) -> string | object`
  - `matchSavedElement(elements, saved) -> { type, name } | null`
  - `elementOptionValue(el) -> string` (`type/name`)

- [ ] **Step 1: Write the failing test**

```js
import { resolveStyleLock, matchSavedElement, elementOptionValue } from '../src/edit-ui/web/style-lock.js';

test('non-empty free text replaces the loaded object, including after trim', () => {
  const loaded = { styleRegister: 'flat-cartoon' };
  assert.equal(resolveStyleLock({ freeText: '  a red dragon  ', loaded }), 'a red dragon');
  assert.equal(resolveStyleLock({ freeText: '   ', loaded }), loaded);
  assert.equal(resolveStyleLock({ freeText: '', loaded: null }), '');
  assert.equal(resolveStyleLock({ freeText: '', loaded }), loaded);
});

test('a saved element is kept only when that type and name are still listed', () => {
  const elements = [{ type: 'characters', name: 'ada' }];
  assert.deepEqual(matchSavedElement(elements, { type: 'characters', name: 'ada' }), elements[0]);
  assert.equal(matchSavedElement(elements, { type: 'characters', name: 'gone' }), null);
  assert.equal(matchSavedElement(elements, null), null);
  assert.equal(elementOptionValue(elements[0]), 'characters/ada');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/edit-ui-style-lock.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the three functions in `src/edit-ui/web/style-lock.js`**

`resolveStyleLock`: trim a string `freeText`; if the trim is non-empty, return that trim; if `loaded == null`, return `''`; otherwise return `loaded`. `matchSavedElement` returns the list entry with the same `type` and `name`, or null when `saved` is not that shape. `elementOptionValue` returns `` `${el.type}/${el.name}` ``.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/edit-ui-style-lock.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/edit-ui/web/style-lock.js test/edit-ui-style-lock.test.js
git commit -m "feat(edit-ui): resolve style-lock override against a loaded element"
```

### Task 3: project root and element endpoints

**Files:**
- Create: `src/edit-ui/elements-api.js`
- Modify: `src/edit-ui/server.js` (`createEditServer`, `startEditUi`, routes before the per-video block)
- Test: `test/edit-ui-elements-api.test.js`
- Test: `test/edit-ui-server.test.js`

**Interfaces:**
- Consumes: `listElements` (Task 1), `readStyleLock`, `styleLockToText`, `assertSegment`, `ELEMENT_TYPES`, `elementDir`
- Produces:
  - `loadElementStyleLock(root, type, name) -> Promise<{ type, name, styleLock, text }>` throws `Error` with `.status`
  - `GET /api/elements` → `{ elements }`
  - `GET /api/elements/:type/:name/style-lock` → the `loadElementStyleLock` body
  - `createEditServer({ root = null })` and `startEditUi({ root = null })` store `root` on the server context

- [ ] **Step 1: Write the failing tests**

`loadElementStyleLock` cases: object round-trip (`styleLock` deep-equals the written object, `text` equals `styleLockToText` of it); existing element with no yaml → `{ styleLock: null, text: '' }`; missing element directory → status 404; type `vehicles` → status 400; name `..` and name `undefined` → status 400.

Server cases, using `startEditUi({ root, ... })`: `GET /api/elements` lists a created character; the style-lock route returns that object's `wardrobe`; omitted `root` returns `{ elements: [] }` and the style-lock route returns 404 with error `no project root`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/edit-ui-elements-api.test.js test/edit-ui-server.test.js`
Expected: FAIL — `loadElementStyleLock` missing, and `/api/elements` is 404.

- [ ] **Step 3: Implement `loadElementStyleLock` and the two routes**

Validate type and name before `elementDir`. Missing `root` throws status 404 `no project root`. Missing element directory throws status 404. A YAML parse error throws status 400 with the parser message. `text` is `styleLockToText(styleLock)`. Register both GET routes before the per-video `id` lookup. `listElements` result is the `elements` array. No `root` on the list route returns `{ elements: [] }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/edit-ui-elements-api.test.js test/edit-ui-server.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/edit-ui/elements-api.js src/edit-ui/server.js test/edit-ui-elements-api.test.js test/edit-ui-server.test.js
git commit -m "feat(edit-ui): read project element style locks from the project root"
```

### Task 4: pass the project root from the CLI

**Files:**
- Modify: `bin/pipeline.js` (`edit-ui` command)

**Interfaces:**
- Consumes: `projectRoot` (already imported), `startEditUi({ root })` from Task 3
- Produces: `pipeline edit-ui` calls `startEditUi` with `root: projectRoot(f.root)`

- [ ] **Step 1: Wire `root`**

In the `edit-ui` branch, `const root = projectRoot(f.root)` and pass `root` to `startEditUi`. Include the project path in the startup log. The video workspace flag stays `--workspace`.

- [ ] **Step 2: Confirm the process starts against a temp root**

Run a stub server (`--generator stub --port 0 --root <tmp> --workspace <tmp>/ws`), `GET /api/elements` after creating one character, then stop the process.
Expected: HTTP 200 and that character in `elements`.

- [ ] **Step 3: Commit**

```bash
git add bin/pipeline.js
git commit -m "feat(edit-ui): point the element picker at the project root"
```

### Task 5: on-demand harmonize carries the style lock

**Files:**
- Modify: `src/edit-ui/server.js` (`POST /api/harmonize`)
- Test: `test/edit-ui-server.test.js`

**Interfaces:**
- Consumes: `startHarmonize(ctx, runDir, splicedRel, styleLock)` (already forwards its fourth argument)
- Produces: the on-demand route passes `body.styleLock` through

- [ ] **Step 1: Write the failing test**

Extend the on-demand harmonize setup with a second request whose JSON body is `{ id, run, styleLock: { styleRegister: '3d-render', wardrobe: 'blue coat' } }`. Assert the stub harmonizer receives that object as `styleLock`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/edit-ui-server.test.js`
Expected: FAIL — received `undefined`.

- [ ] **Step 3: Pass `body.styleLock` into `startHarmonize`**

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/edit-ui-server.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/edit-ui/server.js test/edit-ui-server.test.js
git commit -m "fix(edit-ui): carry the style lock on on-demand harmonize"
```

### Task 6: element picker in the Style lock panel

**Files:**
- Modify: `src/edit-ui/web/index.html`
- Modify: `src/edit-ui/web/edit.css`
- Modify: `src/edit-ui/web/app.js`

**Interfaces:**
- Consumes: `resolveStyleLock`, `matchSavedElement`, `elementOptionValue` (Task 2); `GET /api/elements` and `GET /api/elements/:type/:name/style-lock` (Task 3)
- Produces: the video job and `POST /api/harmonize` send `currentStyleLock()`

- [ ] **Step 1: Add the controls**

Under the Style lock heading, a `<select id="style-lock-element">` whose first option is `None` (`value=""`), a `<p id="style-lock-preview" class="dim style-lock-preview" hidden>`, and the existing textarea. Placeholder: `Optional override. Leave blank to use the selected element's style lock.` The select and textarea are full width of the panel. The preview wraps.

- [ ] **Step 2: Load, persist, and send**

`data.settings` gains `styleLockElement: null`. The parsed object lives on `ui.styleLockLoaded` as `{ type, name, styleLock }` and is not part of `data` (the session save stringifies `data`).

`syncStyleLockPicker()` fetches `/api/elements`, rebuilds the select, and applies `matchSavedElement`. A saved element that is absent is set to null and saved. A match fetches the style-lock route. `styleLock == null` shows `No style-lock.yaml for this element.` A non-empty `text` is the preview text. The textarea is not written by this fetch.

Changing the select updates `settings.styleLockElement` and refetches. `restore` (undo) calls `syncStyleLockPicker`. `loadVideo` calls it after settings are applied.

`currentStyleLock()` uses `resolveStyleLock` with the textarea and the loaded object only when its type and name match `settings.styleLockElement`. `generateVideo` and `harmonizeRun` await the in-flight fetch, then send that value as `styleLock`.

- [ ] **Step 3: Verify in the browser**

Start edit-ui with `--generator stub`, a temp project that has `elements/characters/ada/style-lock.yaml` (`wardrobe: red hoodie`), and a tiny mp4. Open the session, choose `characters / ada`, confirm the preview contains `red hoodie` and the textarea is empty, then confirm `resolveStyleLock` on the page returns the object for an empty override and the typed string when the textarea has text.

- [ ] **Step 4: Commit**

```bash
git add src/edit-ui/web/index.html src/edit-ui/web/edit.css src/edit-ui/web/app.js
git commit -m "feat(edit-ui): pick an element style lock for the edit prompt"
```
