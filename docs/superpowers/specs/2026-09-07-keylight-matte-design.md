# Keylight-style keyer for the plate matte — design

**Date:** 2026-09-07
**Status:** approved, pre-implementation (Part 5 questions resolved 2026-09-08)
**Ships as:** a confirmed PR (per project convention for pipeline/default-skill changes)

## Goal

Reproduce the behaviour artists expect from After Effects' **Keylight** as an
option inside the pipeline's existing colour-keying matte
(`pipeline shot matte --method plate`). Keylight is the industry-default keyer
for footage shot on a solid backing screen; giving the pipeline the same control
surface (screen colour, balance, clip black/white, despill bias, holdout masks)
lets a user who knows Keylight get the same result without round-tripping through
After Effects — which is exactly the manual step `shot matte` exists to remove
(see `docs/plans/shot-matte-alpha.md`).

This is **not** a new top-level method. It is a second *keying core* under the
existing `plate` method, sharing that method's plate auto-detection, ffmpeg
streaming, despill accounting, output formats, and JSON report.

---

## Part 1 — What Keylight does and how it works

Keylight (The Foundry, shipped inside After Effects) is a **colour-difference
keyer with built-in spill suppression**, descended from the Computer Café /
Framestore algorithm. Its defining property: it derives the matte *and* the
despilled foreground from the **same** measurement of "how much screen colour is
in this pixel", rather than keying and despilling as two unrelated passes.

### 1.1 The core colour-difference measure

The artist picks a **Screen Colour** — one backing-screen sample. Call its
dominant channel `D` (green for a green screen) and the other two `o1 <= o2`.

For each source pixel, Keylight measures screen strength as the excess of the
dominant channel over a weighted blend of the other two:

```
other  = balance * o2 + (1 - balance) * o1
strength = D - other          # large on clean screen, ~0 or negative on FG
```

- **Screen Balance** is that `balance` weight. 0 compares the dominant channel to
  the *smaller* of the other two, 1 to the *larger*, 0.5 to their average.
  Green screens key well near 0.5; blue screens near 0.95. It is the single knob
  that most changes which foreground hues survive.

The measure is normalised by the screen's own strength (strength measured at the
Screen Colour itself), so clean screen → 1, clean foreground → 0. Alpha is then
`1 - normalized_strength`, clamped to [0,1].

### 1.2 Built-in despill (spill suppression)

The same decomposition removes screen contamination from the foreground: the
dominant channel is pulled down to the weighted blend of the other two,
`D' = min(D, other)`. Because the amount removed *is* the screen strength, the
despill and the matte can never disagree about how much screen a pixel held.
**Replace Colour / Replace Method** then decides what fills the removed energy
(source luma, a flat colour, or a soft neighbourhood colour) so despilled edges
don't read grey.

### 1.3 The controls that turn a raw key into a usable matte

- **Clip Black / Clip White** — a levels remap on the *matte*: alpha below Clip
  Black → 0, above Clip White → 1, linear between. This is the primary tightening
  control (crush noise in the "background", solidify a translucent core).
- **Screen Gain** — scales the raw strength before clipping.
- **Screen Pre-blur** — blurs the source *before* measuring, so film grain /
  compression noise doesn't speckle the key. It blurs the *key input only*, not
  the output edge.
- **Despill Bias / Alpha Bias** — a reference "neutral foreground" colour (often
  a flesh tone) that skews the measure so protected hues aren't read as screen
  and aren't over-despilled.
- **Screen Matte** group — `Clip Rollback` (recover crushed detail), `Screen
  Shrink/Grow`, `Screen Softness`, `Screen Despot Black/White` (kill isolated
  speckles).
- **Inside Mask / Outside Mask** — hand-painted holdout (force FG) and garbage
  (force BG) mattes that override the key. Essential for props the same colour as
  the screen, or screen colour worn by the subject.
- **Source Crops** — throw away frame edges (rigging, screen falloff).
- View modes — **Status / Screen Matte / Final Result** — let the artist inspect
  the intermediate matte, not just the composite.

### 1.4 What Keylight is *not*

It is a global, per-pixel colour operation. It has **no spatial/statistical model
of the edge** — no trimap, no closed-form matting, no connected-component
reasoning about enclosed negative space. Soft edges come purely from the source's
own partial-coverage pixels plus Screen Softness. That is the axis where the
pipeline's current `plate` core is actually *stronger*; see Part 2.

