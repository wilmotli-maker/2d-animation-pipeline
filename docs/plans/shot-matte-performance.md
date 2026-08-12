# Plan: make `pipeline shot matte` fast enough to run on a whole project

**Repo:** `~/Projects/2d-animation-pipeline`
**Status:** measured, ready to implement — one change carries almost all the gain
**Origin:** the first full-corpus run in ArtAI: 13 shots, 2,173 frames, **128 minutes** of wall clock. Fine as a one-off, too slow to re-run casually, and re-running is exactly what iterating on despill or temporal work requires.

---

## 1. Where the time actually goes

Per-stage timing of the frame loop, measured on real frames from `ai-alt2-talk-04`:

| stage | s/frame | share |
|---|---|---|
| **inference** | **4.064** | **98.6%** |
| plate estimate | 0.023 | 0.6% |
| preprocess | 0.016 | 0.4% |
| despill | 0.010 | 0.2% |
| postprocess | 0.005 | 0.1% |
| compose | 0.003 | 0.1% |
| total | 4.121 | |

**Everything except inference sums to 1.4%.** There is no point optimizing plate estimation, despill, encoding, or I/O — perfecting all of them would save under 4 seconds per hundred frames. This section exists mainly to stop anyone (including me) from starting there.

---

## 2. What was measured

Host: 18 cores (6 performance + 12 efficiency), 1.6 TB free, onnxruntime CPU EP.

### 2a. Model choice — the only lever that matters

| model | size | s/frame | vs current |
|---|---|---|---|
| **birefnet-dis** (current) | 928 MB | 4.04 | 1.0× |
| **isnet-general-use** | 179 MB | 0.48 | **8.4×** |
| u2net | 176 MB | 0.19 | 21.7× |

### 2b. Quality cost of the 8.4× — measured, not assumed

On `ai-alt2-talk-04`, the hardest thin-structure frame in the corpus (4 px antenna):

| model | antenna spine (median) | spine >0.9 | interior | bg clean |
|---|---|---|---|---|
| birefnet-dis | 0.996 | 85.8% | 99.98% | 100.00% |
| **isnet-general-use** | **0.992** | **87.1%** | **99.94%** | **100.00%** |
| u2net | 0.992 | 75.6% | 99.92% | 100.00% |

`isnet-general-use` is not measurably worse — it is marginally *better* on spine >0.9. Composited against a checkerboard, the two mattes differ on 0.70% of the frame (max 89/255), and inspection at 6× shows the difference is a ~1 px band of edge placement in the concave gap between the robot's legs, with neither model obviously more correct.

`u2net` is a genuine step down: spine >0.9 falls to 75.6% and its edge ramp is 1.86 vs 0.58 (measured in the original bake-off). The 21.7× is not free.

### 2c. Thread count — worth 1.5×, and the default is wrong

Throughput for `isnet-general-use` at various `intra_op_num_threads`:

| threads | s/frame |
|---|---|
| 18 (≈ default) | 0.64 |
| 6 | 0.46 |
| **4** | **0.43** |
| 3 | 0.54 |
| 1 | 0.74 |

Letting onnxruntime default to all 18 cores is **1.5× slower** than pinning 4. The efficiency cores drag the pool. Note this barely matters for `birefnet-dis` (4.04 → 3.91, 1.03×) — it is specific to the small model, which is why it only shows up once the model swap lands.

### 2d. Parallel workers — buys nothing

Aggregate throughput across concurrent worker processes, `isnet-general-use`:

| workers × threads | total fps | scaling |
|---|---|---|
| 1 × 4 | 2.34 | 1.00× |
| 2 × 4 | 2.33 | 1.00× |
| 4 × 4 | 2.23 | 0.95× |
| 6 × 3 | 2.36 | 1.01× |
| 8 × 2 | 2.29 | 0.98× |
| 12 × 1 | 2.27 | 0.97× |

**Flat.** A single 4-thread process already saturates the machine; this workload is memory-bandwidth bound, not core bound. Extrapolating "18 cores ÷ 1 thread = 18× throughput" predicted 24 fps and 86× — the measurement says 2.3 fps and 1.0×. Do not trust core-count arithmetic here.

This also retires the concurrency in the batch script: today's run used 2 workers and pair-batching, which measured at best 1.24× on the large model, cost 20 minutes of idle time waiting for the slower job in each pair, and added the scheduling complexity for nothing.

### 2e. CoreML — dead end

| model | CoreML EP |
|---|---|
| birefnet-dis (928 MB) | **hangs** — killed at 300 s |
| isnet-general-use (179 MB) | **hangs** — killed at 300 s |

Originally assumed to be a size problem (the 928 MB graph wedged at 9.6 GB RSS with no progress in 10 minutes). It is not: the 179 MB model hangs identically. The onnxruntime CoreML EP is unusable for these graphs on this host. Converting via `coremltools` directly is a different code path and *may* work, but that is a research task, not a fix — see §5.

---

## 3. Plan

