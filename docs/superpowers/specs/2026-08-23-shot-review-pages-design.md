# Review Pages — Design

**Date:** 2026-08-23
**Status:** Draft for review (authored autonomously; needs user approval before implementation)

## Problem

There is no fast way to look at generated results and compare versions. Shot videos sit in
`shots/<id>/drafts/vNNN/output.mp4` + `final/`; character imagery sits in
`elements/<type>/<name>/sheets/<sheetType>/<slug>/`. Reviewing means digging through folders.
We want **on-demand review webpages** that are:

- **Customizable** — filter down to the exact shots or images you want, and view chosen
  **versions side-by-side**.
- **Incrementally updatable** — regenerate/extend a page as new results land, without losing
  curation.

## Two page types, one command

Shots (videos) and images (character sheets/poses) are different content and get **separate
pages**. One command, two subcommands:

- `pipeline review shots  [filters] --slug <name>`
- `pipeline review images [filters] --slug <name>`

**Characters are a filter facet, not displayed content** on the shot page — ticking a
character narrows the shot list to shots that feature it. Character imagery is reviewed on
its own image page. This resolves the earlier shots-vs-characters muddle.

## Filters (combinable — result is the intersection / AND)

**Shots** (`pipeline review shots`):
- `--match <regex>` — keep shots whose id matches (e.g. `^art-talk-`).
- `--exclude <regex>` — drop shots whose id matches (applied after `--match`, e.g. `candidates|assembled`).
- `--characters a,b` — shots whose `shot.yaml` elements include **any** of these.
- `--episode <N>[,<M>]` — restrict to episode root(s). Episodes are `episodes/<N>/` folders
  (see Project layout). Omitted → all episodes (or the flat top-level `shots/`).

**Images** (`pipeline review images`):
- `--characters a,b` — element names (any-of).
- `--sheets turnaround,pose,cycles` — sheet types (any-of).
- `--match <regex>` — keep sheets whose slug matches.
- `--exclude <regex>` — drop sheets whose slug matches (a character with no sheets left is pruned).

Every filter is optional; passing several ANDs them. No filters → everything of that type.

## Project layout this must handle

The scanner is **structure-agnostic**: it locates shot directories wherever they live and
treats "episode" as an *optional derived grouping*, not a required level. Neither subcommand
assumes episodes exist. Supported shapes (both are first-class, not a primary + fallback):

- **Flat:** top-level `shots/<id>/…` and `elements/`, no episodes. This is the default the
  scanner expects when there is no `episodes/` folder. `--episode` is inert (and a warning if
  passed), the shot model carries `episode: null`, and the page omits the episode facet.
- **Episodic:** top-level `episodes/<N>/shots/<id>/…` and `episodes/<N>/voices/`, with
  **shared** top-level `elements/`. `--episode` selects among the `episodes/<N>` roots; the
  page shows the episode facet.

Discovery rule: collect shot dirs from `episodes/*/shots/*` **and** top-level `shots/*` (a
project may even have both during a migration — the model just unions them, tagging episode
where known). Elements are always the shared top-level `elements/` — never per-episode. If a
future project uses a different grouping folder, only the discovery glob and the `episode`
derivation change; the rest of the pipeline (model shape, filters, page) is unaffected.

## Architecture

Units, each independently testable:

### 1. `src/review-scan.js` — filesystem → normalized models (pure, no HTML)
Two builders over a project root:

**`scanShots(root, { episodes })` → shot model**
```
shots: [{
  shotId, episode,                 // episode = <N> or null (flat)
  description, mode, duration,
  characters: [ ...element names from shot.yaml ],
  versions: [{
    version: 'v001' | 'final', kind: 'draft' | 'final',
    video,                          // repo-relative primary clip
    variants: { alpha, upscaled: [...], qc: [...] },
    meta: { model, prompt, resolution, aspectRatio, mode, ts }   // from output.json
  }]
}]
```
Discovers episode roots, reads `shot.yaml` (identity, `characters` from elements), each
`drafts/vNNN/output.json` (rich meta) with sibling `output.mp4`, `final/` for promoted clips,
and `shotVersionDir` siblings (`alpha.*`, `upscaled-*.mp4`, `qc/`) as variants. Missing
`output.json` degrades gracefully (clip lists with empty meta). Reuses `src/paths.js`.

**`scanImages(root)` → image model**
```
characters: [{
  type, name,
  sheets: [{
    sheetType: 'turnaround'|'pose'|'cycles', slug,
    versions: [{ version, images: [...panel/image paths], upscaled: [...],
                 meta: { model, prompt, ts } }]   // from generations log / sheet metadata
  }]
}]
```
Walks `elements/<type>/<name>/sheets/<sheetType>/<slug>/`, using `src/paths.js`
(`sheetDir`, `sheetInstanceDir`) and the element `generations.jsonl` for meta.

Filters are applied **to the model** by a small `applyShotFilters` / `applyImageFilters`
(regex, character set, episode set, sheet set) so scanning and filtering stay separable and
unit-testable.

### 2. `src/review-page.js` — filtered model + selection → page bundle
Given a filtered model, a **selection** (which versions per item, layout), and a slug:
- **Vendors** selected artifacts into `web/<slug>/assets/…` (copy — page is self-contained,
  matches `matte-best-vs-fast`). `web/<slug>/assets/` is **gitignored** (see Decisions).
