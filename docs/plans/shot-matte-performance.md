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

### Which model should be the default?

Recommend **`isnet-general-use` as `--quality fast`, and make it the default**, with `birefnet-dis` retained as `--quality best`. It is 8.4× faster and not measurably worse on the hardest frame in the corpus. But this is a quality call on a shipping deliverable, so it wants sign-off rather than a silent switch — and it should be validated on more than one frame before flipping the default (see §4).

Keep `birefnet-dis` available regardless: it is the model the corpus that shipped was matted with, so reproducing those exact results has to remain possible.

---

## 4. Validate before flipping the default

The quality comparison in §2b is **one frame of one shot**. Before `isnet-general-use` becomes the default:

1. Matte 3 shots with each model — include `ai-alt2-talk-03` (largest antenna excursion) and `art-talk-04` (longest, only genuine chroma-green plate).
2. Compare with the existing QC: coverage, bg cleanliness, interior, soft fraction, and per-frame antenna presence across every frame.
3. Composite both over a checkerboard and diff — report where they differ and by how much, not just that a metric moved.
4. Human review of the side-by-side clips.

At 8.4× this costs ~10 minutes of compute, so there is no reason to skip it.

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