---

## Part 2 — Where this lands relative to the current `plate` matte

`python/plate_matte.py` already shares Keylight's DNA:

| Keylight concept | Current `plate` matte |
| --- | --- |
| Screen Colour pick | **auto-detected** per clip from the frame-edge band (`detect_key`) — no manual pick |
| Colour-difference strength | `d_key` (distance to key) + `keyn` (projection on key axis) |
| Built-in despill (`D'=min(D,other)`) | identical clamp: `bgr[kmax]=min(img[kmax],max(o1,o2))` — i.e. Keylight despill with **balance fixed at 1** |
| Clip Black / Clip White | *not exposed* — thresholds are derived internally from plate `spread` |
| Screen Balance | *not exposed* — effectively fixed |
| Edge softness | **closed-form matting over a trimap** — richer than Keylight's global key |
| Enclosed negative space (open mouth, gaps) | connected-component "reach" test — Keylight has no equivalent |
| Inside/Outside masks | *not supported* |

So the pipeline's core is **better at edges and enclosed holes** but **hides the
colour-difference controls** an artist reaches for when auto-detection or the
fixed balance gets a shot wrong. Keylight's value here is: (a) exposing screen
balance / clip black / clip white / bias, and (b) offering holdout + garbage
masks. The proposal keeps the closed-form edge quality and adds the Keylight
control surface on top.

---

## Part 3 — Proposed translation to the pipeline

### 3.1 Surface

Add a keying-core selector to the `plate` method (keeps Keylight "rolled into"
colour keying rather than a separate method):

```
pipeline shot matte --id <shotId> --method plate --key-engine <trimap|keylight> \
  [--screen-colour <#rrggbb|auto>] [--screen-balance <0..1>] \
  [--clip-black <0..1>] [--clip-white <0..1>] [--screen-gain <n>] \
  [--screen-pre-blur <px>] [--despill-bias <#rrggbb>] \
  [--inside-mask <file|dir>] [--outside-mask <file|dir>] \
  [--feather <px>] [--despill <true|false>] \
  [--version <n|final>] [--format prores4444|webm|png] [--root <dir>]
```

- `--key-engine` — `trimap` (current behaviour, the default; unchanged) or
  `keylight` (this new core). Only valid with `--method plate`; passing it with
  `--method ml` fails the same way `--quality` does on `plate` today.
- `--screen-colour` — `auto` (default) reuses `detect_key`; a hex value pins the
  Screen Colour, matching Keylight's manual pick. Auto-detect stays the pipeline
  default because unattended batch runs are the common case.
- Keylight controls (`--screen-balance`, `--clip-black`, `--clip-white`,
  `--screen-gain`, `--screen-pre-blur`, `--despill-bias`) apply **only** to
  `--key-engine keylight`; each fails fast on the trimap engine with the same
  "does not apply" message pattern already used in `bin/pipeline.js`.
