# Shot Review Pages — Design

**Date:** 2026-08-23
**Status:** Draft for review (authored autonomously; needs user approval before implementation)

## Problem

There is no fast way to look at generated shot results and compare versions. Artifacts
sit in `shots/<shotId>/drafts/vNNN/output.mp4`, `final/`, upscales, and mattes, described
by per-draft `output.json`. Reviewing means digging through folders. We want on-demand
**review webpages** that are:

- **Customizable** — pick which shots and characters to show, and which versions to view
  side-by-side.
- **Incrementally updatable** — regenerate or extend a page as new drafts land, without
  losing curation.

## Goals / Non-goals

**Goals**
- A `pipeline review` command that generates a self-contained static review page under
  `web/<slug>/`, following the existing `web/` convention (dark-theme tokens, asset
  subfolder, picked up by `scripts/update-web-index.js`).
- Filter by shot and by character; choose versions per shot; render chosen versions
  **side-by-side** for comparison.
- Re-run to **update** an existing page: fold in newly-added drafts/versions while
  preserving human curation (which shots/versions were selected, notes).
- Client-side interactivity (toggle shots/characters/versions) so one generated page stays
  useful as the reviewer explores — no regeneration needed to change the view.

**Non-goals (YAGNI)**
- No server, no build step, no framework. Static HTML + vanilla JS only (matches `web/`).
- No auth, hosting, or sharing infrastructure — these are local files opened in a browser.
- No editing/approval actions written back to shots from the page (view-only). Promotion
  stays a CLI concern (`pipeline shot promote`).

## Architecture

Three units, each independently testable:

### 1. `src/review-model.js` — scan → normalized model (pure, no HTML)
Walks a project root and produces a plain-data **review model**:

```
{
  generatedAt, root,
  shots: [{
    shotId, description, mode, duration,
    characters: [ ...element names from shot.yaml ],
    versions: [{
      version: 'v001' | 'final',
      kind: 'draft' | 'final',
      video,            // repo-relative path to the primary clip
      variants: {       // optional extra artifacts for the same version
        alpha, upscaled: ['upscaled-1080p.mp4', ...], qc: [...]
      },
      meta: { model, prompt, resolution, aspectRatio, mode, ts }  // from output.json
    }]
  }]
}
```

Sources, in priority order: `shot.yaml` (identity, characters), each
`drafts/vNNN/output.json` (rich meta) with the sibling `output.mp4` as the clip, `final/`
for promoted clips, and `shotVersionDir` siblings (`alpha.*`, `upscaled-*.mp4`, `qc/`) as
variants. Missing `output.json` degrades gracefully — the clip still lists with empty meta.
Reuses `src/paths.js` helpers (`shotDir`, `shotDraftsDir`, `shotFinalDir`, `formatVersion`)
so path logic is not duplicated.

### 2. `src/review-page.js` — model + selection → page bundle
Given a review model, a **selection**, and a slug, it:
- Copies the selected version artifacts into `web/<slug>/clips/<shotId>/<version>/…` (mirrors
  how `matte-best-vs-fast` vendors its clips so the page is self-contained and versionable).
- Emits `web/<slug>/index.html`: a self-contained page embedding the **filtered model as
  inline JSON** plus vanilla JS for the interactive controls.
- Emits `web/<slug>/review.json`: the selection + model snapshot — the machine-readable
  state that makes updates non-destructive (see Update flow).

**Selection** = which shots, which characters, which versions per shot, and layout
(side-by-side columns vs. stacked). Defaults when unspecified: all shots, all characters,
`final` if present else latest draft, plus the latest draft for comparison.

### 3. `bin/pipeline.js` — `pipeline review` command (thin CLI glue)
Follows the existing `cmd sub` + `parseFlags` + `projectRoot(f.root)` pattern.

