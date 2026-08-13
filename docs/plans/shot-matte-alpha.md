# Plan: add `pipeline shot matte` — reliable alpha, shadow and reflection from finalized shots

**Repo:** `~/Projects/2d-animation-pipeline`
**Status:** ready to implement (measurements done, one open risk isolated to a prototype step)
**Origin:** derived from the ArtAI project, where every finalized Seedance shot had to be hand-keyed in After Effects to get usable alpha. All measurements below come from the 14 finalized shots in that project (`shots/*/final/output.mp4`), which serve as the reference corpus — but the feature belongs in the pipeline, not in ArtAI.

---

## 1. Goal

Today the pipeline takes a shot all the way to `final/output.mp4` and stops. Every downstream compositing step — pulling a matte, despilling, cutting the character onto a plate — happens by hand in After Effects, per shot, every time.

The prompt-side answer the pipeline currently encourages ("a solid, pure, saturated chroma-key green ... perfectly flat digital fill") **does not survive generation**, and §2 shows it never once has. So the manual keying is not a discipline problem that better prompt wording will fix; it is structural.

Add a post-generation step that turns a finalized shot into clean RGBA — plus optional shadow and reflection passes — with **zero regeneration credits** and no per-shot tuning.

### Target UX

```
pipeline shot matte --id art-talk-01 --version final \
  --method hybrid --format prores4444 \
  --shadow ground --light-angle 25 --reflection 0.35 --qc
```

Writes alongside the existing shot layout:

```
shots/<id>/final/
  alpha.mov              # ProRes 4444, RGBA, straight (unpremultiplied)
  shadow.mov             # separate alpha pass
  reflection.mov         # separate alpha pass
  qc/matte-report.json
  qc/worst-frames.png    # contact sheet of the frames worth a human look
```

`--method hybrid` is the headline: a neural matte establishes topology and interior, and a per-frame auto-tuned colour key acts as a recall backstop for thin structures (§4). Everything else is derived from the resulting alpha for free.

---

## 2. Why the current approach cannot work (measured on the ArtAI corpus)

A mid-shot frame was sampled from all 14 finalized shots. Plate colour is the median of the border ring; "character px in green wedge" is the share of character pixels a hue-based keyer would attack.

| shot | plate RGB | plate sat % | ring noise σ | character px in green wedge |
|---|---|---|---|---|
| ai-alt1-talk-01 | 74, 205, 77 | 64 | 1.4 | 4.1% |
| ai-alt1-talk-03 | 66, 182, 63 | 65 | 1.2 | 3.8% |
| ai-alt2-talk-01 | 84, 178, 96 | 53 | 1.7 | 0.9% |
| ai-alt2-talk-02 | 93, 205, 98 | 55 | 1.3 | 2.0% |
| ai-alt2-talk-02a | 73, 168, 82 | 57 | 1.1 | 4.0% |
| ai-alt2-talk-03 | 76, 167, 84 | 54 | 2.8 | 1.8% |
| ai-alt2-talk-04 | 94, 196, 108 | 52 | 4.1 | 2.8% |
| ai-alt2-talk-05 | 81, 168, 88 | 52 | 2.5 | 1.4% |
| art-talk-01 | 75, 157, 69 | 56 | 2.5 | 4.8% |
| art-talk-02 | 97, 193, 94 | 51 | 3.1 | 4.7% |
| art-talk-03 | 91, 179, 84 | 53 | 4.0 | 3.3% |
| art-talk-05 | 74, 169, 112 | 56 | 1.7 | 3.8% |
| art-talk-06 | 98, 155, 79 | 49 | 2.8 | 2.7% |
| art-talk-07 | 69, 178, 83 | 61 | 1.8 | 5.2% |

**a. The model never delivers key green.** Every plate lands at 49–65% saturation; true chroma-key green is ~100%. Fourteen shots, zero exceptions. Prompt wording has never moved this.

**b. The plate is different in every shot.** R 66–98, G 155–205, B 63–112 (σ = 10.5 / 15.6 / 13.2). A keyer tuned on one shot is 40 units off on the next.

**c. It drifts within a shot too.** On `art-talk-01`, frame 0 is `60,178,53` and everything from frame 10 on is `78,158,71` — a 20-unit jump, so a key tuned on the poster frame is wrong two-thirds of a second in.

**d. Characters contain green.** 1–5% of character pixels sit in the green hue wedge at >20% saturation (`art-talk-07` worst at 5.2%). AI2 carries a green cross on its chest.