- `--inside-mask` / `--outside-mask` — optional holdout/garbage mattes
  (white=force, black=ignore), auto-resized to the shot. Each accepts **either** a
  single PNG (applied to every frame) **or** a directory of numbered PNGs
  (`%05d.png`, one per frame, matching the `png` output convention) for animated
  masks that track a moving prop. Missing frames in a sequence fall back to
  no-op. Useful for the ArtAI corpus where in-design green (AI2's chest cross)
  must be protected — the same problem the ML method's opaque-drift guard solves
  differently.
- `--despill-bias` — `auto` (default) derives the protected neutral tone from the
  frame's foreground core (median of high-alpha, off-key pixels); a hex value
  pins it, matching Keylight's manual bias pick.
- `--feather` / `--despill` — already exist on `plate`; carry over unchanged.

### 3.2 Algorithm (new `keylight_alpha()` in `python/plate_matte.py`)

Per frame, BGR float [0,1], given `key` and optional bias:

1. **Pre-blur** the key input (`screen_pre_blur`) — Gaussian on a copy; the
   output RGB is despilled from the *unblurred* source.
2. Identify dominant channel `kmax` from `key`; order the other two per pixel.
3. `other = balance*o2 + (1-balance)*o1`; `strength = D - other`.
4. Apply **despill bias**: shift the measure by the bias colour's own strength so
   protected hues read as foreground. Bias colour is auto-derived per frame
   (median of high-alpha, off-key pixels) unless `--despill-bias` pins a hex.
5. Normalise by the screen's strength → raw alpha `= 1 - clamp(strength/screenStrength)`.
6. **Clip black/white levels:** `alpha = clamp((alpha - clipBlack)/(clipWhite - clipBlack), 0, 1)`.
7. **Screen gain** scales strength before step 5.
8. Apply **inside mask** (`alpha = max(alpha, inside)`) and **outside mask**
   (`alpha = alpha * (1 - outside)`).
9. **Despill** RGB via the existing `min(D, other)` clamp (now balance-aware), so
   the two stay consistent — reuse the current despill path.
10. **Softness only:** if `--feather > 0`, apply a plain Gaussian blur to the
    alpha (Keylight's *Screen Softness*). This is a **pure per-pixel keyer** — no
    trimap, no closed-form matting. Edges come from the source's own
    partial-coverage pixels plus this optional softness, faithful to After
    Effects. (Resolved: per-pixel chosen over closed-form refinement — see Part 5.)

Steps 3–4, 9 are Keylight's shared-measurement property. Steps 6–8 are the
artist controls that make it usable on a bad plate.

Because there is no closed-form solve or `pymatting` call, the keylight engine is
also markedly cheaper per frame than the trimap engine — a deliberate secondary
benefit for batch runs.

### 3.3 Reuse — no new I/O or plumbing

`keylight_alpha()` slots into the same per-frame loop as `matte()`; `probe`,
`detect_key`, `encoder_args`, streaming, temp-file finalize, and the JSON report
are untouched. On the Node side, `plateMatteEngine` gains the pass-through flags;
`matteShot` stays method-agnostic. This matches how `matteEngine` and
`plateMatteEngine` already mirror one `run({input,output,format,despill})`
contract.

### 3.4 Report additions

Extend the plate report with the resolved controls and a spill metric so batch
runs are auditable (mirrors the ML method's `edgeGreenBefore/After`):

```json
{ "method": "plate", "keyEngine": "keylight", "key": "#3ba35f",
  "screenBalance": 0.5, "clipBlack": 0.1, "clipWhite": 0.6,
  "meanCoverage": 0.31, "edgeSpillBefore": 0.42, "edgeSpillAfter": 0.05 }
```

Reuse `green_fraction`-style edge accounting from `python/matte.py` (generalised
to the detected key hue, not hard-coded green).

---

## Part 4 — Defaults and validation

- Defaults chosen so `--key-engine keylight` with no other flags approximates
  today's despill behaviour: `screen_balance=0.5`, `clip_black=0`, `clip_white=1`,
  `screen_gain=1`, `pre_blur=0`, `screen_colour=auto`.
- Carry over `plate_matte`'s invariant discipline (`python/matte.py` `reject()`):
  a Keylight run whose mean coverage collapses to ~0 or ~1, or whose edge spill
  does not drop when despill is on, is rejected rather than written — same "never
  leave a plausible-but-wrong file on disk" rule.
- Tests (`test/matte.test.js`): flag validation (keylight-only flags rejected on
  trimap/ml; `--screen-balance` range), a synthetic green-plate fixture keyed to
  a known coverage, and mask override behaviour.

---

## Part 5 — Resolved decisions (2026-09-08)

1. **Edge model — RESOLVED: pure per-pixel keyer.** No closed-form refinement.
   Faithful to After Effects and cheaper per frame; edges come from source
   partial-coverage plus optional Gaussian `--feather` (Screen Softness). See
   §3.2.10.
2. **Sub-engine vs separate method — RESOLVED: sub-engine of `plate`
   (`--key-engine keylight`).** Keeps Keylight rolled into colour keying and
   reuses plate plumbing.
3. **Mask sourcing — RESOLVED: per-frame masks supported.** `--inside-mask` /
   `--outside-mask` accept a single PNG or a `%05d.png` directory sequence. See
   §3.1.
4. **Bias UX — RESOLVED: auto-derivation is the default, hex override allowed.**
   `--despill-bias auto` (default) derives the protected tone per frame; a hex
   value pins it.
```
