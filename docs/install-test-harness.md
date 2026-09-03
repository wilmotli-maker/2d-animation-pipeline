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

### Tier 2 — Fresh macOS local user account (real test)
Once Tier 1 passes, validate on an actual clean-ish macOS environment before calling it done.

**What this Mac's Homebrew state means for the test (checked 2026-09-03):**
Homebrew is already installed at `/opt/homebrew`, owned by `wilmotli:admin`, world-readable/executable. Consequences for a fresh `testuser`:
- Brew exists on disk and is runnable, but `/opt/homebrew/bin` is **not** on a fresh user's default PATH (Apple-silicon brew isn't in `path_helper`; it's normally added by `eval "$(/opt/homebrew/bin/brew shellenv)"` in the user's profile). So `install.sh` will report **"Homebrew not found"** for `testuser` until they run that shellenv line — a realistic onboarding gotcha worth watching.
- Even with brew on PATH, `brew install` writes under `/opt/homebrew`, which is owned by `wilmotli` and not group-writable → package installs may hit permission errors for a different user.
- **Therefore this Mac cannot cleanly test the true first-time Homebrew bootstrap.** For that specific path, use a VM (UTM/Tart, vanilla macOS image). The fresh-user run still validates everything else: repo clone, the `npm install`/`npm link` workspace logic, non-brew branches, and the manual-auth flow.

**Checklist:**
1. [ ] Create the test user (from your admin account):
   `sudo sysadminctl -addUser testuser -fullName "Install Test" -password - -admin`
2. [ ] **GUI login** as `testuser` (log out or Fast User Switching — NOT `su`; the point is a fresh shell with no inherited `.zshrc`, PATH, or cached credentials).
3. [ ] Get the repo: `git clone <repo-url> ~/anim-pipeline`
   - Note whether this triggers a git/Xcode-CLI-tools prompt or a GitHub auth wall — that's part of onboarding. (Shortcut if you don't want to test cloning: `cp -R` the repo into `~testuser` instead, but that hides a real step.)
4. [ ] `cd ~/anim-pipeline && ./scripts/install.sh` (must be run from inside the repo — it locates the workspace from its own path).
5. [ ] Observe: does it get past the Homebrew check? (See the state note above — likely reports "not found"; decide whether to run `eval "$(/opt/homebrew/bin/brew shellenv)"` and retry, or accept that VM is needed for the true bootstrap.)
6. [ ] Do the printed manual steps: Higgsfield `auth login` + `workspace set`, Claude access.
7. [ ] `npm run check-auth` — confirm all green.
8. [ ] Record any manual fix you had to make → feed it back into `install.sh` or the docs.
9. [ ] Clean up (from admin account): `sudo sysadminctl -deleteUser testuser`

## Definition of done
- [ ] Docker run: install succeeds clean, and succeeds again on re-run (idempotent).
- [ ] Fresh-user Mac run: install succeeds following only the written instructions, no manual fixes.
- [ ] Any manual fix needed during the fresh-user run gets fed back into the install script or docs.

## Status
- Install script drafted: `scripts/install.sh` (idempotent; `--skip-brew` for Docker tier-1, `--yes` for CI, `--skip-models` to skip the ~1.3 GB fetch). Syntax-checked but NOT yet run end-to-end.
- Next session: run tier-1 (Docker, `--skip-brew`) then tier-2 (fresh macOS user).
- Held until tier-2 passes: (1) open the PR for `scripts/install.sh`, (2) update README Setup to lead with `./scripts/install.sh`.