```
pipeline review --slug <name>                     # create/update page in web/<slug>/
  [--shots a,b,c] [--characters x,y]              # filters (default: all)
  [--versions <shotId>=v001,v003 ...]             # per-shot version pick (repeatable)
  [--layout side-by-side|stacked]                 # default side-by-side
  [--update]                                       # merge new drafts into existing page
  [--title "..."] [--root <dir>]
```

Create: build model → apply selection → write bundle. Update (`--update` or slug exists):
read `web/<slug>/review.json`, re-scan the model, add versions that appeared since, keep the
existing selection/notes, rewrite the page. Explicit flags on an update override stored
selection for the shots they name.

## Data flow

```
shots/ (+ shot.yaml, output.json)        web/<slug>/review.json (prior state, on update)
              \                          /
               → review-model.js → model → apply selection (flags ⊕ stored) →
               review-page.js → copy clips + write index.html + review.json
                                  → (optional) scripts/update-web-index.js refresh
```

## The page itself (client-side)

- Left rail: checkboxes for **shots** and **characters** (character filter hides shots whose
  `characters` don't intersect the selection). A per-shot **version multi-select**.
- Main area: one row per selected shot; within a row, one `<video>` column per selected
  version → the **side-by-side** comparison. Each column labels version + key meta (model,
  resolution, ts) and links to variants (alpha/upscaled/qc) when present.
- Toolbar: layout toggle (side-by-side ↔ stacked), synchronized play/pause/scrub across a
  row's videos (nice-to-have, behind a checkbox), and a "final only / drafts only" quick
  filter.
- All driven by the inline JSON model; **no network calls**. Reflects the CSP-friendly,
  self-contained style already used in `web/`.

## Error handling
- Unknown shot/character in a filter → warn to stderr, skip, continue (don't abort the page).
- Missing clip for a requested version → render the column as a labeled "missing artifact"
  placeholder rather than a broken `<video>`.
- Slug collision without `--update` → refuse and tell the user to pass `--update` or a new
  slug (never silently overwrite a curated page).
- `shots/` absent/empty → exit non-zero with a clear message.

## Testing (`node --test`, matching repo convention)
- `review-model.js`: fixture `shots/` tree (draft-only, final+drafts, missing output.json,
  variants present) → asserts normalized model shape and graceful degradation.
- `review-page.js`: given a model + selection, asserts clips copied to expected paths,
  `index.html` embeds the filtered model, `review.json` round-trips.
- Update flow: seed a `review.json`, add a new draft to the fixture, run update → new version
  appears, prior selection/notes preserved, no duplicate clip copies.
- CLI: `pipeline review` arg parsing (filters, `--versions`, collision refusal).

## Open decisions (flagged for reviewer)
1. **Vendor clips vs. reference in place.** Copying into `web/<slug>/clips/` makes the page
   portable and matches `matte-best-vs-fast`, at the cost of disk/repo size (videos). Alt:
   relative-link into `shots/` (smaller, but page breaks if moved and `shots/` is gitignored
   so the page isn't shareable via the repo). **Recommendation: vendor (copy).**
2. **Should `web/<slug>/clips/` be gitignored?** Vendored review clips could be large. Option
   A: version them (shareable via repo, like existing `web/` clips). Option B: gitignore
   `web/*/clips/` and treat pages as local-only. **Recommendation: A for small curated
   comparisons, revisit if size becomes a problem.**
3. **Auto-refresh the `web/README.md` index** at the end of `pipeline review`, or leave it to
   `npm run web:index`? **Recommendation: auto-run the existing generator so new pages are
   indexed immediately.**

## Assumptions (autonomous — correct me on review)
- Reviewers open the HTML file directly (`file://`) or via any static server; no build.
- "Versions" = draft `vNNN` folders plus `final`. Element/character **sheets** are out of
  scope for v1 (the ask centers on shots); a later page type could cover element sheets.
- Character list per shot comes from `shot.yaml` elements; if empty, the shot shows under
  "no character" and is unaffected by the character filter.
```