**e. Structural: every file is `yuv420p` H.264.** Chroma is subsampled 2×2 and quantized, precisely at the edges a keyer needs. Chroma keying reads the chroma planes, so the information was destroyed by the codec before AE ever opened the file.

**Conclusion: chroma keying is the wrong extraction method for generative video output.** The pipeline should stop keying on colour.

---

## 3. What "no single preset works" means, quantified

Simulating ffmpeg's `colorkey` model against each shot's own measured plate, the usable tolerance window is where interior holes stay <1% *and* background residue stays <1%:

| shot | usable window | | shot | usable window |
|---|---|---|---|---|
| ai-alt1-talk-01 | 0.02–0.18 | | ai-alt2-talk-03 | 0.07–0.10 |
| ai-alt2-talk-01 | **0.02–0.04** | | ai-alt2-talk-05 | 0.07–0.10 |
| ai-alt2-talk-02a | 0.06–0.09 | | art-talk-06 | 0.02–0.08 |

`ai-alt2-talk-01` needs ≤0.04; `ai-alt2-talk-03` needs ≥0.07. **The windows do not intersect — there is no shared setting.** Several are only 0.02–0.03 wide. This is the manual-tweaking loop as a measurement rather than a complaint, and it is why the fix has to be per-frame adaptive rather than a better default.

Separately, **75–99% of edge-band pixels are green-contaminated** across all 14 shots (worst `art-talk-07` at 98.8%). No tolerance setting touches that — it is baked into the pixel values (§7).

---

## 4. Design

### 4.1 Method

1. **Neural alpha** — per-frame segmentation/matting, colour-agnostic. Plate variance (2b/2c) and in-design green (2d) stop mattering by construction rather than by tuning.
2. **Width-adaptive trimap** — never uniform erosion. Compute medial axis + distance transform; the **skeleton is always definite-foreground regardless of structure width**, so every connected structure keeps a ≥1 px spine, and the band radius is local: `r = min(r_max, dt − 1)`. Torso gets a 10 px band; a 9 px antenna gets 2 px. §6 shows why this is not optional.
3. **Band refinement** with a matting head trained on thin structures (ViTMatte / FBA), not a fixed-window guided filter — a window wider than the structure averages it away.
4. **Colour key as recall backstop** — see 4.2.
5. **Despill by inverting the compositing equation**, not by radius or hue. Every edge pixel is `C = a·F + (1−a)·B` for plate colour `B`, so `F = (C − (1−a)B) / a` removes the plate's contribution exactly. This **supersedes the "despill keyed to local radius" this plan originally specified**, and is strictly better: at `a == 1` it reduces to the *identity*, so in-design greens and the spine of every thin structure are untouched by construction rather than by a heuristic that needs tuning and can be wrong. Verified at 0.000000/255 drift across 63,375 fully-opaque pixels; edge spill **25.2% → 4.7%** on the reference frame. `B` is estimated per frame on a coarse grid from pixels the matte itself calls background, which tracks plate gradients and survives the localized dark streaks that would poison a single global median.
6. **Temporal pass: motion-compensated or gradient-gated**, never a plain median (§6, mode 3).
7. Unpremultiply, write RGBA.

### 4.2 The two methods fail on uncorrelated inputs — arbitrate, don't choose

| | thin structures | in-design green |
|---|---|---|
| neural matte | **weak** — may miss entirely | strong — hue never consulted |
| auto-tuned colour key | **strong** — 98% of a 4 px antenna | weak — 40% interior holes |

AI2's antenna stalks are copper on a green plate: maximum chroma distance, the *easiest* case for a key. Its chest cross is green: the hardest. So the neural matte is the authority on topology and interior, and the per-frame key contributes foreground **only outside the deep interior**. That union is what closes the "model missed it entirely" failure, which no amount of trimap care can.

### 4.3 Plate colour is an input-side modifier, not an alternative

Once matting does the extraction, background colour never decides alpha. The plate's only remaining job is not contaminating edge pixels — and at every silhouette edge the character's antialiased and motion-blurred pixels are a literal blend of character and plate colour, **baked in, unmixable by any matte**.

A green plate leaves a green fringe (75–99% of edge pixels, §3). A **mid-gray plate — what the element sheets already use** — makes the same blend a neutral desaturation instead of a hue shift: far less visible, correctable with luminance rather than hue surgery.

