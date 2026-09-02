# Review Pages — From a Flat Folder — Design

**Date:** 2026-09-01
**Status:** Approved (brainstormed with user); ready for implementation plan
**Builds on:** `docs/superpowers/specs/2026-08-23-shot-review-pages-design.md`

## Problem

Some shots are collected in a **manually curated flat folder** rather than the structured
`shots/<id>/drafts/vNNN/…` tree — e.g. ArtAI `episodes/2/shots/candidates/`, which holds
files like `ai-2-v009.mp4`, one flat set with multiple versions per shot encoded in the
filename. There's no way to build a review page from such a folder today. We want to point
the review command at a folder and derive shots/versions from the filenames.

## Invocation

`pipeline review shots --folder <dir> --slug <name>`

When `--folder` is given, the command scans that flat folder instead of the structured
`shots/` tree. Everything else about `review shots` is unchanged:

- `--match` / `--exclude` still apply (regex on shot id).
- `--episode` is **ignored** (a flat folder has no episodes).
- `--update`, `--out`, `--layout`, `--title`, `--root`, and the whole page behavior
  (select / hide / show-only-selected / download-import / scroll preservation) come along
  unchanged.
- `--folder` is only valid with `review shots`. Combining it with `review images` is an error.

`--folder` is resolved relative to the current directory (like `--image` reference paths),
not `--root`.

## Filename parsing

Non-recursive scan of the folder's own entries. For each **video** file (extension in
`mp4`, `mov`, `webm`, `m4v`; case-insensitive), take the stem (filename without extension)
and split a trailing `-vNNN`:

- Matches `^(.+)-(v\d+)$` → shot id = group 1, version = group 2.
  `ai-2-v009.mp4` → shot `ai-2`, version `v009`.
- No `-vNNN` suffix → shot id = the whole stem, version `v001` (a single-version shot).
  `intro.mp4` → shot `intro`, version `v001`.

Files are grouped by shot id; within a shot, versions are sorted by the numeric part of the
`vNNN`. Non-video files (and directories) are skipped. Shots are sorted by id.

## Reuses the existing pipeline

`scanFolder` emits the **same shot-model shape** as `scanShots`, so no downstream code
changes:

```js
// { generatedAt, type: 'shots', shots: [ ShotEntry ] }
// ShotEntry = {
//   shotId, episode: null, description: '', mode: null, duration: null,
//   promotedVersion: null, characters: [],
//   versions: [{ version, kind: 'draft', promoted: false,
//                video: <repo-relative path>, variants: { alpha: null, upscaled: [], qc: [] },
//                meta: {} }]
// }
```

Consequences on the page (all automatic, no renderer changes):
- The **Characters** and **Episodes** facets don't render (no values).
- No `final` badge / `final: vNNN` label (nothing is promoted).
- All versions show side by side; select/hide/show-only-selected/download all work as usual.
- Asset vendoring copies each referenced file into `web/<slug>/assets/…` exactly as for the
  structured scanner.

## Components

### `src/review-scan.js` — `scanFolder(projectRoot, dir)`
New pure scanner alongside `scanShots`/`scanImages`. Lists `dir` (non-recursive), parses each
video filename per the rules above, groups into the shot model, and makes `video` paths
repo-relative to `projectRoot` (via the existing `relTo`) so vendoring works unchanged. Reuses
the existing `listFiles` helper.

### `src/review-page.js` — `buildReviewPage` gains a `folder` option
```
opts.folder  // absolute dir path; when set, source is the folder, not the shots/ tree
```
Logic change, minimal:
- If `folder` is set and `type !== 'shots'` → throw `review: --folder is only valid with 'shots'`.
- `raw = folder ? await scanFolder(root, folder) : (type === 'images' ? scanImages(root) : scanShots(root, { episodes: filters.episodes }))`.
- If `folder` is set and the scan yields no shots → throw `review: no video files in <folder>`.
- Everything after (`applyShotFilters`, `defaultShotSelection`, asset wipe + vendor, render,
  write `index.html`/`review.json`) is unchanged. `warnUnknownFilters` still runs; with a
  folder source the character/episode sets are empty, so `--characters`/`--episode` values
  warn "no … matching" (harmless).

### `bin/pipeline.js` / `parseReviewArgs`
- `parseReviewArgs` captures `f.folder` and returns it on `opts` (not inside `filters` — it's a
  source, not a filter).
- The `review` usage string gains `[--folder <dir>]`.
- The CLI resolves the folder to an absolute path (`path.resolve(cwd, opts.folder)`) before
  calling `buildReviewPage`, matching how other input paths are cwd-relative.

## Error handling
- `--folder` with `review images` → clear error (see above).
- Folder missing / not a directory → the scan surfaces the fs error (ENOENT) with the path.
- Folder present but no video files → `review: no video files in <folder>`.
- A filename that is only `-v003.mp4` (empty stem before the suffix) → shot id would be empty;
  treat an empty shot id by falling back to the full stem (`-v003`) as the id so nothing is
  silently dropped.

## Testing (`node --test`)
- `scanFolder`: temp folder containing `ai-1-v003.mp4`, `ai-1-v006.mp4`, `art-2-v015.mp4`,
  `intro.mp4` (no suffix), and `notes.txt` → asserts: two/three shots grouped, `ai-1` has
  `[v003, v006]` in order, `intro` → single `v001`, `notes.txt` skipped, `video` paths are
  repo-relative and end with the right filename, model shape (`episode:null`, `characters:[]`,
  `promotedVersion:null`).
- `buildReviewPage({ type:'shots', folder })`: seed a temp folder with two files → assert
  `index.html` + `review.json` written, files vendored under `web/<slug>/assets/…`, selection
  includes all versions; and that `folder` + `type:'images'` rejects, and an empty/no-video
  folder rejects with the folder message.
- `parseReviewArgs`: `--folder <dir>` captured on `opts.folder`.

## Out of scope (YAGNI)
- Recursing into subfolders (the source is a flat set by definition).
- Images-from-folder (this is a shots/video feature; sheets keep their structured scanner).
- Inferring characters/episodes/promotion from filenames or a sidecar — the folder is
  intentionally metadata-free; the page is a plain shots × versions grid.
