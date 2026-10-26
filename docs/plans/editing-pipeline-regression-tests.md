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

1. **Shots** — 15–20 shots for edit testing. Start from the 13 in the textpose-editing experiment; add 2–7 more to cover the spread of characters/edit types.
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

## Open questions

- Where the `gt-*` corpus lives (in-repo vs. tracked artifact store) given clip sizes.
- Exact seam-discontinuity metric/thresholds — reuse the existing seam-analysis work (part-aware seam / colour-conform findings) rather than inventing new thresholds.
- Which 2–7 shots to add to reach 15–20 and what edit types they should cover.
