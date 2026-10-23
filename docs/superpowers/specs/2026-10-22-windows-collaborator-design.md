# Windows collaborator — design

## Intent

A collaborator on a normal Windows install (not WSL, not Git Bash) should be able to clone this repo and generate shots on their own machine. They use the UIs that already exist — studio, the edit UI, and review pages — and they drive the pipeline from Claude Code with the template skills (`shot-author`, `element-author`, `build-element`, and the other skills `pipeline init` copies in).

Today that fails before any shot is generated. Setup assumes an Apple Silicon Mac and Homebrew, and the process that actually calls Higgsfield is a Unix `node_modules/.bin` shim Windows will not run.

## Goals

- From a fresh Windows user account that has `winget`, one documented install leaves `node`, `ffmpeg`, `ffprobe`, `uv`, and `whisper-cli` available, dependencies installed, model weights downloaded, and `pipeline` on PATH.
- `npm run check-auth` runs the same preflight the Mac path runs, without bash.
- `pipeline init`, `pipeline studio`, `pipeline edit-ui`, and `pipeline review shots` start. Studio and the edit UI print a localhost URL. Review pages open as static HTML.
- Claude Code, pointed at an initialized project, can run the template skills through to `pipeline shot generate`. That call reaches the Higgsfield CLI.
- The Mac install (`scripts/install.sh`, Homebrew, `./scripts/check-auth.sh`) keeps working.
- `npm test` and `npm run test:py` pass on `windows-latest` in CI, with model downloads skipped, the same way they pass on Ubuntu.

## Non-goals

- WSL, Git Bash, or Cygwin as the supported way to work.
- Rewriting `scripts/sanity-checks/*.sh`, `test/vm/`, `test/docker/`, or the eval scripts under `scripts/eval/`.
- Spending Higgsfield credits in CI, or installing ffmpeg / whisper / winget packages on the CI runner.
- Changing generation backends, skill behavior, or the on-disk project layout.
- A signed installer, an MSI, or admin-free guarantees beyond what winget already offers.

## Constraints

- Node.js 20, the major `.github/workflows/ci.yml` already uses.
- System packages come from winget. Agreements are accepted with winget's own flags (`--accept-package-agreements --accept-source-agreements`). The script does not change the user's PowerShell execution policy; the README launches it with `-ExecutionPolicy Bypass`.
- No `shell: true` when spawning the Higgsfield CLI or any other tool with user-authored arguments (prompts, paths). Windows `.cmd` shims are not the launch path.
- Text files stay LF in the repo. A Windows checkout with Git's default `core.autocrlf=true` must not rewrite the tree or produce CRLF commits.
- Missing-tool errors name an install command for the platform they are running on. Linux and macOS keep a Homebrew example. Windows names the winget id (or, for whisper, the installer script).

## What already works

Leave these alone except where a section below names a change.

- Path handling uses Node `path` and `os.homedir()`. The edit UI workspace is `%USERPROFILE%\.pipeline\edit-ui`. `src/edit-ui/server.js` already reveals a file with `explorer` on `win32`.
- `ffmpeg`, `ffprobe`, `uv`, and `whisper-cli` are spawned by bare name with no shell. On Windows that resolves to the `.exe` via `PATHEXT`.
- Model weights are fetched by `scripts/fetch-models.js` (Node `fetch`) during `npm install`. `curl` in those error hints is a fallback, not the install path.
- `sharp` publishes Windows prebuilds. The Python sidecars (`python/matte.py`, `python/plate_matte.py`, `python/flow_morph.py`) are started by `uv`, which is an `.exe`.
- `@higgsfield/cli` declares `os: [darwin, linux, win32]` and its `bin/run.js` already selects `hf.exe` on `win32`. The pipeline never reaches that code on Windows today, because it execs the extensionless shim at `node_modules/.bin/higgsfield`.

## Decisions

1. **A PowerShell installer beside the bash one.** `scripts/install.ps1` mirrors `scripts/install.sh`: idempotent, accumulates failures, prints the human auth steps at the end. Mac users keep `scripts/install.sh`.
2. **Launch Higgsfield as Node plus the package's JS entry**, on every platform. `run.js` inside that entry already picks `hf` vs `hf.exe`.
3. **One Node preflight.** `npm run check-auth` runs `scripts/check-auth.js`. The bash script becomes a one-line exec of that Node script so `./scripts/check-auth.sh` still works on Mac.
4. **Install hints branch on `process.platform`.** Non-Windows keeps the current Homebrew wording so existing tests and Linux CI stay true. Windows gets winget wording.
5. **Seedance-stitch is invoked through `uv run python`**, not `python3`. Windows often has no `python3` on PATH. `uv` is already a required install.
6. **CI gains a `windows-latest` job** that repeats the Ubuntu job's `npm ci` (with `SKIP_MODEL_DOWNLOAD=1`), `npm test`, and `npm run test:py`. It does not run `install.ps1`.

