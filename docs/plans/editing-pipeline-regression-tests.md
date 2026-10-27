# Plan: regression test suite for the editing pipeline

**Repo:** `~/Projects/2d-animation-pipeline`
**Status:** proposed — groundtruth-corpus bring-up, then scripted comparisons
**Origin:** the textpose-editing experiment already has 13 edited shots (`web/keyframe-textpose/*`). This plan turns that into a reusable groundtruth corpus plus scripts so the keyframe → splice → harmonize path can be regression-tested as the pipeline changes.

---

## 1. Goal

Lock down known-good outputs for each stage of the editing pipeline and script comparisons against them, so a change anywhere in `edit-ui` / splice / harmonize can be checked for regressions instead of re-reviewed from scratch every time.

The pipeline under test runs:

```
gt-prompts  →  keyframes  →  spliced result  →  harmonized result
```

Final human-approval comparisons stay manual (visual judgement of style/gesture fidelity is not yet automatable), but **mechanical defects — discontinuities at splice boundaries — are flagged automatically** for spliced and harmonized results.

---

## 2. Build the groundtruth corpus

Produce and commit (or store under a tracked artifact path) these five sets. Each is keyed by shot id so the scripts can line them up.

1. **Shots** — start with 8 shots chosen from the textpose-editing experiment for their slightly longer durations (5–10s): `ai-2-v006`, `ai-3-v002`, `ai-7-v002`, `art-1-v010`, `art-4-v002`, `art-8-v002`, `monster-3-v003`, `monster-4-v002`. Source originals come from `Seedance Animation/ArtAI/episodes/2/shots/candidates/`. Expand later if coverage gaps show up.
2. **`gt-prompts`** — groundtruth text-pose prompts, one per shot. Saved and frozen.
3. **`gt-keyposes`** — groundtruth keyframes, one per shot, human-approved.
4. **`gt-spliced`** — groundtruth spliced results with human-approved edits.
5. **`gt-harmonized`** — groundtruth harmonized results, human-approved.

Each `gt-*` set is the reference output for the stage that produces it. Regenerated outputs are compared against the matching set.

---

## 3. Regression tests

Each test regenerates one stage from frozen upstream groundtruth and compares against the groundtruth for that stage.

| # | Test | Input | Compare against |
|---|------|-------|-----------------|
| 1 | Keyframe generation | `gt-prompts` | `gt-keyposes` |
| 2 | Splice (from prompts) | `gt-prompts` | `gt-spliced` |
| 3 | Splice (from keyposes) | `gt-keyposes` | `gt-spliced` |
| 4 | Harmonize (from spliced) | `gt-spliced` | `gt-harmonized` |
| 5 | End-to-end (from prompts) | `gt-prompts` | `gt-harmonized` |
| 6 | End-to-end (from keyposes) | `gt-keyposes` | `gt-harmonized` |

- Tests 2 and 3 are the "two sets of spliced results" — one driven from prompts, one from keyposes — both against `gt-spliced`.
- Tests 5 and 6 are the "two sets of harmonized results" end-to-end — from prompts and from keyposes — both against `gt-harmonized`.

---

## 4. Comparison method

**Manual (human review):** overall fidelity to the groundtruth — pose correctness, style match, gesture. Use `pipeline review shots/images` to build every review/comparison page; do not hand-roll HTML.

**Automatic (flagged in the script):** for any spliced or harmonized result, detect discontinuities at splice boundaries — a visible color/grade step, geometry jump, or temporal hitch where the generated clip meets the source. These are hard failures the script surfaces without a human.

---

## 5. Scripts

- One runner per test (or one runner parameterized by stage) that: regenerates the stage, writes outputs to a run dir, runs the auto seam-discontinuity check, and emits a `pipeline review` comparison page pairing each regenerated output with its groundtruth.
- Auto check reports pass/flag per shot per boundary; the review page is for the manual pass.

---

## 6. Storing the groundtruth corpus

The corpus lives **outside the repo tree**, on internal disk at `~/Projects/animation-test-corpus/` (keeping 5 GB+ of eval video out of the repo root, its worktrees, and editor indexing). Layout:

```
~/Projects/animation-test-corpus/
  shots/        # pipeline inputs: the 8 source clips
  style-locks/  # per-character style locks (ai/art/monster) the edit-prompt gen reads
  gt/
    prompts/    keyposes/    spliced/    harmonized/
```

`style-locks/` holds the three per-character locks the edit-prompt generation composes from (`buildTrimPrompt` reads each character's `styleLock`): `art.yaml` (from `art`), `ai.yaml` (from `AI_ALT2`), `monster.yaml` (from `MonsterA`), sourced from `ArtAI/elements/characters/`. Shots key to a lock by id prefix (`ai-*`, `art-*`, `monster-*`).

The test runner resolves this via a configurable base path (env var `GT_CORPUS_DIR`, defaulting to the location above), so the paths below hold wherever the bytes sit — and promoting to LFS/a bucket later is just changing where they're fetched from.

The corpus has two very different parts, and they want different homes:

- **`gt-prompts`** is text and small. Commit it directly in-repo (e.g. `evaluation/video-editing-eval/keyframe-edit/gt/prompts/`, versioned). This is the most important reproducibility anchor — the prompts must be identical everywhere the suite runs, and git diffs make prompt drift obvious. Cheap to version, high value.
- **`gt-keyposes` / `gt-spliced` / `gt-harmonized`** are binary clips/images. The repo's standing convention (`.gitignore`: `evaluation/`, `web/*/assets/`) is that binaries are **never** committed and there is no Git LFS; only text metadata is versioned.

Because these gt binaries are a *durable baseline* (unlike the gitignored `evaluation/` scratch), the key requirement is that every machine running the suite sees byte-identical references. Options, weakest to strongest:

1. **Local + gitignored, manifest in git (start here).** Keep the gt binaries under a gitignored `gt/` dir; commit a `manifest.json` listing each shot id, its prompt, stage, filename, and **sha256**. The runner verifies hashes before comparing, so drift or a missing file fails loudly even though the bytes live locally. Pro: zero new infra, matches existing convention, ships now. Con: the binaries themselves aren't shared/reproducible across machines — fine while this is single-operator.
2. **Git LFS.** Track the gt binaries in LFS so they version with the repo. Pro: reproducible, lives with the code. Con: new infra + quota/cost, and reverses the repo's deliberate no-binaries stance. Reasonable if the corpus stays small (13 shots × a few stages ≈ tens of MB).
3. **External object store (S3 / R2 / GCS) + manifest in git.** Commit the manifest (ids, prompts, URLs, sha256); a `gt sync` script pulls/pushes clips. Pro: durable, shareable, scales, keeps git clean. Con: most setup — a bucket + credentials, which the repo has none of today.

**Recommendation:** commit `gt-prompts` as text now; store the gt binaries via **option 1 (local + sha256 manifest)** to stand the suite up without new infra, and keep the manifest the single source of truth so promoting to LFS or a bucket later is just changing where the bytes are fetched from — no test changes.

## Open questions

- Exact seam-discontinuity metric/thresholds — reuse the existing seam-analysis work (part-aware seam / colour-conform findings) rather than inventing new thresholds.
- When (and whether) to promote the gt binaries from local+manifest to Git LFS or an object store — decide once the corpus stabilizes and if a second operator/machine needs it.
