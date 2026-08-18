# Plan: Credit tracking & spend reports

**Status:** ready to implement
**Repo:** `2d-animation-pipeline`

Goal: make Higgsfield credit spend visible **per task / element / sheet / shot / date** from
the project itself, so questions like "how much did the episode-2 emotion sheets cost?" are a
one-line command instead of a manual transaction dig. Also surface **billed-but-unsaved**
spend (failed generations, post-complete download failures), which today is invisible.

Execute this in the `2d-animation-pipeline` repo. It changes the pipeline, then the
per-project workflow gets reports for free.

### Non-goals
- Per-job exact attribution from `account transactions` (no `jobId` on transactions).
- Multi-account or cross-project attribution without `--task` + narrow time windows.
- Using `account status` balance delta (cached/unreliable).

### Target UX

```bash
export PIPELINE_TASK="ep2-emotion-sheets"
pipeline element sheet --type characters --name cecilia --sheet turnaround --id winter --model nano_banana ...

pipeline credits report --task ep2-emotion-sheets --by sheet
# SHEET                          SAVED  FAILED  CREDITS
# cecilia/turnaround/winter      8      3       22
# ...
# TOTAL (saved)                                    64
# TOTAL (incl. failed)                            108

pipeline credits reconcile --since 2026-08-17 --until 2026-08-19
# MODEL              LOGGED_SAVED  LOGGED_ALL  BILLED  GAP
# Nano Banana Pro    64            108         108     0   (gap vs logged_all; saved-only gap 44)
```

---

## Current state (verified 2026-08-18)

- **Generation logs** (`elements/<type>/<name>/generations.jsonl`, written by
  `appendGeneration()` in `src/element.js:53`, called from `src/generate.js:68`) record
  `jobId`, `model`, `sheetId`, `version`, `ts`, `status:'generated'` — but **no credit
  cost**. Shots write a per-draft `drafts/vNNN/output.json` (`src/generate.js:124`) on
  success only; shots have no jsonl and **no record on failure**.
- **Upscale sidecars** (`src/upscale.js`) write `shots/<id>/…/*.json` beside the upscaled clip
  with `jobId`/`model` but no credits — another spend path the report must walk.
- **Failed / retried generations are not logged at all** — but many are still billed. In the
  ep-2 emotion-sheet work the account showed ~54 Nano-Banana-Pro charges (~108 credits) in
  the work window while only **32** sheets were saved (64 credits). The ~44-credit gap was
  network "fetch failed"/503 retries that billed a job whose result never came back.
- **Post-complete failures are also invisible.** `runBatch` can return `status:'completed'`
  with an `outputUrl`, but if `downloadTo`, panel split, or disk write throws afterward, no
  log entry is written even though the job was billed.
- **Actual control flow uses `runBatch`, not raw create+wait.** `src/generate.js` and
  `src/upscale.js` call `runBatch(runner, […])`, which submits async then polls. Failures
  surface as `{ status:'error'|'nsfw'|…, id, error }` result objects — they rarely throw
  from inside `runBatch`. Callers throw only after checking `result.status !== 'completed'`.
- **Higgsfield CLI capabilities** (`node_modules/.bin/higgsfield`, path from
  `higgsfieldBin()` in `src/config.js:25`):
  - `generate cost <job_type> --prompt <p> [--image <f>…] --json` → **estimates credits
    without creating a job** (free, exact, handles variable video costs). Params/media flags
    match `generate create` — reuse `buildGenerateArgs()` from `src/cli.js`.
    - **Verified 2026-08-18:** does **not** reproduce the `generate create` stderr-capture
      hang — `generate cost topaz_video`/`bytedance_video_upscale` with a captured stderr pipe
      returns in ~300ms. So `estimateCost` can use the default captured-stderr `exec`; no
      `inheritStderrExec` needed.
    - **But upscale/video cost needs the media references**: `generate cost topaz_video
      --resolution 1080p` (no video) exits 4 with `Missing required params: video_references`.
      Cost is only priceable once the source is uploaded → for upscale the estimate must run
      **after** `runner.upload`, not from params alone. Flat image models price from the
      prompt with no media (`nano_banana` → `{credits:1}`).
  - `account transactions --json` → rows `{action, created_at, credits, display_name}`.
    **No jobId** → account↔job linkage is only possible by time-window + model correlation.
  - `generate get <jobId> --json` → `{id, status, …}`, **no cost field**.
  - `account status` balance is cached/unreliable (see note in `src/credits.js`). Do **not**
    use balance-delta for attribution.
- **Existing building blocks**: `src/credits.js` already has `parseTransactions(stdout)` for
  the human table. CLI dispatch is a flat `if (cmd===… && sub===…)` chain in
  `bin/pipeline.js`. The higgsfield runner is `createRunner()` in `src/cli.js`.