- Emits self-contained `web/<slug>/index.html`: embeds the filtered model as **inline JSON**
  + vanilla JS controls; dark-theme tokens like existing `web/` pages. No network calls.
- Emits `web/<slug>/review.json`: selection + model snapshot + the CLI filters used — the
  machine-readable state that makes updates non-destructive.

One HTML renderer with two layouts (shot page vs. image page) selected by model type.

### 3. `bin/pipeline.js` — `pipeline review <shots|images>` (thin glue)
Follows the existing `cmd sub` + `parseFlags` + `projectRoot(f.root)` pattern.

```
pipeline review shots  --slug <name> [--match <re>] [--exclude <re>] [--characters a,b]
                       [--episode N,M] [--versions <id>=v001,v003 ...]
                       [--layout side-by-side|stacked] [--update]
                       [--title ..] [--out <dir>] [--root <dir>]
pipeline review images --slug <name> [--match <re>] [--exclude <re>] [--characters a,b]
                       [--sheets turnaround,pose,cycles] [--update]
                       [--title ..] [--out <dir>] [--root <dir>]
```

**Output location.** Review pages are **project-specific output**, not pipeline tooling.
The bundle is written to `<outBase>/<slug>/`, where `outBase` defaults to a `web/` folder
off the project root (`--root`/env/cwd) and is **created if missing**. `--out <dir>` overrides
`outBase` (resolved absolute) so a project can keep review pages wherever it likes. The
`web/README.md` index refresh (below) only runs for the default `<root>/web` location — it
maintains the pipeline repo's own page table and is meaningless for a custom `--out` or a
user project without that README.
Create: scan → apply filters → apply selection → write bundle. Update (`--update` or slug
exists): read `review.json`, re-scan, add versions/sheets that appeared since, keep the prior
selection/notes, rewrite the page. Explicit flags override stored filters/selection for what
they name. On completion, **auto-run `scripts/update-web-index.js`** so `web/README.md`
indexes the new page.

## Data flow

```
episodes/*/shots/ + shot.yaml + output.json   \
elements/*/*/sheets/ + generations.jsonl       →  review-scan.js  →  model
web/<slug>/review.json (prior state, on update)/          |
                                                    apply filters ⊕ selection
                                                          ↓
                            review-page.js → vendor assets + index.html + review.json
                                            → scripts/update-web-index.js (refresh README)
```

## The page itself (client-side, self-contained)

- **Shot page:** left rail with in-page facets mirroring the CLI filters (character
  checkboxes, episode checkboxes, a text/regex box, final-only/drafts-only). Main area: one
  row per shot; within a row, one `<video>` column per selected version → **side-by-side**.
  Each column labels version + key meta (model, resolution, ts) and links variants
  (alpha/upscaled/qc). Optional synced play/scrub across a row (behind a checkbox).
- **Image page:** facets for character / sheet type / slug regex. Main area: one row per
  sheet instance; columns = selected versions/upscales → side-by-side stills with meta.
- Both driven purely by the inline JSON model — no network. CLI filters set the *corpus*
  baked into the page; in-page facets refine the *view* without regeneration.

## Error handling
- Unknown character/episode/sheet in a filter → warn to stderr, skip, continue.
- Requested version/sheet missing its artifact → labeled "missing artifact" placeholder, not
  a broken `<video>`/`<img>`.
- Slug collision without `--update` → refuse; tell the user to pass `--update` or a new slug.
- No matching content after filters → exit non-zero with a clear message (don't write an
  empty page).
- No `shots/`/`elements/` at all → clear non-zero error.

## Testing (`node --test`)
- `scanShots`: fixtures for flat and episodic layouts; draft-only, final+drafts, missing
  `output.json`, variants present → asserts model shape + graceful degradation + episode tag.
- `scanImages`: fixture `elements/` with multiple sheet types/slugs/versions → asserts model.
- `applyShotFilters` / `applyImageFilters`: regex, character any-of, episode set, sheet set,
  and combinations (intersection) → asserts the filtered set.
- `review-page.js`: model + selection → assets vendored to expected paths, `index.html`
  embeds filtered model, `review.json` round-trips; update adds new version, keeps selection,
  no duplicate copies.
- CLI: `pipeline review shots|images` arg parsing, collision refusal, empty-result exit.

## Decisions (confirmed with reviewer)
1. **Vendor (copy) selected artifacts** into `web/<slug>/assets/` — page is self-contained
   and portable. ✅
2. **Do NOT version vendored assets** — `web/*/assets/` is gitignored; pages are local-only,
   the repo stays small. ✅
3. **Auto-refresh `web/README.md`** via `scripts/update-web-index.js` at the end of the
   command. ✅

## Assumptions (autonomous — correct on review)
- Reviewers open the HTML directly (`file://`) or via any static server; no build step,
  framework, or server. Vanilla JS only, matching `web/`.
- "Versions" for shots = draft `vNNN` + `final`; for images = sheet generation versions
  (+ upscales). Sheet types are the known set `turnaround|pose|cycles`.
- A shot's characters come from `shot.yaml` elements; a shot with none is unaffected by the
  character filter (always shown unless excluded by another filter).
- Episode identity is the `episodes/<N>` folder name; flat projects have `episode = null` and
  ignore `--episode`.
```
