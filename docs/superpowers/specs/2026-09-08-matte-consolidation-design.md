# Matte pipeline consolidation — compositional core + refinement — design

**Date:** 2026-09-08
**Status:** draft for review, pre-implementation
**Ships as:** three scoped, confirmed PRs (per project convention for pipeline changes)
**Depends on:** the keylight sub-engine (PR #84 / `--key-engine keylight`)

## Goal

Refactor the matte sidecars so that **producing a matte** and **refining its edges**
are separable, composable stages. Today the trimap method fuses a colour key with a
closed-form edge solve inside one function, keylight is a pure per-pixel keyer with
no refinement, and the ML method duplicates all the streaming I/O in a third file.

Target composition:

```
alpha_core = basic_matte(frame, ...)        # keylight | chroma-distance | ml-segmenter
alpha      = refine_edges(frame, alpha_core) # optional: trimap-from-alpha + closed-form
F          = despill(frame, alpha, ...)      # spill suppression
encode(F, alpha)                             # shared streaming I/O + report + guards
```

The immediate payoff is concrete: **`keylight` core + closed-form `refine` gives
keylight's balance/tinge control AND trimap's crisp edges** — the combination that
the monster-2 blue-plate test needed (keylight cleaned the light-region tinge but
left a soft edge halo; trimap had crisp edges but a teeth colour cast). Neither
current method delivers both; the composition does.

## Part 1 — What is shared vs duplicated today

Three sidecars: `python/matte.py` (ml/BiRefNet) and `python/plate_matte.py`
(holding **both** the `trimap` and `keylight` engines).

| Concern | ml `matte.py` | trimap `plate_matte.matte()` | keylight `plate_matte.keylight_alpha()` |
| --- | --- | --- | --- |
| `probe` / `encoder_args` / `log` / `_remove` | duplicated | shared in file | shared in file |
| decode→process→encode→report loop | own `main()` | shared `main()` | shared `main()` |
| degenerate reject / finalize | yes | yes (added w/ keylight) | yes |
| key detection | — | `detect_key` | `detect_key` |
| **alpha core** | `alpha_for` (ONNX) | **fused into `matte()`** | `keylight_alpha` |
| **edge refinement** | none | **closed-form + trimap, fused into `matte()`** | none (Gaussian feather only) |
| despill | inverse-compositing (`estimate_plate` + `despill`) | dominant-channel clamp | dominant-channel clamp |

Observations that drive the design:

1. **keylight and trimap already share ~half of `plate_matte.py`** (I/O, key detect,
   main loop, masks, report). The real duplication is `matte.py` re-implementing
   `probe`/`encoder_args`/loop, and **two despill philosophies** living apart.
2. **`matte()` fuses two separable stages.** It builds a trimap from plate-colour
   priors (`d_key`, `keyn`, dark-ink boundary, negative-space `reach`) and then runs
   `estimate_alpha_cf` + `estimate_foreground_ml`. The solver half is generic; only
   the trimap *construction* is plate-specific.

## Part 2 — The refactor

### 2.1 A shared streaming-I/O module (`python/matte_io.py`)

Extract the machinery all three sidecars need and today duplicate:

- `probe`, `encoder_args` (prores4444 / webm / png), `log`, `_remove`, `finalize`,
  `reject`.
- A `stream(input, output, format, process, *, report_guard)` driver that owns the
  ffmpeg decode→`process(frame)`→encode→report loop, the temp-then-replace write,
  and the degenerate-coverage / spill guards. `process` is a per-frame callable
  returning `(rgb, alpha)`.

No behaviour change — this is a lift-and-share. Both existing sidecars' `main()`
collapse to: parse args → build a `process` closure → `stream(...)`.

### 2.2 Split the trimap method into core + refinement

Refactor `matte()` into two functions:

- `chroma_alpha(frame, key, spread, ...) -> alpha` — the colour-distance core matte
  (the `d_key`/`keyn` reasoning), no solve. A basic matte, peer to `keylight_alpha`.
- `refine_edges(frame, alpha, *, priors=None) -> (alpha, F)` — **method-agnostic**
  edge refinement. Derives its trimap from the *input alpha*
  (`FG = erode(alpha > hi)`, `BG = erode(alpha < lo)`, unknown = the band between),
  then `estimate_alpha_cf` + `estimate_foreground_ml`. The current plate-specific
  priors (dark-ink boundary, negative-space `reach`) become an **optional** `priors`
  input that sharpens cartoon edges but is not required for the solve.

Correctness gate: `chroma_alpha` → `refine_edges(priors=plate_priors)` must be
**byte-identical** to today's `matte()` on a golden set of frames. This is the
riskiest step; it ships behind a golden-output test before anything else changes.

### 2.3 Unify despill as a selectable stage

Two philosophies exist and both are legitimate:

- **dominant-channel clamp** (keylight/trimap): needs only the key; `D' = min(D, other)`.
- **inverse-compositing** (ml): `F = (C - (1-a)B)/a`; needs a per-frame plate estimate,
  exact identity at `a==1`.

Keep both as named despill strategies selectable per run rather than hard-wired per
method. Default per method stays as it is today, so no output changes unless asked.

### 2.4 Surface: matte × refine as independent choices

Generalise the CLI so refinement composes with any core:

```
pipeline shot matte --id <shot> --method plate \
  --matte <keylight|chroma|...> \
  --refine <none|closed-form> \
  [keylight/chroma options as today] [--refine-* knobs]
```

- `--key-engine` is **retained as a deprecated alias**: `--key-engine keylight` ⇒
  `--matte keylight --refine none`; `--key-engine trimap` ⇒
  `--matte chroma --refine closed-form` (with plate priors). Existing commands and
  the shot-author skill keep working unchanged.
- `--refine closed-form` is the new capability: usable with `--matte keylight`,
  giving the keylight core trimap-quality edges.

## Part 3 — Phasing (one PR each)

1. **PR1 — shared I/O.** Extract `matte_io.py`; route ml, trimap, keylight through
   it. Pure refactor, golden-output tests prove all three unchanged. Immediate dedup,
   low risk.
2. **PR2 — split trimap.** `matte()` → `chroma_alpha` + `refine_edges(frame, alpha)`;
   golden test proves trimap-native output byte-identical.
3. **PR3 — compose.** Add `--matte` / `--refine` (with `--key-engine` alias) and wire
   `refine_edges` so it can run on the keylight core. Ships the keylight+refine tier
   and re-tests the monster-2 case.

## Part 4 — Costs and non-goals

- **Performance is opt-in.** Closed-form is ~0.85 s/frame vs keylight's ~0.05.
  `keylight + refine closed-form` therefore costs like trimap — a deliberate quality
  tier the user selects, not a default.
- **ML alpha/despill stays put initially.** `matte.py` joins the shared I/O in PR1,
  but folding its ONNX core and inverse-compositing despill into the composition is a
  larger lift with its own model/normalisation subtleties — out of scope here, worth
  its own spike later.
- **No new output formats or default behaviour changes.** Every current command must
  produce byte-identical results until the user opts into a new `--matte`/`--refine`
  combination.

## Part 5 — Open questions for review

1. **Trimap-from-alpha thresholds.** The FG/BG erosion radii and hi/lo cutoffs that
   turn an arbitrary core alpha into a trimap need defaults that work for both a hard
   keylight matte and a soft one. Tune on the monster corpus during PR2.
2. **Do the plate priors survive as a `--refine` option** (e.g.
   `--refine closed-form --refine-ink-priors`) or stay implicit only under the
   `trimap` alias? Leaning: implicit under the alias, opt-in elsewhere.
3. **Despill-strategy default for `keylight + refine`.** Dominant-channel clamp is
   consistent with the keylight core; confirm we don't switch it to inverse-compositing
   just because a solve now runs.
