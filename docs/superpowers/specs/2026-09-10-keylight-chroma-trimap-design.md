# Keylight core with the chroma ink-aware trimap — design

**Date:** 2026-09-10
**Status:** approved, pre-implementation (Part 5 resolved 2026-09-10; prototype-verified)
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

`--refine-trimap plate` needs a real plate `spread` for `chroma_alpha`. It is
auto-detected via `detect_key` (which returns `(key, spread)`) even when
`--screen-colour` pins the colour — the override replaces only the *colour*, not
the spread. A `--plate-spread <n>` escape hatch lets the user pin the spread by
hand when auto-detection misjudges it (resolves Q1).

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

## Part 5 — Resolved (2026-09-10)

1. **Spread when the screen colour is pinned — RESOLVED.** `--refine-trimap plate`
   still runs `detect_key` for the `spread`; `--screen-colour` overrides only the
   colour. A `--plate-spread <n>` escape hatch lets the user pin it by hand. See §3.
2. **Despill consistency — RESOLVED (prototype-measured).** The solve runs on
   keylight's `F0`; the trimap is pure geometry, so there is one consistent image
   and nothing to disagree on colour-wise. In the actual unknown/edge band on
   monster-2 frame 0, keylight `F0` vs chroma's despilled rgb: mean |Δ| = **0.005**,
   p95 = **0.015** (both dominant-channel despills). No edge inconsistency.
3. **Naming — RESOLVED.** Keep the separate `--refine-trimap alpha|plate` knob:
   `--refine` says *whether* to solve, `--refine-trimap` says *how* to seed it.
4. **fg_lock strength — RESOLVED (prototype-measured).** chroma's `fg_lock` is a
   deep-interior core (eroded r=17, ~19% of frame). On monster-2 frame 0, **0** of
   its pixels are ones keylight calls background, and keylight's mean alpha there is
   **0.994** — the cores agree. The lock sits far from the edges, so it cannot
   cause the rim; no over-lock observed.

**Prototype result:** keylight core + chroma trimap gave edge ring **51,539 px**
≈ chroma+closed-form's **51,588** (rim gone) while keeping keylight's cleaner
whites — the intended best-of-both, confirmed before implementation.
