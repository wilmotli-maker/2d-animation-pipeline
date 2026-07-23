# Sanity-check scripts

Runnable versions of the 7 sanity checks from the "Sanity checks to run before
building on this" section of `animation-automation-handoff.md`. Numbered to
match that list.

**Prerequisite:** install the Higgsfield CLI and run `higgsfield auth login`
first — `../check-auth.sh` (check 1) will tell you if this is missing.

**Before running anything else:** edit `config.sh` and set `SANITY_MODEL` /
`SANITY_VIDEO_MODEL` to real model ids. Get them for free from:

```bash
../check-auth.sh          # check 1 — free
./03-model-schema.sh      # check 3 — free, also lists all model ids
```

## Cost

| Script | Check | Cost |
|---|---|---|
| `../check-auth.sh` | 1: auth persistence | free |
| `02-exit-codes.sh` | 2: non-interactive exit codes | ~1 credit |
| `03-model-schema.sh` | 3: model schema drift | free |
| `04-credit-accounting.sh` | 4: credit accounting | ~1 credit |
| `05-file-io-roundtrip.sh` | 5: file I/O round-trip | ~1 credit |
| `06a-start-long-job.sh` + `06b-resume-long-job.sh` | 6: resumability | ~1 credit |
| `07-concurrency.sh` | 7: concurrency | ~2 credits |

Every credit-spending script prompts for confirmation before calling the real
API. Set `SANITY_CHECK_YES=1` in the environment to skip the prompt (useful
once you trust the setup and want to run several in a row).

## Order

1. `../check-auth.sh` and `./03-model-schema.sh` (or `./run-free-checks.sh` to
   run both at once) — free, do these first.
2. Fill in `config.sh` with real model ids.
3. `./02-exit-codes.sh`, `./04-credit-accounting.sh`, `./05-file-io-roundtrip.sh`
   — each self-contained, run in any order.
4. `./06a-start-long-job.sh`, then **close the terminal and open a new one**,
   then `./06b-resume-long-job.sh` — the whole point of check 6 is that it
   survives a fresh shell.
5. `./07-concurrency.sh`.

Re-run `../check-auth.sh` in a separate sitting (e.g. the next day) to
actually exercise check 1's "reopen terminal later" condition — a single run
right after login only proves login worked, not that the session persists.

## Notes on accuracy

Some exact command shapes here are assumptions carried over from the handoff
doc's research (marked there as unverified) — in particular:
- The JSON field the scripts parse for job ids (`extract_job_id` in `lib.sh`
  looks for a top-level `"id"` key) — adjust if the real response shape
  differs.
- ✅ Check 4 confirmed: credit accounting uses `higgsfield account status --json`
  (`credits` field) and `account transactions`. Note the `credits` balance is
  **cached** — the transaction log is the authoritative record of a charge.

If a script's assumption turns out wrong, fix the script in place — that fix
*is* the sanity check result.

## State

Each script writes intermediate output (job JSON, parsed ids) into `state/`,
which is gitignored. Safe to delete anytime between runs.
