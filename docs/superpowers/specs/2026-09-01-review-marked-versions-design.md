# Review Pages — Marked Versions — Design

**Date:** 2026-09-01
**Status:** Approved (brainstormed with user); ready for implementation plan
**Builds on:** `docs/superpowers/specs/2026-08-23-shot-review-pages-design.md`

## Problem

Reviewers can browse all versions of a shot/sheet side by side, but there's no way to
**mark the takes they like** and pull those choices out of the page. We want per-version
marking, a page-wide "show only marked" view, and a way to **save/load** the marked set
(names/versions only — not the media). The page is served from **GitHub Pages** (a static
host), so save/load must work with plain browser APIs, no server.

## Scope

Almost entirely a **client-side** change in `src/review-render.js` (the embedded page JS).
The only server-side plumbing: `buildReviewPage` passes the **slug** and **type** into the
render functions so the page can namespace its storage and name its download. No changes to
scanning, filtering, or vendoring.

## Feature summary

1. **Per-version mark checkbox** — each column header gets a "mark" checkbox next to the
   existing `hide` button. A marked column shows an accent border + checked box.
2. **Show only marked** (top-toolbar toggle) — filters every row to just its marked versions.
3. **No-marks indicator** — in show-only-marked mode, a row with zero marks stays visible and
   shows the text *"no marked versions"* instead of columns.
4. **Download marks** — exports a pretty-printed JSON of the marked set.
5. **Import marks** — file picker that restores marks from a previously-downloaded JSON.
6. **Auto-persist** — marks are saved to `localStorage` as they change and restored on load.

## Interaction semantics

`mark`, `hide`, and `show-only-marked` are **independent axes**:

- **hide** declutters the view (a hidden version collapses to the existing labeled marker).
- **mark** records a liked take.
- **show only marked** is a page-wide view mode. When ON, each row renders its marked
  versions as full columns and **ignores hide state** (marking a version means you want to
  see it); rows with no marks render the *"no marked versions"* text. When OFF, all selected
  versions render as today and marks are merely highlighted.

A version can be both marked and hidden; toggling show-only-marked resolves the conflict in
favor of showing marked versions.

## Client state (in the embedded page JS)

Extends the existing `state` object (which already holds `characters`, `episodes`, `text`,
`hidden`):

```
state.marked        // Set of "<rowKey>::<version>" strings
state.showMarkedOnly // boolean
```

- `rowKey` = `shotId` on the shot page, `name/sheetType/slug` on the image page (same keys
  already used for `hidden` and for `selection.versions`).
- **Persistence:** on any change to `state.marked`, write it to
  `localStorage["review:marks:" + DATA.slug]` as a JSON array of the set's members. On page
  load, read that key (if present) back into `state.marked`. Namespacing by slug prevents
  collisions between multiple review pages hosted on the same Pages origin. `localStorage`
  access is wrapped in try/catch so a storage-disabled browser degrades to session-only marks
  rather than throwing.

## The marks JSON (download / import)

Pretty-printed (`JSON.stringify(obj, null, 2)`), human-readable, round-trippable:

```json
{
  "page": "art-ep1",
  "type": "shots",
  "title": "ArtAI — Episode 1 — Art shots",
  "exportedAt": "2026-09-01T00:00:00.000Z",
  "marks": {
    "art-talk-01": ["v006"],
    "art-talk-04": ["v011", "v013"]
  }
}
```

- `marks` includes **only rows with ≥1 marked version**; version arrays are in the model's
  version order.
- `page`/`type`/`title` come from the embedded `DATA`; `exportedAt` is set at download time.

**Download.** Build the object from `state.marked`, `JSON.stringify` it, wrap in a
`Blob(['...'], {type:'application/json'})`, and trigger a download via a transient
`URL.createObjectURL` + `<a download="<slug>-marks.json">` appended to the DOM, clicked, then
removed and revoked. Works on GitHub Pages (normal browser tab, not a sandbox).

**Import.** A hidden `<input type="file" accept="application/json">`; on change, `FileReader`
reads the text, `JSON.parse` it, then:
- Validate it's an object with a `marks` object; on failure show a small inline error message
  in the toolbar (not an `alert`) and make no changes.
- For each `key → [versions]`, add `key::version` to `state.marked` **only when that key
  exists in `DATA.model` and the version exists for it** (silently skip unknowns so an import
  from a differently-filtered or older page can't inject dangling marks).
- Persist to `localStorage` and re-render. Import **merges** into existing marks (does not
  clear first), which is the least-surprising default; the user can un-mark afterwards.

## UI / layout

- **Toolbar:** a new element between the page subtitle and the grid, holding: `Show only
  marked` (toggle button, reflects on/off state), `Download marks`, `Import marks`, and a
  small inline `error` slot (hidden unless an import fails). A live count (`N marked`) is
  shown next to the toggle.
- **Column header (`.vrow`):** gains a `mark` checkbox alongside the version label + `hide`.
- **Styles:** `.col.marked` (accent border/outline), toolbar + button styling reusing the
  existing token palette (`--accent`, `--line`, `--panel`). The toggle uses a pressed/active
  style when on. All additive to the existing `STYLE` string.

## Refactor (in-scope, targeted)

The SHOT and IMAGE client scripts already duplicate `esc`, `hmark`, `toggle`, `unhideRow`, and
now would duplicate marks persistence + download + import. Factor the shared client-side JS
into **one common string** (e.g. `COMMON_SCRIPT`) concatenated into both `SHOT_SCRIPT` and
`IMAGE_SCRIPT`, so this logic exists once. Page-specific bits (facets, `visible`, `col`,
`render`, the `rows`/`shots` iteration) stay in each script. This keeps `review-render.js`
maintainable as it grows.

## Server-side plumbing

`buildReviewPage` already has `slug`, `type`, and `title`. Pass `slug` (and `type`, if not
already) into `renderShotPage` / `renderImagePage`, which embed them in the page `DATA`
alongside `model` and `selection`. `review.json` is unchanged — marks are a viewer-side
concept, never written back by the generator.

## Error handling

- `localStorage` unavailable/throwing → wrap in try/catch; marks work for the session, just
  don't persist.
- Malformed import file → inline toolbar error, no state change.
- Import references unknown shot/version → skipped silently (count of applied vs skipped may
  be surfaced in the toolbar text, e.g. `imported 5 marks`).
- Marks in `localStorage` for versions that no longer exist after a rebuild → harmless; they
  simply don't render and aren't re-exported (export only walks the current model).

## Testing

Renderer tests are string-presence (matching existing `review-render.test.js` conventions),
since the logic lives in an embedded `<script>` string:

- `renderShotPage`/`renderImagePage` output contains: the `mark` checkbox markup, the three
  toolbar controls (`Show only marked`, `Download marks`, `Import marks`), the
  slug-namespaced storage key `review:marks:<slug>`, and the `<slug>-marks.json` download
  name — i.e. the slug is embedded and used.
- `buildReviewPage` test: the generated `index.html` embeds the page slug in `DATA` (assert
  `"slug": "ep1"` appears) so storage/download are correctly namespaced.
- The marks JSON schema is documented here; the pure shape (keys/versions) is exercised
  indirectly by the presence tests. (No jsdom in the repo, so no DOM-execution test — matches
  how `hide`/marker behavior is currently covered.)

## Out of scope (YAGNI)

- Feeding marks back into a pipeline command (promote/export marked versions). The JSON schema
  is stable enough to support this later, but no CLI consumer is built now.
- Sharing marks between people in real time / any server-side store.
- Per-row (rather than page-wide) "show only marked" toggles.