Design consequence: record a **credit estimate** at attempt time via `generate cost` + a
static fallback table; use `account transactions` only for a **reconcile** view that exposes
untracked spend and estimate drift. Logged `credits` are estimates — reconcile `billed` is
authoritative for actual spend.

---

## Design (three layers + tagging)

### A. Record cost estimate at attempt time  *(enables offline reports)*

- `src/config.js`: add
  - `MODEL_CREDITS` — static map of flat-rate model slugs → credits. **Populate from
    `higgsfield model list` / `generate cost` per slug, not guesses.** Verified 2026-08-18:
    `nano_banana → 1`, `nano_banana_2 → 2`, `nano_banana_pro → 2`. Video/upscale models are
    variable → omitted, priced via the API path.
    - **Slug care:** the ep-2 emotion sheets billed **2 credits each** ("Nano Banana Pro" in
      transactions), i.e. the model in use is `nano_banana_pro`/`nano_banana_2` (2), **not**
      `nano_banana` (1). Do not anchor the table on `nano_banana: 1` — using the 1-credit
      entry to estimate a 2-credit job produces a permanent ~50% reconcile gap that reads as
      untracked spend but is pure estimate error. Verify which slug each command actually
      passes and key the table to that.
  - `MODEL_DISPLAY_NAME` — map log `model` slug → transactions `display_name` for reconcile
    alignment (e.g. whatever slug maps to `'Nano Banana Pro'` in transactions).
  - Default estimate mode `'auto'`, overridable via env
    **`PIPELINE_CREDITS_ESTIMATE_MODE`** (`'table' | 'api' | 'auto'`): table hit keeps the
    hot path offline; API for variable/unknown (Seedance, Topaz, bytedance upscale).
    - **Decision point — `auto` makes the API call for video/upscale (kept ON).** The
      alternative is for `auto` to skip the `generate cost` call on variable models and log
      `credits: null`, keeping the hot path fully offline and avoiding the upscale
      upload-ordering wrinkle. Rejected: the static table structurally can't price video, and
      backfill can't recover it (needs media params old entries don't store), so skipping would
      make Seedance/Topaz spend — the most expensive, most variable spend — invisible to
      offline `report`, leaving only time-window `reconcile`. The ~300ms round-trip is noise
      against a minutes-long video gen. Revisit if video gens become frequent *and* per-video
      cost attribution stops mattering; the escape hatch already exists
      (`PIPELINE_CREDITS_ESTIMATE_MODE=table` forces offline, video → `null`).
- `src/cli.js`: add `buildCostArgs(model, opts)` — same shape as `buildGenerateArgs` but
  `['generate', 'cost', model, …]` instead of `create`. Add `runner.estimateCost(model, opts)`
  that runs it with `--json` and returns parsed credits (`Math.abs`).
- `src/credits.js`: add `estimateCredits({ runner, model, prompt, images, …opts }) →
  { credits, source }` where `source ∈ 'api'|'table'|'unknown'`. Delegates to
  `runner.estimateCost` for the API path. On any failure → `{ credits: null, source:'unknown' }`
  (never block a generation on pricing). **Wrap the API call in a hard timeout** (resolve to
  `{credits:null, source:'unknown'}` on expiry): `generate cost` doesn't reproduce the create
  hang, but a hung estimate must never stall the actual generation — a failure guard alone
  doesn't cover a hang.
- **Shared helper** `recordCreditAttempt(root, location, entry)` in `src/credits.js` (or a
  small `src/credit-log.js`): writes to the correct store for the location kind. Called from
  `generate.js` and `upscale.js` on both success and failure.
- `src/generate.js` + `src/upscale.js`: compute the estimate **before** `runBatch` (prompt
  and reference paths are known; same inputs as create). Attach `credits`, `creditsSource`,
  `task` to success payloads. For flat image models in `'auto'` this is a pure table lookup —
  **no extra network on the hot path**. Caveats:
  - **Video/upscale gains a synchronous pre-flight round-trip** (the API path). "No extra
    network" holds only for the flat-image table path.
  - **Upscale estimate must run after `runner.upload`** — `generate cost` for topaz/bytedance
    requires `video_references` (the uploaded media id), which `upscaleShot` only has post-
    upload ([upscale.js:67](../../src/upscale.js)). So for upscale, estimate between `upload`
    and `runBatch`, not at function entry.
  - **Shot video estimate may miss the speech-ref.** `generateShotDraft` builds `speech-ref.mp4`
    and prepends it to `videoReferences` mid-function ([generate.js:99-103](../../src/generate.js));
    a param-time estimate won't include it. Fine for cost order-of-magnitude; note the drift.

### B. Log failed / incomplete attempts  *(captures overhead)*

Integrate at the **`runBatch` result** boundary — do **not** wrap create+wait directly.

After `runBatch` returns, before re-throw:

1. **`result.status !== 'completed'`** (submit error, poll error, timeout, moderation, etc.)
   → log with `status:'failed'`, `failurePhase:'generation'`, `jobId: result.id ?? null`,
   `billedLikely: !!result.id` (submitted jobs are likely billed; pre-submit `id:null` is
   likely not), `credits`, `creditsSource`, `error: result.error`, `task`.
   - Element sheets → append to `generations.jsonl` via `appendGeneration`.
   - Shots → append to **`shots/<id>/generations.jsonl`** (new; parity with elements).
   - Upscales → append to the same shot `generations.jsonl` with `kind:'upscale'`.

2. **`result.status === 'completed'` but a post-job step throws** (download, split, disk write)
   → log with `status:'failed'`, `failurePhase:'post_complete'`, `jobId: result.id`,
   `billedLikely: true`, same credit fields, then re-throw. This is a billed-but-unsaved case
   the original plan missed.

Use try/finally or a small wrapper so post_complete logging runs even when download throws.
Callers still fail loudly after logging.

**Scope note — this is more than a `finally`.** In `generateElementSheet` the post-complete
region spans download → write prompt → `splitPanels` → `appendGeneration`, and the *success*
log is the final `appendGeneration` ([generate.js:51-73](../../src/generate.js)). Getting
"log `post_complete` on any throw in that region, log `generated` on success, exactly once"
right means restructuring the tail of both `generateElementSheet` and `generateShotDraft`
(and `upscaleShot`), not just bolting on a `finally`. Budget for that refactor.

### C. Report + reconcile commands

- `pipeline credits report [--root <ep>] [--type <t> --name <n>] [--sheet <slug>] [--since <ISO>] [--until <ISO>] [--task <label>] [--by element|sheet|shot|day|model|task|kind] [--saved-only] [--json]`
  - Walks:
    - `elements/*/generations.jsonl`
    - `shots/*/generations.jsonl` (includes failed attempts + upscales)
    - `shots/*/drafts/*/output.json` and upscale sidecars `*.json` (legacy success records
      predating `generations.jsonl`; dedupe by `jobId` when both exist)
  - Applies filters, sums `credits` (estimates), groups per `--by` (default `sheet` for
    elements). **When the walked set mixes elements and shots, `sheet` has no meaning for
    shot/upscale rows — fall back to `--by kind` (or bucket non-sheet entries under a `—`
    key) rather than dropping them.** `--by kind` splits element / shot / upscale. Prints
    table + grand total;
    `--saved-only` excludes `status:'failed'`; missing `credits` shown as `?` in a separate
    bucket. **Offline, fast.**
- `pipeline credits reconcile [--since <ISO>] [--until <ISO>] [--exclude-unbilled] [--json]`
  - Pulls `account transactions --json`, paginating `--size 100` + `--cursor` forward until
    the oldest row in a page is before `--since` (or no cursor). Normalize all timestamps to
    **UTC** before day bucketing — log `ts` is ISO UTC; parse transaction `created_at` the
    same way and document boundary drift (±1 day at edges).
  - Sums **billed actual** per model×day; sums **logged estimates** for the same window —
    **all** log entries, including Step-2 `status:'failed'` ones (that's the point: once
    failures are logged, `logged_estimate` tracks `billed_actual` and the gap closes). Emit
    **two logged columns — all-entries and saved-only** — so the gap is interpretable either
    way; a saved-only-vs-billed gap is the untracked-overhead signal, the all-vs-billed gap is
    estimate drift.
    With `--exclude-unbilled`, omit log entries where `billedLikely === false` from the logged
    sum (reduces false gap from pre-submit failures).
  - Prints per model: `logged_saved | logged_all | billed_actual | gap`. Gap means
    "untracked spend **or** estimate error" — not automatically overhead. Add
    `parseTransactionsJson()` next to the existing `parseTransactions()`.
- `pipeline credits backfill [filters]` *(one-time / maintenance)*: fill `credits` on old
  entries missing it from `MODEL_CREDITS` (flat-rate/image only; leave video `null` with a
  warning — old entries may lack the media params `generate cost` needs). Idempotent.

### Task tagging  *(the "cost of task X" ergonomics)*

- `src/generate.js` / `src/upscale.js` / shot path read a task label from **`--task <label>`**
  (thread through `bin/pipeline.js` for `element sheet`, `shot generate`, `shot upscale`) **or**
  the **`PIPELINE_TASK`** env var. Store `task` on every log entry.
  - Workflow: `export PIPELINE_TASK="ep2-emotion-sheets"` once → all subsequent gens tagged →
    `pipeline credits report --task ep2-emotion-sheets` answers the exact question.