This costs regeneration credits, so it applies to **new shots only** and is a refinement, not a requirement. Nothing in §4.1 depends on it. It belongs in this plan as a follow-up change to the shot-author skill's background wording, not as a blocker.

### 4.4 Rejected: silhouette erosion (`--edge-bias`) — built, measured, removed

Despill only acts where alpha < 1, so spill baked into *fully opaque* pixels (the green on AI2's antenna ball rims) is out of its reach. The obvious extension is to move the silhouette boundary inward so that ring becomes partial alpha and despill can correct it — a signed distance field on the opaque silhouette, with a signed parameter to erode or dilate.

It was implemented and measured. **Do not rebuild it without new evidence.**

| bias | protect thin | green in composite | coverage | antenna spine >0.5 |
|---|---|---|---|---|
| 0 | — | 0.86% | 25.87% | 100.0% |
| −2 | on | 0.66% | 24.90% | 95.8% |
| −2 | off | 0.53% | 24.03% | 88.2% |
| −5 | off | 0.54% | 22.44% | 65.4% |

Why it was dropped:

1. **The ceiling is low and it is a real ceiling.** With thin-structure protection the result saturates at 0.66%, because 76% of opaque-green pixels sit >3 px deep — they *are* the chest cross and LED. 0.86% × 0.76 ≈ 0.65% matches the floor. Protected erosion removes the boundary spill available to it and then stops; going further only eats design colour and antennae.
2. **The 0.20-point gain was never shown to be visible**, while the costs were: ~1% of silhouette area, and a dark rim on eroded edges that bias 0 does not have.
3. **A band low-pass fixed the wrong thing.** It cut high-frequency alpha energy 4× (0.132 → 0.032) and improved thin-structure retention, but at the composite level only 656 px in the inspected crop changed at all (1.62%, mean 0.42/255) — indistinguishable from unsmoothed even at 10× side by side. The metric moved; the picture did not.

Two transferable lessons:

- **Smoothing alpha before thresholding destroys thin structures** (spine 96.2% → 83.1%), because the blur pushes them under the cutoff. If any future stage needs a smoother boundary, filter *after* the threshold, restricted to the transition band.
- **Structure width must be propagated from the medial axis, not read per-pixel.** Capping erosion by a pixel's own depth-from-boundary silently disables it exactly at the boundary, where it is needed — every measurement came out identical before this was caught.

Removed in favour of the bias-0 output, which the reviewer judged preferable. Recoverable from reflog at `f6d7aa7` / `7139fe0` if ever wanted.

---

## 5. Implementation

Follows the `transcribe.js` / whisper.cpp precedent exactly: an external engine behind an injectable-`exec` factory, env overrides, and actionable install errors.

| file | role |
|---|---|
| `src/matte.js` | flags, path resolution, QC metrics, orchestration, report writing — **fully unit-tested with an injected `exec`** |
| `python/matte.py` | inference + trimap + refine + despill + compositing passes |
| `models/` | ONNX weights, fetched on first run like `ggml-base.en.bin`, with a `curl` hint in the error |
| `test/matte.test.js` | 1:1 with `src/matte.js`, per repo convention |
| `src/paths.js` | add `shotAlphaPath`, `shotMatteQcDir` |
| `bin/pipeline.js` | route `cmd === 'shot' && sub === 'matte'` |
| `docs/recipes/` | a matte recipe alongside `seedance-lipsync.md` |
| `templates/skills/shot-author/SKILL.md` | mention the matte step so it is discoverable |

**Runtime:** Python sidecar invoked through `uv run --with numpy,pillow,onnxruntime`, keeping deps hermetic with no venv to manage. Same shape as requiring whisper.cpp via brew. `MATTE_PYTHON` overrides with a pre-provisioned interpreter for CI.

**Execution provider: CPU, deliberately.** CoreML is the obvious reach on Apple silicon and it does not work here — converting the ~930 MB BiRefNet graph wedged at **9.6 GB RSS with zero CPU progress after 10 minutes**, never reaching the decoder. CPU loads the session in 1.4 s and runs **~4.4 s/frame**, so a 121-frame 5 s shot takes ~9 minutes. That is slow enough to matter for a 14-shot batch (~2 h) but it is unattended work, and correctness beats a hang. `--providers` is exposed to retest CoreML later. Revisiting this is the obvious first performance task once the feature is correct.

**Encoding:** `-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -alpha_bits 16` — AE reads it natively and the alpha is not subsampled. PNG sequence as lossless fallback, VP9 `yuva420p` for web.

**Env overrides:** `MATTE_MODEL`, `MATTE_PYTHON` — mirroring `WHISPER_CPP_MODEL` / `WHISPER_CPP_BIN`.

### Two implementation gotchas, both found by running it

**BiRefNet emits logits, not probabilities.** They must pass through a sigmoid before the min-max rescale. Skipping it rescales a near-linear range instead of a saturated one, producing a smooth gradient rather than a mask: measured **97% of pixels neither opaque nor transparent, coverage 0.010 where the correct value is 0.259**. Input scaling also divides by the frame's own max rather than by 255 — identical whenever some pixel hits 255, which is exactly why it is easy to miss. With both corrected the output matches the bake-off reference to a mean absolute difference of 0.00000.

**That bug exited 0 and wrote a plausible 181 MB file.** Nothing downstream would have caught it until a compositor opened the clip. So the sidecar now asserts a shape invariant before reporting success: a correct matte confines soft pixels to the silhouette edge (~1% on this corpus), and a mostly-soft result is refused with an explanatory error. `meanSoftFraction` is reported for the QC stage to threshold more precisely later.

The general lesson for the remaining PRs: **a matting stage can fail silently and still produce a large, well-formed file.** Every stage needs an invariant it checks about its own output, not just a non-zero exit code.

### Working practices these PRs established

**Invariants must be tight enough to fail.** The first despill guard allowed 1.5/255 of drift on opaque pixels and the real value was 1.447 — it passed by a hair and would have caught nothing. The actual guarantee is *exactness* at `a == 1`, so the threshold is now 0.01 and the measured value is 0.000000 across 63,375 pixels. A barely-passing invariant is worse than none: it reads as verification while providing no protection.

**Validate before publishing the artifact.** Encoding necessarily finishes before the output can be measured, so a rejected matte has already been written. The sidecar encodes to `alpha.partial.mov` and only `os.replace`s it into position once every check passes — otherwise the partial is discarded. Without this, a failed run leaves a plausible file that a later step, or a person, can mistake for a good one. (Keep the real extension last: `alpha.mov.partial` leaves ffmpeg unable to choose a muxer.)

**A metric is not a result until it shows up in composited pixels.** Several claims this feature produced were metric-true and picture-false. The discipline that separates them: composite the RGBA over a neutral background, diff against the variant you are comparing, and look at the per-pixel magnitude and how many pixels move. Despill passes that test — edge-band green 10.3% → 4.6% in the *composited* result, max per-pixel delta 46/255. The edge-bias band low-pass fails it — 656 px changed, mean 0.42/255, invisible at 10×. Report the second kind as "measured, not visible", never as a quality improvement.

**Iterate on 3 frames, not 145.** A full clip is ~10 minutes, which is slow enough that mistakes get discovered by long runs instead of by fast ones — a `NameError` in the report block survived all the way to a complete 145-frame render. A 3-frame clip exercises exactly the same path in ~13 s:

```bash
ffmpeg -i <shot>/final/output.mp4 -frames:v 3 -c:v libx264 -pix_fmt yuv420p smoke.mp4
uv run --with numpy,pillow,onnxruntime,scipy python python/matte.py \
  --input smoke.mp4 --output smoke-alpha.mov --model models/birefnet-dis.onnx
```

The Node tests cannot cover any of this — every bug in these two PRs was in the Python sidecar, which they do not execute. Run the smoke clip after touching `matte.py`.

---

## 6. Thin structures — the failure mode that shapes the design

Measured with medial axis + distance transform (true perpendicular width; horizontal runs overstate diagonal antennae 3–4×):

| shot | antenna stalk (median) | skeleton p1 | p5 | % of silhouette in structures <8 px |
|---|---|---|---|---|
| ai-alt2-talk-01 | 12.6 px | 2.0 | 4.0 | 7.5% |
| ai-alt2-talk-03 | 14.4 | 2.0 | 4.0 | 8.0% |
| **ai-alt2-talk-04** | **4.0** | 2.0 | 4.0 | **12.5%** |
| ai-alt2-talk-05 | 15.2 | 2.0 | 4.0 | 7.6% |
| art-talk-01 | 36.8 | 2.0 | 2.8 | 10.3% |
| art-talk-07 | 36.9 | 2.0 | 4.0 | 8.6% |

Every character has skeleton p1 = **2 px**. **7.5–12.5% of every silhouette lives in structures narrower than 8 px.** AI2's stalks are normally 12–15 px but collapse to **4 px** in `ai-alt2-talk-04`. The stalks are rendered with soft painterly edges, so a 9 px stalk has ~3 px of true interior.

**Class A — matte found it, refinement destroys it**

1. **Erosion annihilates the core.** No definite-FG survives when `w ≤ 2r`. → *width-adaptive trimap (4.1.2).*
2. **Refinement window averages it away** — alpha collapses to ~0.3. Insidious: it *fades* rather than deletes, reading as sloppy compositing rather than a bug. → *matting head, not fixed-window filter.*
3. **Temporal median deletes moving thin structures.** If a stalk sweeps more than its own width between frames, the ±2-frame median *is* background — it erases the antenna exactly when it moves fastest, and the body is untouched so aggregate QC sees nothing. → *motion-compensated or gradient-gated; safe fallback is percentile-80 instead of median.*
4. **Despill consumes the whole structure** — thin structures have almost no interior, so "the interior is protected" is false for them. → *resolved by the compositing-equation despill in §4.1.5: protection follows alpha, not radius, so a thin structure's opaque spine is exempt automatically no matter how narrow it is.*

**Class B — matte never found it**

5. **Model input resolution.** Many `rembg` models run 320²/512² internally: a 9 px stalk becomes 1.6 px and vanishes. **Dilation cannot recover this** — dilation only grows existing foreground, so a missed structure gets marked definite-background. Unrecoverable. → *2× supersample before inference; pin a model whose native resolution ≥ frame size.*
6. **Motion blur / genuine transparency.** A fast stalk is a real α ≈ 0.2–0.4 smear that segmentation thresholds to zero. → *matting head; strongest argument for the trimap-free path.*

### Tested: the trimap fix works completely

Antenna pixels retained in definite-foreground on `ai-alt2-talk-04`:

| trimap construction | antenna in definite-FG |
|---|---|
| uniform erosion r=4 | **59.8%** |
| skeleton-protected r=4 | 68.2% |
| **skeleton + width-adaptive, any r ∈ 2–5** | **100.0%** |

100% at every radius tested, and radius-insensitive, so no per-shot tuning. **Class A is closed.**

### Tested: Class B does not materialize

Six models run against `ai-alt2-talk-04` (the 4 px antenna frame), measuring alpha along the antenna centreline:

| model | spine alpha (median) | edge ramp width | interior intact | bg clean |
|---|---|---|---|---|
| **birefnet-dis** | **0.996** | **0.58** | 100% | 100% |
| birefnet-general | 0.996 | 0.97 | 100% | 100% |
| bria-rmbg | 0.996 | 1.01 | 100% | 100% |
| isnet-general-use | 0.988 | 0.85 | 99.9% | 100% |
| u2net | 0.988 | 1.86 | 99.9% | 100% |
| isnet-anime | 0.976 | 1.30 | 99.9% | 100% |

**Every model recovers both antennae intact.** Spine alpha is 0.996 through the full length of both stalks — solid, not ghosted. Visual inspection confirms it: no model loses or breaks a stalk.

**`birefnet-dis` wins** on the metric that matters for thin structures — the same 0.996 spine as the best, with an edge ramp roughly half the width of every alternative (0.58 vs 0.97–1.86). DIS is trained for fine-structure segmentation and it shows up exactly where predicted. Notably `isnet-anime` is the *worst* performer despite being the illustration-trained option; don't assume domain match beats architecture.

**Interior integrity is 100%** on the BiRefNet models — the green chest cross is a non-issue for a neural matte, confirming §4.2.

Three corrections this prototype forces:

1. **2× supersampling is unnecessary.** It changed results by ~0.2%. Failure mode 5 assumed 320²/512² models; BiRefNet runs at 1024² against 834×1112 frames, so there is nothing to recover. Keep supersampling as an option for smaller models, not a default.
2. **Naive recall % is the wrong QC metric.** Mean alpha over a hard reference mask reads ~75% for a *correct* matte, because a genuinely soft-edged stalk should have soft flanks. **Spine alpha is the right metric** — it distinguishes "thinned" from "ghosted", which the aggregate cannot. This validates the thin-structure alpha floor in §7.
3. **The colour-key backstop must be spatially constrained.** The generated plate contains localized dark streak artifacts — at `ai-alt2-talk-04` rows 0–99, columns 52–55, the plate reads RGB(1,80,15) against a plate of (94,196,108). A tight key calls that foreground; every neural model correctly ignores it. **Applied globally the backstop would inject this garbage**, so it must only contribute within a bounded neighbourhood of the neural silhouette. QC must likewise ignore a border margin or the topology assertion will fire on encoder artifacts.

Class A is closed by construction, Class B is closed by measurement. The morphology test above still used a threshold-derived silhouette, so it validates the trimap independently of the model — both legs now have evidence.

### Per-element declaration

`style-lock.yaml` already locks each design, so the floor should be per-element:

```yaml
thin_features:
  - name: antenna
    count: 2
    min_width_px: 8
```

Read by the matte step to set its band floor, and by QC as an assertion.

---

## 7. QC gate — what makes this reliable rather than usually-good

Per frame: alpha coverage delta, unknown-band area, residual edge saturation. Flag coverage jumps >2%; emit a contact sheet of the 6 worst frames, so a human reviews 6 images instead of scrubbing 121.

**Coverage delta alone is insufficient** — an antenna is ~0.3% of silhouette area, an order of magnitude under the flag. Add:

- **Topology assertion** — connected-component count, neural alpha vs final alpha. A component disappearing during refinement is a hard fail.
- **Skeleton-length retention** — flag a >10% drop. Catches *fading* (mode 2), which component count misses because the structure is still present at α≈0.3.
- **Thin-structure alpha floor** — for skeleton pixels in structures <8 px, report min/median alpha. A spine below ~0.8 is ghosting.

**Free reference the pipeline already has:** the locked turnaround/pose sheets under `elements/` establish each character's expected silhouette topology *a priori*. AI2 having two antennae is an assertable fact. No generic matting tool has this, and it turns "does the matte look right" into a test.

If any metric trips, the step refuses to write `final/` and names the frames.

---

## 8. Shadow and reflection — free from the alpha

Derived deterministically from the matte; no regeneration, no extra model, no per-shot art direction:

- **Contact shadow** — project alpha onto the ground plane: affine about `ground_y` (shear by light angle, squash by elevation), then **blur radius that ramps with distance from the contact line** (sharp at the feet, soft away) with matching opacity falloff. The distance-ramped blur is the whole trick; uniform blur is what reads as fake.
- **Ambient contact occlusion** — a small dark radial gradient at the footprint. Cheaper than the cast shadow and does more for the "standing on the floor" read.
- **Reflection** — flip RGBA about `ground_y`, gradient alpha falloff, distance-increasing blur, optional low-frequency horizontal displacement for wet-floor ripple, tinted from the destination plate.

Two parameters in `shot.yaml`: `ground_y` and `light_angle`. `ground_y` auto-estimates from the lowest non-zero alpha row, so in practice it is one parameter and often zero.

Delivered as **separate passes** so compositing is stacking, and density can be re-dialled in AE without re-running.

**Caveat:** silhouette projection, not 3D. Correct for a flat-lit illustrated character on a floor plane; will not bend a shadow up a wall or wrap a foreground object.

---

## 9. Sequencing

| step | effort | gate |
|---|---|---|
| ~~1. Model bake-off on `ai-alt2-talk-04`~~ | done | ✅ **`birefnet-dis` selected; Class B closed** (§6) |
| 2. `src/matte.js` + `python/matte.py` + tests, `--method hybrid`, ProRes 4444 out | ~1.5 days | all 14 ArtAI shots run unattended |
| 3. QC metrics + report + contact sheet + spine-alpha assertion | ~0.5 day | catches a deliberately broken matte |
| 4. Shadow / reflection / AO passes | ~0.5 day | |
| 5. Docs: recipe, skill template, CLAUDE.md quick-reference | ~0.25 day | |

**Engine decided:** `birefnet-dis` via ONNX. Sourced through `rembg` for the prototype, but the shipped feature should carry the `.onnx` directly in `models/` (as `ggml-base.en.bin` is) and call `onnxruntime` — `rembg` drags in a `pymatting`→`numba` chain that pins Python <3.10 unless overridden, which is not a dependency worth inheriting.

**Still open, to settle during step 2:** temporal behaviour. Everything measured so far is single-frame. Mode 3 (temporal median deleting moving thin structures) is untested and is now the largest remaining risk — it must be validated across a full 121-frame clip, not a still.

**Residual risk, stated honestly:** this will not hit 100%. If a stalk is lost in 3 frames of 121, the answer is a 3-frame roto patch in Resolve **driven by a QC report naming exactly those frames**. The goal is converting an every-shot manual keying problem into an occasional 3-frame touch-up — not eliminating human review.
