# Tier-2 install test (clean macOS VM)

Automated, repeatable clean-macOS-VM test of the installer. It boots a
throwaway macOS VM with [Tart](https://tart.run) and runs `scripts/install.sh`
end-to-end on a machine that starts with **no Node, no ffmpeg/uv, and no cached
auth** — the state a new collaborator's Mac is close to.

**Image choice:** it uses the cirruslabs `-base` image, not `-vanilla`. The
truly-vanilla image has no admin user and no Remote Login, so it can't be driven
headlessly — you'd have to click through Setup Assistant by hand. The `-base`
image ships `admin`/`admin` + SSH + Xcode CLT (and Homebrew). `node`/`uv`/`ffmpeg`
are still absent, so the installer's package step runs for real; and the
"no Homebrew" failure path is still covered by running `install.sh` once with
brew stripped from `PATH` (phase B below).

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

- **A** environment check (node/uv/ffmpeg absent; brew present on the base image),
- **B** `install.sh` with brew hidden from `PATH` **fails loudly** with the
  actionable "Homebrew not found" message (it deliberately doesn't auto-install brew),
- **C** Homebrew is available (present on base, or bootstrapped otherwise),
- **D** `install.sh` **succeeds** and installs the deps,
- **E** a second `install.sh` run also succeeds (idempotent),
- **F** `pipeline init` scaffolds a project (`CLAUDE.md` present).

A green run ends with `TIER-2 PASS`.

## Troubleshooting

**VM boots and gets an IP, but SSH never comes up / "No route to host" on ping.**
On macOS 15+ and 26 this is almost always the **Local Network privacy block**.
The system DHCP daemon still gives the guest an IP (so `tart ip` works), but
direct host→guest packets from the app that launched `tart` are dropped until
that app is granted access under **System Settings → Privacy & Security → Local
Network**. Grant it to whatever runs the script (Terminal, iTerm, or the Claude
app), then re-run. If that isn't it, try Softnet networking:
`sudo tart run --net-softnet <vm>` (needs sudo), or bridged: `--net-bridged en0`.

To watch what the VM is actually doing, boot it with a screen:
`tart run <vm>` (built-in UI) or `tart run --vnc <vm>` (Screen Sharing URL).

## What it does NOT cover

The account/browser steps — Higgsfield `auth login` + `workspace set`, Claude
access, `npm run check-auth` — need a human and personal credentials. Do those by
hand (use `--keep` and SSH in, or the printed IP) to finish a full onboarding
dry-run.