| # | change | effort | measured gain |
|---|---|---|---|
| 1 | Pin `intra_op_num_threads` (default 4, `--threads` to override) | ~1 h | 1.5× *(on the fast model)* |
| 2 | Add `--quality fast\|best`, selecting `isnet-general-use` or `birefnet-dis` | ~3 h | **8.4×** |
| 3 | Drop concurrency from batch usage; document that it does not help | ~0.5 h | removes 20 min idle + complexity |

Combined, on the measured corpus:

| | s/frame | 2,173 frames |
|---|---|---|
| today | 4.12 | **128 min** |
| after 1+2 | ~0.49 | **~18 min** |

**~7× end-to-end.** That is the difference between a matte pass you schedule and one you just run.

### Which model should be the default? — validated, and the answer changed

The §4 validation was run. **`birefnet-dis` stays the default; `isnet-general-use` ships as `--quality fast` for iteration.**

Three shots matted with both — `ai-alt2-talk-01`, `ai-alt2-talk-03` (largest antenna excursion), `art-talk-04` (longest, only true chroma-green plate). 723 frames at **0.48 s/frame**, confirming 8.6× on real footage including despill.

**No structural regression.** Antennae never disappear under either model (0 zero-frames across both robot shots). Background cleanliness 100% for both. Coverage matches to within 0.15 points.

**But the edges are genuinely softer**, and it is visible:

| | birefnet-dis | isnet-general-use |
|---|---|---|
| soft-pixel fraction | 0.74–0.76% | **0.92–1.34%** |
| edge-band pixel count | ~15.7–16.9 k | **18.9–22.4 k (+20–43%)** |
| visible edge green, `art-talk-04` | 2.87% | **4.54%** |
| visible edge green, `ai-alt2-talk-03` | 0.76% | **0.43%** |

isnet's matte is wider. At 7× the antenna ball carries a soft pale halo and the apron ribbon on `art-talk-04` carries a green fringe that birefnet does not produce — a wider matte admits more plate-contaminated pixels at higher alpha, which despill cannot fully recover because they are not fully transparent. The `ai-alt2-talk-03` result runs the other way, so this is shot-dependent rather than a uniform penalty, but "sometimes worse, sometimes better" is not a basis for changing what ships.

**So the speed win applies where it is actually needed.** The pain was never the one-off delivery render; it was that re-running to evaluate a despill or temporal change costs two hours. `--quality fast` makes that loop ~8× shorter, and final output keeps the model the reviewed corpus was built with.

| use | model | 2,173 frames |
|---|---|---|
| iteration, previews, QC development | `--quality fast` | **~18 min** |
| delivery | `--quality best` (default) | ~128 min → ~85 min with thread pinning |

---

## 4. Validation — done

Ran on `ai-alt2-talk-01`, `ai-alt2-talk-03`, `art-talk-04` (723 frames, ~6 min). Results and the revised recommendation are in §3 above.

**Worth recording: the single-frame comparison in §2b was misleading.** On one frame isnet looked equal-or-better (spine 0.992 vs 0.996, *better* on spine >0.9), which pointed at making it the default. Across three full shots the softer edge shows up consistently — +20–43% edge-band pixels — and on one shot costs 58% more visible green fringe. One frame was not enough to see it.

**Implementation note for `--quality`:** pre/post-processing is **per-model and not interchangeable**. `birefnet-dis` uses ImageNet mean/std and applies a sigmoid to its logits; `isnet-general-use` uses mean 0.5 / std 1.0 and **no sigmoid**. Both then min-max normalize and both divide the input by the frame's own max rather than 255. Getting the sigmoid wrong produces a smooth gradient rather than a mask, which renders a plausible full-size file and exits 0 — it cost a complete 145-frame render to catch the first time. Any model added here needs its recipe read from the reference implementation, not assumed, and the soft-fraction invariant already in the sidecar is what catches the mistake.

---

## 5. Not pursued, and why

- **int8 / fp16 quantization of `birefnet-dis`** — plausibly 2–4× while keeping the exact model. Worth trying *if* the quality review rejects `isnet-general-use`; pointless otherwise, since the model swap is already 8.4× and free.
- **`coremltools` conversion** (bypassing the onnxruntime EP that hangs) — the ANE is the one piece of this machine the current path never touches. Genuinely promising, genuinely a research spike. Only worth it if ~18 min is still too slow.
- **Batched inference** — both models declare a fixed batch dimension of 1; batching needs a re-export. Given §2d shows the machine is already saturated, expect little.
- **Frame skipping with temporal alpha interpolation** — the only lever that beats the model swap in principle (2× for every-other-frame). Rejected for now: it trades correctness on exactly the thin, fast-moving structures that took the most work to get right, and §2d means we are not desperate for the speed.
- **Optimizing anything outside inference** — 1.4% of runtime. See §1.

---

## 6. Method note

Two extrapolations were wrong in this analysis and both were caught by measuring:

- "18 cores ÷ 1 thread per worker = 18× throughput" predicted 24 fps / 86× faster. Measured: 2.3 fps, 1.0×. The workload is memory-bound.
- "CoreML hangs because the model is 928 MB" predicted the 179 MB model would work. It hangs identically.

Core counts and model sizes do not predict throughput on this workload. Measure the configuration you intend to ship.