## Components

### A. `scripts/install.ps1`

Run from the repo: `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1`.

Flags, matching the bash script's intent:

- `-Yes` — no prompts.
- `-SkipWinget` — do not install system packages (the `--skip-brew` analogue).
- `-SkipModels` — set `SKIP_MODEL_DOWNLOAD=1` for the npm install.

Steps, each skipped when the probe already succeeds:

| Need | Probe | winget id |
| --- | --- | --- |
| Git | `git` | `Git.Git` |
| Node.js 20 | `node`, and the major version is 20 | Node 20 package. Confirm the id at implementation (`OpenJS.NodeJS.20` if that id exists; otherwise pin `--version` on the OpenJS Node 20 feed). Do not install floating "latest". |
| ffmpeg and ffprobe | both on PATH | `Gyan.FFmpeg` |
| uv | `uv` | `astral-sh.uv` |
| whisper-cli | `whisper-cli` | not winget. Download a **pinned** `whisper-bin-x64.zip` from a current `ggml-org/whisper.cpp` GitHub release that contains `whisper-cli.exe`. The pin (tag + url) is a constant at the top of the script. |

whisper lands at `%LOCALAPPDATA%\2d-animation-pipeline\bin\whisper-cli.exe`. If `whisper-cli` is not already on PATH, append that directory to the **user** PATH. Do not commit the binary.

Then, in the repo: `npm install`, then `npm link`. A link that fails is a warning, not a hard failure: `node bin/pipeline.js` and `npm run pipeline --` remain the fallback, same as `install.sh`.

Prefer winget `--scope user` when the package supports it. If a package refuses without elevation, record the failure and the exact command, and continue. Re-running the script after the user fixes one gap must not redo work that already succeeded.

End by printing the same manual steps `install.sh` prints: `npm run higgsfield -- auth login`, `workspace list` / `workspace set`, and Claude Code if neither `ANTHROPIC_API_KEY` nor `claude` is present. Point at `npm run check-auth`.

`scripts/install.sh`, when it detects a non-macOS OS, adds one line telling the reader to use `scripts/install.ps1` on Windows. It does not grow a Windows implementation.

### B. README setup

`README.md` stops saying "Apple Silicon Mac assumed." Setup has two peer paths, Mac then Windows, with the same three beats: get the code, run the installer, authenticate.

Windows clone example uses `%USERPROFILE%\anim-pipeline`, not `~/anim-pipeline`. After install, say to open a new terminal so `%AppData%\npm` (where `npm link` puts `pipeline.cmd`) is on PATH. State that Git for Windows is enough; WSL is not required.

The rest of the README (concepts, command surface, costs) stays. Commands shown as `pipeline ...` are what the user types in PowerShell, cmd, or the Mac shell; they do not need bash.

`web/README.md`'s optional static server example becomes `uv run python -m http.server -d web 8000`, which works once `uv` is installed on either OS. Opening `index.html` directly remains the primary instruction.

### C. Higgsfield launch

`higgsfieldBin(root)` keeps returning a single file path. Change that path from `node_modules/.bin/higgsfield` to `node_modules/@higgsfield/cli/bin/higgsfield.js`.

`defaultExec` and `inheritStderrExec` in `src/cli.js`, when `bin` ends in `.js`, spawn `process.execPath` with `[bin, ...args]`. `uv`, `ffmpeg`, `ffprobe`, and `whisper-cli` are not `.js` and stay bare names.

This is the same process the shebang already starts on Mac (`node` → `higgsfield.js` → `run.js` → `hf`). stdout capture and the inherited-stderr executor keep their current contracts. Do not set `shell: true`.

`npm run higgsfield` stays as the documented auth command. npm's script runner already invokes the `.cmd` shim correctly; that path is not used for generation.

### D. `scripts/check-auth.js`

Port the behavior of `scripts/check-auth.sh` (Higgsfield present, `model list` succeeds, `workspace status` is informational when it succeeds and a hard failure when the status call itself errors, then Claude via `ANTHROPIC_API_KEY` or a `claude` executable). Resolve the CLI the same way section C does, so the preflight does not depend on bash or on `node_modules/.bin`.

Exit 0 when every check passed, exit 1 otherwise. Print the same `[pass]` / `[fail]` / `[info]` lines a person already knows from the shell script. `package.json` `"check-auth"` becomes `node scripts/check-auth.js`. `scripts/check-auth.sh` execs that Node script and nothing else.

### E. Missing-tool hints

One function, `toolInstallHint(tool, platform = process.platform)`, used by the ENOENT messages in:

- `src/matte.js` (both engines) — tool `uv`
- `src/edit-ui/flow-morph.js` — tool `uv`
- `src/speechclip.js` — tool `ffmpeg`
- `src/transcribe.js` — tool `whisper`

Wording:

| tool | `win32` | everything else |
| --- | --- | --- |
| uv | ``winget install --id astral-sh.uv -e`` | ``brew install uv`` |
| ffmpeg | ``winget install --id Gyan.FFmpeg -e`` | ``brew install ffmpeg`` |
| whisper | re-run `scripts/install.ps1`, or set `WHISPER_CPP_BIN` | ``brew install whisper-cpp`` |

The `MATTE_PYTHON` / `FLOW_MORPH_PYTHON` / `WHISPER_CPP_BIN` override clauses stay. Non-Windows strings must still match the existing assertions in `test/matte.test.js` and `test/transcribe.test.js`.

Model-missing hints that include a manual `curl -L` line (`src/matte.js`, `src/transcribe.js`) use `curl.exe` when `platform === 'win32'`, because PowerShell aliases `curl` to `Invoke-WebRequest`. `npm run fetch-models` remains the first instruction on every platform.

### F. Template skill commands

In `templates/skills/seedance-stitch/SKILL.md` and `templates/skills/seedance-stitch/README.md`, replace bare `python3 <script>` invocations with `uv run`:

- `stitch.py` needs numpy and cv2: `uv run --with numpy --with opencv-python-headless python <script> ...`
- `vace_join.py` is stdlib plus `curl`: `uv run python <script> ...`

`curl` stays a bare argv in `vace_join.py`. Windows resolves `curl.exe`; do not route it through PowerShell. `os.path.expanduser("~/.wavespeed/key")` already works on Windows. No other template skill shells out to `python3` or `brew`.

`pipeline sync-skills` is how an existing project picks this up. The design does not migrate projects by itself; the README Windows section says to run `pipeline sync-skills` in a project that was initialized before this change.

### G. Line endings

Add `.gitattributes`:

- `* text=auto eol=lf`
- binary: `*.png`, `*.jpg`, `*.jpeg`, `*.webp`, `*.gif`, `*.mp4`, `*.mov`, `*.webm`, `*.wav`, `*.onnx`, `*.bin`

No renormalize commit of existing files beyond what adding the attributes requires. Do not flip image or video bytes.

### H. CI

Add a `windows-latest` job to `.github/workflows/ci.yml` with the same steps and env as the Ubuntu job (`actions/setup-node` Node 20, `npm ci` under `SKIP_MODEL_DOWNLOAD=1`, `astral-sh/setup-uv`, `npm test`, `npm run test:py`).

## Tests

- `toolInstallHint('uv', 'win32')` returns the winget id string. `toolInstallHint('uv', 'darwin')` and `toolInstallHint('uv', 'linux')` return `brew install uv`. Same shape for `ffmpeg` and `whisper`.
- `higgsfieldBin(root)` equals `path.join(root, 'node_modules', '@higgsfield', 'cli', 'bin', 'higgsfield.js')`.
- A `.js` bin passed through the spawn resolver becomes `{ bin: process.execPath, args: [script, ...userArgs] }`. A bin of `ffmpeg` is unchanged.
- Existing matte and transcribe ENOENT tests still pass on Linux and macOS without a Windows runner.
- `scripts/check-auth.js` is unit-tested with an injected executor: missing CLI fails, `model list` failure fails, `workspace status` failure fails, a successful status is informational, Claude passes when `ANTHROPIC_API_KEY` is set and when the `claude` probe succeeds, and fails when both are absent. The test must not call the network.

## Acceptance

A collaborator on Windows 10 or 11 with `winget` can, from the README alone:

1. Clone the repo.
2. Run `scripts/install.ps1` to completion (re-run is safe).
3. Open a new terminal, log in to Higgsfield, set a workspace, and see `npm run check-auth` report the auth result rather than a bash error.
4. `pipeline init` a project, open that folder in Claude Code, and generate a shot with the shot-author skill.
5. Start `pipeline studio` and `pipeline edit-ui` and open the printed localhost URL.
6. Build a review page with `pipeline review shots` and open its HTML.

This repo is edited on a Mac. Steps 2–6 are verified by the collaborator (or a Windows machine), not by the Mac unit tests. CI on `windows-latest` covers the automated tests only.

## Left to the builder

- The exact whisper.cpp release tag and asset URL, pinned in `install.ps1`, chosen from a current `ggml-org/whisper.cpp` release whose `whisper-bin-x64.zip` contains `whisper-cli.exe`.
- The exact winget id string for Node.js 20, confirmed with `winget search` at implementation time. The major version is not free.
- Whether a given winget package accepts `--scope user`. Try user scope; on refusal, record the failure and continue.