- `pipeline credits tag --task <label> --since <ISO> --until <ISO> [--sheet <slug>]` — retro-
  label existing entries by time/sheet. **Rewrites matching lines in place** in
  `generations.jsonl` files; skips entries that already have a `task`. Applies to element and
  shot jsonl; does not mutate legacy `output.json` sidecars (use backfill + re-run if needed).
  **Run when idle** — the in-place rewrite (read-all → rewrite file) races a concurrent
  `appendGeneration`; a generation finishing mid-rewrite can be clobbered.

---

## Files to touch

- `src/config.js` — `MODEL_CREDITS`, `MODEL_DISPLAY_NAME`; default estimate mode.
- `src/cli.js` — `buildCostArgs()`, `runner.estimateCost()`.
- `src/credits.js` — `estimateCredits()`, `recordCreditAttempt()`, `parseTransactionsJson()`,
  `reportFromLogs()`, `reconcile()`; keep `parseTransactions()`.
- `src/element.js` — `appendGeneration()` passes through new fields (already spreads `entry`).
- `src/generate.js` — estimate before `runBatch`; success + failure logging (element sheet +
  shot draft); shot `generations.jsonl` on failure.
- `src/upscale.js` — same estimate + failure logging pattern; append to shot `generations.jsonl`.
- `bin/pipeline.js` — register `credits report|reconcile|backfill|tag`; add `--task` to
  `element sheet`, `shot generate`, `shot upscale`.
- `test/` — unit tests paired with each rollout step (below).
- `docs/recipes/credit-tracking.md` — short usage doc + manual ep-2 verification checklist.

## Log schema additions (backward compatible)

Common: `credits: number|null`, `creditsSource: 'api'|'table'|'unknown'`, `task: string|null`,
`kind: 'element'|'shot'|'upscale'` (on shot jsonl entries).

Failures: `status:'failed'`, `failurePhase: 'generation'|'post_complete'`, `billedLikely:
boolean`, `error: string`, `jobId: string|null`.

Old entries lack these fields; reports treat missing `credits` as unknown.

## Tests / acceptance

Paired with rollout — not deferred to the end.

- **Step 1:** `estimateCredits` / `runner.estimateCost` — table hit, API fallback (mock runner
  returns `{credits:-N}`), unknown. `reportFromLogs` — aggregation by sheet/day; unknown-credit
  bucket; legacy `output.json` + new jsonl dedupe.
- **Step 2:** Failure logging — mock `runBatch` returning `{ status:'error', id:'job_x' }` yields
  a `failed`/`generation` entry; mock download throw after completed result yields
  `failed`/`post_complete`. Upscale path covered.
- **Step 3:** `--task` / `PIPELINE_TASK` threading; report `--task` filter; `tag` idempotency.
- **Step 4:** `parseTransactionsJson` + `reconcile` — **fixture-based** logged vs billed math,
  `--exclude-unbilled`, gap column semantics. `backfill` idempotency.
- **Manual checklist** (not CI): reconcile over 2026-08-17..18 on the ep-2 account should show
  ≈64 logged (saved) vs ≈108 billed for Nano Banana Pro — validates the real-world case once.
  **This holds only because the ep-2 failures predate this feature and were never logged**, so
  the historical logs contain just the 32 saved sheets. Going forward (Step 2 active),
  `logged_all` for a fresh window tracks `billed` and the gap closes — the ≈44 gap is the
  saved-only column, not `logged_all`. Don't rerun this expecting a gap on new data.

## Rollout order (each step independently useful + tested)

1. `buildCostArgs` / `runner.estimateCost` + `MODEL_CREDITS` + record `credits` on **success**
   + `pipeline credits report` + step-1 tests. *(smallest win)*
2. Failure logging at `runBatch` boundary + post_complete cases + extend to **upscale** + shot
   `generations.jsonl` + step-2 tests. *(captures overhead)*
3. `pipeline credits reconcile` + `parseTransactionsJson` + step-4 reconcile tests
   (fixture-based).
4. `--task` / `PIPELINE_TASK` + report `--task` filter + `tag` + step-3 tests.
5. `backfill` for existing logs + `docs/recipes/credit-tracking.md`.

## Caveats to document

- Logged `credits` are **estimates**; reconcile `billed` is authoritative. Non-zero gap ≠
  untracked spend until estimates are validated for the models in use.
- Transactions have no jobId → reconcile is **time-window**, not exact; other projects/sessions
  sharing the account pollute the window. Mitigate with `--task` + narrow windows.
- Pre-submit failures (`billedLikely: false`) can inflate gap if included — use
  `--exclude-unbilled` on reconcile.
- `generate cost` needs the same params as create → backfill of old entries relies on the
  static table for flat-rate image models; variable video/upscale costs can't be backfilled
  reliably without stored params.
- Never attribute via `account status` balance (cached/unreliable).
- Model slug ↔ display name mapping must be verified against live `model list` / transactions;
  do not hardcode unverified slugs like `nano_banana_pro` without checking the CLI.
