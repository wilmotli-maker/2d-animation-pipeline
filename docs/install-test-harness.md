# Install Test Harness Plan

Goal: make the install process installable by someone else on a Mac they haven't touched before, with minimal hand-holding.

## Two-tier testing strategy

### Tier 1 — Docker (fast iteration)
Use a clean Linux container to quickly validate install *logic*: dependency resolution order, missing-dependency error messages, file layout, idempotency (running install twice doesn't break anything).

- Fast to spin up/tear down, good for tight edit-test loops while developing the install script.
- **Caveat:** this does NOT validate macOS-specific behavior — Homebrew, Xcode CLI tools, macOS file paths (`~/Library/...`), Gatekeeper/codesigning, or GUI app installs. A pass in Docker is necessary but not sufficient.

Files: `test/docker/Dockerfile` + `test/docker/entrypoint.sh`. The image (node:24 base + uv + ffmpeg; whisper-cpp deliberately omitted to exercise the optional-missing branch) mounts the live repo read-only, stages a clean copy, and runs `install.sh --skip-brew --skip-models --yes` twice (idempotency) plus a `pipeline --help` smoke test and `npm test`.

Run (from repo root):
```
docker build -f test/docker/Dockerfile -t anim-install-test .
docker run --rm -v "$PWD":/src:ro anim-install-test
```
Expect a final `TIER-1 PASS` line. Nothing writes back to the host.

- [x] Dockerfile + entrypoint written and syntax-checked.
- [x] Built + run: **TIER-1 PASS** — both install runs exit 0 (idempotent), `pipeline init` smoke test OK, `npm test` OK.
  - Shakedown found one bug (in the test, not the installer): the smoke check used `pipeline --help`, which isn't a real subcommand (bare/invalid args print usage and exit 1). Fixed to use `pipeline init`.
  - Confirmed correct: under non-root, `npm link` hits EACCES on the global prefix and the installer *warns* rather than dying (mirrors a Mac user without global-npm write access).
- [ ] Next: tier-2 fresh macOS user run.

### Tier 2 — Clean macOS VM (real test) — ✅ PASSED 2026-09-05
Automated and repeatable: [`test/vm/run-tier2.sh`](../test/vm/run-tier2.sh) (see
[`test/vm/README.md`](../test/vm/README.md)). It boots a throwaway macOS VM with
Tart, rsyncs the working tree in, and runs `provision.sh` inside it. **First full
run passed** — `install.sh` bootstraps and installs cleanly on a bare box.

**Why a VM, not a fresh local user on this Mac:** a second local account can't do a
*true* first-time install — this Mac's Homebrew is already installed at
`/opt/homebrew` owned by `wilmotli`, so the "no Homebrew" branch never runs cleanly
and package installs hit wrong-owner permission errors. Xcode CLI tools, cached git
creds, and system state are shared too. Only a clean VM gives us no Homebrew, no
`node`/`uv`/`ffmpeg`, no GitHub auth, no inherited PATH.

**What the harness validates (phases A–F):** bare box → `install.sh` fails loudly
with no brew → Homebrew bootstraps non-interactively → `install.sh` installs the
deps and links `pipeline` → idempotent re-run → `pipeline init` smoke test.

**Findings from building it (all now handled by the harness):**
- Homebrew 6 refuses untrusted third-party taps → the harness runs `brew trust --tap`
  for `cirruslabs/cli` and `hudochenkov/sshpass` before installing Tart/sshpass.
- The cirruslabs **`-vanilla`** image has no admin user and no SSH — it can't be driven
  headlessly. Use **`-base`** (ships `admin`/`admin` + SSH + Xcode CLT). On our run it
  also had **no Homebrew/node/uv/ffmpeg**, so it's a genuine clean box; the "no brew"
  UX is covered by running `install.sh` once with brew stripped from `PATH`.
- **macOS 15+/26 Local Network privacy:** the app running `tart` must be granted
  System Settings → Privacy & Security → Local Network, or host→guest traffic is
  silently dropped ("No route to host") even though the VM boots and gets a DHCP lease.
  A one-time GUI grant; see the harness README's Troubleshooting.

**Not automated (needs real accounts):** Higgsfield `auth login` + `workspace set`,
Claude access, `npm run check-auth`. Run these by hand over SSH (`--keep` leaves the
VM up) to finish a full onboarding dry-run.

## Definition of done
- [x] Docker run: install succeeds clean, and succeeds again on re-run (idempotent).
- [x] Clean-VM run: install succeeds on a box with no Homebrew/node/auth (automated, phases A–F).
- [x] Findings from the VM run fed back into the harness (tap trust, base image, Local Network).

## Status
- **Both tiers pass.** Tier-1 (Docker) and tier-2 (clean macOS VM, `test/vm/`) are green.
- `scripts/install.sh` is validated end-to-end; the PR and README-leads-with-install
  follow-ups are done (README Setup now leads with `./scripts/install.sh`).
