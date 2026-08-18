# Credit tracking

Track Higgsfield credit spend per task, sheet, and shot from project logs — including
failed generations that were billed but never saved.

## Quick start

Tag a batch of work once, then run generations as usual:

```bash
export PIPELINE_TASK="ep2-emotion-sheets"

pipeline element sheet --type characters --name cecilia \
  --sheet turnaround --id winter --model nano_banana_pro ...

pipeline credits report --task ep2-emotion-sheets --by sheet
```

## Commands

### `pipeline credits report`

Offline aggregation from `generations.jsonl` (elements and shots) plus legacy
`output.json` / upscale sidecars. Dedupes by `jobId` when both jsonl and legacy
records exist.

```bash
pipeline credits report --task ep2-emotion-sheets --by sheet
pipeline credits report --since 2026-08-17 --until 2026-08-19 --by day
pipeline credits report --saved-only   # exclude status:failed rows
```

`--by sheet` falls back to `--by kind` when the result set includes shots or
upscales (no sheet slug).

### `pipeline credits reconcile`

Compare logged **estimates** to **billed** account transactions for a time window.
Requires Higgsfield auth (`npm run check-auth`).

```bash
pipeline credits reconcile --since 2026-08-17 --until 2026-08-19
pipeline credits reconcile --since 2026-08-17 --exclude-unbilled
```

Columns:

| Column | Meaning |
|--------|---------|
| `LOGGED_SAVED` | Sum of credits on successful (`status !== failed`) entries |
| `LOGGED_ALL` | Sum including failed attempts (once Step 2 logging is active) |
| `BILLED` | Sum from `account transactions` (authoritative) |
| `GAP` | `BILLED - LOGGED_ALL` (untracked spend **or** estimate error) |

Use `--task` + narrow windows to reduce noise from other sessions on the same account.

### `pipeline credits tag`

Retro-label entries that predate task tagging. Rewrites matching jsonl lines in
place; skips rows that already have a `task`. **Run when idle** — concurrent
generations can race the rewrite.

```bash
pipeline credits tag --task ep2-emotion-sheets \
  --since 2026-08-17T00:00:00Z --until 2026-08-19T00:00:00Z \
  --sheet turnaround
```

### `pipeline credits backfill`

Fill missing `credits` on old jsonl rows from the flat-rate `MODEL_CREDITS` table
(image models only). Video/upscale rows are left unchanged.

```bash
pipeline credits backfill --type characters --name cecilia
```

## Task labeling

Priority: `--task <label>` flag > `PIPELINE_TASK` env var > none.

Threaded through:

- `pipeline element sheet`
- `pipeline shot generate`
- `pipeline shot upscale`

## Estimate modes

`PIPELINE_CREDITS_ESTIMATE_MODE`:

| Value | Behavior |
|-------|----------|
| `auto` (default) | Static table for flat image models; `generate cost` API for video/upscale |
| `table` | Offline only; unknown models → `credits: null` |
| `api` | Always call `generate cost` (5s timeout; never blocks generation) |

Logged `credits` are **estimates**. Reconcile `billed` is authoritative.

## Manual verification (ep-2 emotion sheets)

For historical data **before** failure logging shipped, over 2026-08-17..18:

- ~64 credits logged (32 saved Nano Banana Pro sheets × 2)
- ~108 credits billed (includes ~44 credits of failed retries never logged)

After failure logging is active on new work, `LOGGED_ALL` should track `BILLED`
within estimate error; the saved-only vs billed gap is the overhead signal.

## Caveats

- Transactions have no `jobId` — reconcile is time-window correlation, not exact attribution.
- Pre-submit failures (`billedLikely: false`) inflate gap if included; use `--exclude-unbilled`.
- Upscale cost estimates require upload first (`video_references`).
- Do not use `account status` balance for attribution (cached/unreliable).
