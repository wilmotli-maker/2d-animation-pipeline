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

### Tier 2 — Clean macOS VM (real test)
Once Tier 1 passes, validate on an actual vanilla macOS install before calling it done.

**Why a VM, not a fresh local user on this Mac (decided 2026-09-05):**
A second local account on this machine can't do a *true* first-time install. Homebrew is already installed at `/opt/homebrew`, owned by `wilmotli:admin` and world-readable. For any other user that means brew is either on PATH (so the "no Homebrew" bootstrap branch never runs) or writable-into with the wrong owner (permission errors that a real onboarding user would never hit). Xcode CLI tools, cached git credentials, and system-wide state are shared too. A fresh account tests the *shell environment* but not the *machine state* — and the machine state is exactly what a new collaborator's Mac differs on. Only a clean VM gives us: no Homebrew, no Xcode CLI tools, no `node`/`uv`/`ffmpeg`, no GitHub auth, no inherited PATH.

**VM tooling (Apple Silicon host):**
- **Tart** (recommended) — `cirruslabs/tart`, a CLI wrapper over Apple's `Virtualization.framework`, purpose-built for scriptable/ephemeral macOS guests. `brew install cirruslabs/cli/tart`. Pull a vanilla image instead of hand-installing: `tart clone ghcr.io/cirruslabs/macos-sequoia-vanilla:latest anim-test`, then `tart run anim-test`. Cheap to reset — `tart delete` + re-clone gives a pristine box every run.
- **UTM** (GUI alternative) — free, App Store or `brew install --cask utm`. Install macOS from an IPSW via the Apple Virtualization backend. More clicking, no CLI reset loop, but no external image trust needed.
- **Licensing / limits:** Apple's macOS license permits up to **2 macOS VMs** on a single Apple-silicon Mac. VMs are Apple-silicon guests only — they cannot test an Intel Mac. Vanilla images from `cirruslabs` are convenient but third-party; if that's a concern, build the base yourself from an Apple IPSW in UTM.

**Setup (one-time, host):**
1. [ ] Install the VM tool: `brew install cirruslabs/cli/tart` (or the UTM cask).
2. [ ] Create the clean guest:
   - Tart: `tart clone ghcr.io/cirruslabs/macos-sequoia-vanilla:latest anim-test && tart run anim-test`
   - UTM: new macOS VM from IPSW, complete Setup Assistant, create one admin user.
3. [ ] Snapshot / keep the pristine image so each test run starts clean (Tart: keep the pulled image and `tart clone` a throwaway per run; UTM: duplicate the VM before first boot into the test).

**Test run (inside the VM — treat it as a brand-new collaborator's Mac):**
4. [ ] Confirm the box really is clean: `which brew node uv ffmpeg git` should mostly miss. A first `git`/`clang` invocation should trigger the **Xcode Command Line Tools** prompt — note whether onboarding needs it before anything else works.
5. [ ] Get the repo (private, so this exercises the real auth wall the way a collaborator hits it):
   `git clone -b feat/install-script-and-test-harness https://github.com/wilmotli-maker/2d-animation-pipeline.git ~/anim-pipeline`
   - **Private-repo auth:** the repo is private; collaborators are added by GitHub username (Settings → Collaborators — note personal-repo collaborators get *write* access; there's no read-only role without moving the repo to an Org). Authenticate the clone one of: `gh auth login` (browser flow, easiest), HTTPS + a Personal Access Token as the password, or an SSH key added to the account (clone the `git@github.com:` URL). Do the same in the VM so you hit the exact step collaborators will.
6. [ ] `cd ~/anim-pipeline && ./scripts/install.sh` (must run from inside the repo — it locates the workspace from its own path). This is the real test: does the "Homebrew not found" branch bootstrap brew (or guide the user to), and does the rest — `npm install`/`npm link`, model fetch, ffmpeg/uv/whisper deps — complete on a machine that started with none of it?
7. [ ] Do the printed manual steps: Higgsfield `auth login` + `workspace set`, Claude access.
8. [ ] `npm run check-auth` — confirm all green.
9. [ ] Record **every** manual fix or undocumented step the run required → feed it back into `install.sh` or the docs. The whole point of the clean VM is to surface these.
10. [ ] Reset for the next iteration: `tart delete anim-test` and re-clone (or revert the UTM VM to its pre-test snapshot) so fixes are validated against a truly fresh box, not a half-configured one.

## Definition of done
- [ ] Docker run: install succeeds clean, and succeeds again on re-run (idempotent).
- [ ] Clean-VM run: install succeeds following only the written instructions on a box with no Homebrew/Xcode-CLI/node/auth, no manual fixes.
- [ ] Any manual fix needed during the VM run gets fed back into the install script or docs, then re-validated against a freshly-reset VM.

## Status
- Install script drafted: `scripts/install.sh` (idempotent; `--skip-brew` for Docker tier-1, `--yes` for CI, `--skip-models` to skip the ~1.3 GB fetch). Syntax-checked but NOT yet run end-to-end.
- Next session: run tier-1 (Docker, `--skip-brew`) then tier-2 (clean macOS VM per above).
- Held until tier-2 passes: (1) open the PR for `scripts/install.sh`, (2) update README Setup to lead with `./scripts/install.sh`.
