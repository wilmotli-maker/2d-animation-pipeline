# Keylight core with the chroma ink-aware trimap — design

**Date:** 2026-09-10
**Status:** draft for review, pre-implementation
**Ships as:** one confirmed PR (small; per project convention for pipeline changes)
**Depends on:** the matte consolidation (PRs #86, #87, #88 — `--matte`/`--refine`, `chroma_alpha`, `refine_edges`, `trimap_from_alpha`)

## Goal

Let the **keylight** matte core keep its colour/tinge handling while borrowing the
**chroma** core's ink-aware trimap for the closed-form edge solve — the best of
both on designed-plate cartoon footage. On the monster-2 blue-plate test,
`keylight + closed-form` cleaned the light-region tinge but left a thin pale rim on
the dark ink outlines; `chroma + closed-form` had crisp, rim-free edges but the
teeth colour cast. This combines keylight's foreground colour with chroma's edge
placement.

## Part 1 — Why the rim exists (measured)

`refine_edges` on a keylight core derives its trimap with `trimap_from_alpha`,
which only knows the alpha: eroded core = definite FG, eroded background =
definite BG, the band between = unknown. Even tightened (PR3: erode 3, hi 0.7 /
lo 0.3) that band is **wider and less well placed** than chroma's, because it has
no idea where the dark outline is. Inside a loose unknown band the closed-form
solve ramps alpha gradually and lets `estimate_foreground_ml` borrow light
interior colour outward — a pale rim on dark outlines over green.

`chroma_alpha` avoids this by construction: it seeds the **dark ink outline as
definite foreground**, carves plate-hued negative space, and uses a
distance-transform to keep the unknown region hugging the true silhouette. On
frame 0 of monster-2 its unknown band was measured at 45,653 px vs the generic
trimap's 147,704 px (pre-tightening) — and, more importantly, *placed* on the
real edge with the ink locked opaque.

The two cores are already separable (PR2): `chroma_alpha` returns
`{rgb, trimap, fg_lock}`, and `refine_edges` accepts either a `trimap` or an
`alpha`. This spec just wires keylight's alpha/colour to chroma's trimap/fg_lock.

## Part 2 — The composition

Per frame, for `--matte keylight --refine closed-form --refine-trimap plate`:

```
a0, F0  = keylight_alpha(frame, key, ...)            # keylight colour + despill
core    = chroma_alpha(frame, key, spread, despill=…) # ink-aware trimap + fg_lock
alpha,F = refine_edges(F0_as_rgb_float64,             # solve on KEYLIGHT's colour
                       trimap=core['trimap'],
                       fg_lock=core['fg_lock'], feath=feather)
```

Key points:

- **Foreground colour comes from keylight** (`rgb = F0`), so the clean whites/teeth
  that motivated keylight survive; only the *trimap and fg_lock* come from chroma.
- **`chroma_alpha` runs purely on the plate key** (not on keylight's alpha), so the
  two are independent and compose cleanly. Its own `rgb` output is discarded here.
- The existing `--refine-trimap alpha` path (generic `trimap_from_alpha`) stays the
  default, unchanged.

## Part 3 — Surface

Add one knob to the plate composition (PR3's `--matte` / `--refine`):

```
pipeline shot matte --method plate --matte keylight --refine closed-form \
  --refine-trimap <alpha|plate>   [keylight opts] [--feather px]
```

- `--refine-trimap alpha` (default) — `trimap_from_alpha`, today's keylight+refine.
- `--refine-trimap plate` — chroma ink-aware trimap + fg_lock (this spec).
- Valid **only** with `--matte keylight --refine closed-form`. It is meaningless
  with `--refine none` (nothing solves) and redundant with `--matte chroma` (whose
  trimap is already the plate one); the CLI refuses it there, matching how the
  keylight-only flags are gated today.
- No alias change. `--key-engine` keeps mapping to `keylight+none` / `chroma+
  closed-form`; neither uses this knob.

Report gains `refineTrimap` alongside `matte`/`refine`.

## Part 4 — Cost and defaults

- **Premium tier, opt-in.** `plate` runs keylight_alpha **and** chroma_alpha **and**
  the closed-form solve per frame — the slowest plate combination. Default stays
  `alpha`, so nothing gets slower unless asked.
- **No byte-identity risk to existing paths.** trimap (chroma+closed-form),
  keylight+none, and keylight+closed-form(alpha) are all untouched; the goldens
  (`39ae3866`, `fe4dd117`, `ab9a8064`) must still match.
- Validate on monster-2 against the `blue-matte-final` baseline: `plate` should
  keep keylight's whites while dropping the outline rim toward chroma+closed-form.

## Part 5 — Open questions for review

1. **Spread when the screen colour is pinned.** `chroma_alpha` needs `spread`
   (drives its thresholds). With `--screen-colour #hex`, keylight sets `spread=0`,
   which would degenerate chroma's trimap. Options: force auto key-detection to run
   for `--refine-trimap plate` (so `spread` is real) even when the colour is pinned,
   or estimate `spread` separately. Leaning: still run `detect_key` for `spread` and
   only override the *colour*.
2. **Despill consistency.** The solve runs on keylight's `F0` (balance-weighted
   dominant-channel despill) while the trimap came from chroma's own despilled
   analysis. Both are dominant-channel despills, so they should agree; confirm no
   edge inconsistency where chroma expected a different foreground colour.
3. **Naming.** `--refine-trimap alpha|plate` vs folding it into `--refine`
   (e.g. `--refine closed-form-plate`). The separate knob keeps `--refine` about
   *whether* to solve and this about *how* to seed it; confirm the split reads well.
4. **fg_lock strength.** chroma's `fg_lock` was tuned for the chroma alpha; verify it
   doesn't over-lock when paired with keylight's (often cleaner) core alpha.
