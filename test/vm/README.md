# Tier-2 install test (clean macOS VM)

Automated, repeatable version of the "clean macOS VM" checklist in
[`docs/install-test-harness.md`](../../docs/install-test-harness.md). It boots a
throwaway vanilla-macOS VM with [Tart](https://tart.run) and runs
`scripts/install.sh` end-to-end on a machine that starts with **no Homebrew, no
Node, no ffmpeg/uv, and no cached auth** — the state a new collaborator's Mac is
actually in.

Works from any clone: clone the repo anywhere and run the script from its root.

## Run

```bash
./test/vm/run-tier2.sh          # full clean run, then delete the VM
./test/vm/run-tier2.sh --keep   # leave the VM up afterwards to poke around
./test/vm/run-tier2.sh --yes    # non-interactive (CI / unattended)
```

Requirements (host): **Apple Silicon Mac + Homebrew**. The script installs Tart
and `sshpass` via brew on first run (prompts unless `--yes`). The first
`tart clone` downloads a ~25–40 GB base image; later runs reuse it.

Useful flags: `--reuse` (skip clone/boot, reuse an existing VM), `--with-models`
(include the ~1.3 GB model fetch — off by default for speed), `--image <ref>`,
`--name <vm>`. See `--help`.

## What it checks

`run-tier2.sh` (host) provisions the VM, syncs this working tree into it, and
runs `provision.sh` (guest), which asserts, in order:

- **A** the box is genuinely bare (brew/node/uv/ffmpeg absent),
- **B** `install.sh` on a brew-less box **fails loudly** with the actionable
  "Homebrew not found" message (it deliberately doesn't auto-install brew),
- **C** Homebrew bootstraps non-interactively (what the human then does),
- **D** `install.sh` now **succeeds** and installs the deps,
- **E** a second `install.sh` run also succeeds (idempotent),
- **F** `pipeline init` scaffolds a project (`CLAUDE.md` present).

A green run ends with `TIER-2 PASS`.

## What it does NOT cover

The account/browser steps — Higgsfield `auth login` + `workspace set`, Claude
access, `npm run check-auth` — need a human and personal credentials. Do those by
hand (use `--keep` and SSH in, or the printed IP) to finish a full onboarding
dry-run.
