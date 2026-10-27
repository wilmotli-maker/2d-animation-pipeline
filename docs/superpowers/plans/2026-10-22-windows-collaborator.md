# Windows Collaborator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A collaborator on a normal Windows install can install this repo, open the existing UIs, and generate shots from Claude Code with the template skills.

**Architecture:** Keep the Mac bash installer. Add a PowerShell installer for winget packages plus a pinned whisper.cpp binary. Launch the Higgsfield CLI as `node` plus its JavaScript entry on every platform, so generation never goes through a Windows `.cmd` shim or a shell. Port the auth preflight to Node and make missing-tool errors name the install command for the platform they are running on.

**Tech Stack:** Node.js 20 ESM, `node:test`, PowerShell, winget, GitHub Actions `windows-latest`.

**Spec:** `docs/superpowers/specs/2026-10-22-windows-collaborator-design.md`

## Global Constraints

- Node.js 20, the major `.github/workflows/ci.yml` already uses.
- System packages come from winget. Agreements are accepted with winget's own flags (`--accept-package-agreements --accept-source-agreements`). The script does not change the user's PowerShell execution policy; the README launches it with `-ExecutionPolicy Bypass`.
- No `shell: true` when spawning the Higgsfield CLI or any other tool with user-authored arguments (prompts, paths). Windows `.cmd` shims are not the launch path.
- Text files stay LF in the repo. A Windows checkout with Git's default `core.autocrlf=true` must not rewrite the tree or produce CRLF commits.
- Missing-tool errors name an install command for the platform they are running on. Linux and macOS keep a Homebrew example. Windows names the winget id (or, for whisper, the installer script).
- Do not rewrite `scripts/sanity-checks/*.sh`, `test/vm/`, `test/docker/`, or `scripts/eval/`.
- Do not spend Higgsfield credits, and do not install ffmpeg, whisper, or winget packages on the CI runner.

## Review Focus

- A shot prompt or file path containing `&` or `|` is passed to Higgsfield. The CLI receives that string as one argument.
- The seedance-stitch skill's WaveSpeed step is a bash `export "$(...)"`. PowerShell runs the printed `uv run python` command after `pipeline wavespeed-key` has been used to set `WAVESPEED_API_KEY`.
- A missing matte or whisper model prints a download line. Pasted into PowerShell, that line invokes `curl.exe`, not the `curl` alias.
- `node` is installed but is not major 20. The installer still installs Node 20.
- `ffmpeg` is on PATH and `ffprobe` is not. The installer still installs `Gyan.FFmpeg`.

---

### Task 1: Platform install hints

**Files:**
- Create: `src/platform.js`
- Create: `test/platform.test.js`
- Modify: `src/matte.js` (both ENOENT throws, and the model-missing `curl -L` line)
- Modify: `src/transcribe.js` (ENOENT throw, and the model-missing `curl -L` line)
- Modify: `src/speechclip.js` (`defaultRun` ENOENT throw)
- Modify: `src/edit-ui/flow-morph.js` (ENOENT throw)
- Test: `test/platform.test.js`, existing `test/matte.test.js`, `test/transcribe.test.js`, `test/edit-ui-flow-morph.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `toolInstallHint(tool: 'uv' | 'ffmpeg' | 'whisper', platform?: NodeJS.Platform): string`
  - `curlDownloadLine(dest: string, url: string, platform?: NodeJS.Platform): string`

Exact `toolInstallHint` returns:

| tool | `win32` | any other platform |
| --- | --- | --- |
| `uv` | `winget install --id astral-sh.uv -e` | `brew install uv` |
| `ffmpeg` | `winget install --id Gyan.FFmpeg -e` | `brew install ffmpeg` |
| `whisper` | `re-run scripts/install.ps1, or set WHISPER_CPP_BIN` | `brew install whisper-cpp` |

Unknown `tool` throws. `curlDownloadLine` returns `` `${name} -L -o "${dest}" ${url}` `` where `name` is `curl.exe` on `win32` and `curl` otherwise.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toolInstallHint, curlDownloadLine } from '../src/platform.js';

test('toolInstallHint names winget on win32 and Homebrew elsewhere', () => {
  assert.equal(toolInstallHint('uv', 'win32'), 'winget install --id astral-sh.uv -e');
  assert.equal(toolInstallHint('uv', 'darwin'), 'brew install uv');
  assert.equal(toolInstallHint('uv', 'linux'), 'brew install uv');
  assert.equal(toolInstallHint('ffmpeg', 'win32'), 'winget install --id Gyan.FFmpeg -e');
  assert.equal(toolInstallHint('ffmpeg', 'linux'), 'brew install ffmpeg');
  assert.equal(toolInstallHint('whisper', 'win32'), 're-run scripts/install.ps1, or set WHISPER_CPP_BIN');
  assert.equal(toolInstallHint('whisper', 'darwin'), 'brew install whisper-cpp');
});

test('curlDownloadLine uses curl.exe on win32', () => {
  assert.equal(
    curlDownloadLine('C:\\models\\x.onnx', 'https://example.test/x', 'win32'),
    'curl.exe -L -o "C:\\models\\x.onnx" https://example.test/x',
  );
  assert.equal(
    curlDownloadLine('/tmp/x.onnx', 'https://example.test/x', 'linux'),
    'curl -L -o "/tmp/x.onnx" https://example.test/x',
  );
});

test('matte and transcribe build the download line through curlDownloadLine', () => {
  for (const file of ['src/matte.js', 'src/transcribe.js']) {
    assert.match(readFileSync(file, 'utf8'), /curlDownloadLine\(/);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/platform.test.js`
Expected: FAIL with `toolInstallHint` not exported (module missing).

- [ ] **Step 3: Implement the hints and use them at the four call sites**

`src/platform.js` exports the two functions above. Default `platform` is `process.platform`.

Replace only the install-command portion of each existing error. Keep the override clause and the rest of the sentence:

- `src/matte.js` both engines: `` install uv (\`${toolInstallHint('uv')}\`), or set MATTE_PYTHON `` / `PLATE_MATTE_DEPS` wording stays. Model-missing line uses `curlDownloadLine(weights, matteModelUrl(quality))` in place of the hand-built `` curl -L -o `` string. `npm run fetch-models` stays the first instruction.
- `src/transcribe.js`: the missing-binary sentence uses `toolInstallHint('whisper')`. On `win32` the hint already contains `or set WHISPER_CPP_BIN`, so do not append that clause a second time. On every other platform the sentence stays `install whisper.cpp (e.g. \`brew install whisper-cpp\`) or set WHISPER_CPP_BIN`. Model-missing line uses `curlDownloadLine(model, WHISPER_MODEL.url)`.
- `src/speechclip.js`: `` install ffmpeg (e.g. \`${toolInstallHint('ffmpeg')}\`) to use --speech-audio ``.
- `src/edit-ui/flow-morph.js`: swap the brew example for `toolInstallHint('uv')`. The substrings `FLOW_MORPH_PYTHON` and `EDIT_UI_MORPH=minterpolate` stay in that message.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/platform.test.js test/matte.test.js test/transcribe.test.js test/edit-ui-flow-morph.test.js`
Expected: PASS. The existing `/brew install uv|MATTE_PYTHON/` and `/brew install whisper-cpp|WHISPER_CPP_BIN/` assertions still match on this Mac.

- [ ] **Step 5: Commit**

```bash
git add src/platform.js test/platform.test.js src/matte.js src/transcribe.js src/speechclip.js src/edit-ui/flow-morph.js
git commit -m "fix: name the Windows install command when a tool is missing"
```

### Task 2: Launch Higgsfield through Node

**Files:**
- Modify: `src/config.js` (`higgsfieldBin`)
- Modify: `src/cli.js` (`defaultExec`, `inheritStderrExec`)
- Modify: `test/config.test.js`
- Modify: `test/cli.test.js`
- Test: `test/config.test.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `higgsfieldBin(root?: string): string` — `path.join(root, 'node_modules', '@higgsfield', 'cli', 'bin', 'higgsfield.js')`. Default `root` stays `REPO_ROOT`.
  - `resolveSpawn(bin: string, args: string[]): { bin: string, args: string[] }` from `src/cli.js`. A `bin` ending in `.js` returns `{ bin: process.execPath, args: [bin, ...args] }`. Any other `bin` returns `{ bin, args }` unchanged. The returned object has no `shell` field.

- [ ] **Step 1: Write the failing test**

Add to `test/config.test.js`:

```javascript
import { higgsfieldBin } from '../src/config.js';

test('higgsfieldBin points at the CLI JavaScript entry', () => {
  assert.equal(
    higgsfieldBin('/repo'),
    path.join('/repo', 'node_modules', '@higgsfield', 'cli', 'bin', 'higgsfield.js'),
  );
});
```

Add to `test/cli.test.js`:

```javascript
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSpawn, defaultExec } from '../src/cli.js';

test('resolveSpawn runs .js with node and leaves ffmpeg alone', () => {
  const js = resolveSpawn('/repo/higgsfield.js', ['model', 'list']);
  assert.deepEqual(js, { bin: process.execPath, args: ['/repo/higgsfield.js', 'model', 'list'] });
  assert.equal(Object.hasOwn(js, 'shell'), false);
  assert.deepEqual(resolveSpawn('ffmpeg', ['-version']), { bin: 'ffmpeg', args: ['-version'] });
});

test('defaultExec keeps a prompt with shell metacharacters as one argument', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hf-'));
  const script = path.join(dir, 'echo-args.js');
  await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  try {
    const res = await defaultExec(script, ['generate', 'create', 'm', '--prompt', 'a & b | c']);
    assert.equal(res.code, 0);
    assert.deepEqual(JSON.parse(res.stdout), ['generate', 'create', 'm', '--prompt', 'a & b | c']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js test/cli.test.js`
Expected: FAIL because `higgsfieldBin('/repo')` still ends in `node_modules/.bin/higgsfield`, and `resolveSpawn` is not exported.

- [ ] **Step 3: Implement `higgsfieldBin` and `resolveSpawn`**

Change `higgsfieldBin` to the path in the Interfaces block. Add `resolveSpawn` and call it at the start of `defaultExec` and `inheritStderrExec` before `execFile` / `spawn`. Do not pass `shell`. Do not duplicate the `.js` check inside either executor.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js test/cli.test.js`
Expected: PASS, including the existing runner tests.

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/cli.js test/config.test.js test/cli.test.js
git commit -m "fix: launch the Higgsfield CLI with node on every platform"
```

### Task 3: Node auth preflight

**Files:**
- Create: `scripts/check-auth.js`
- Create: `test/check-auth.test.js`
- Modify: `scripts/check-auth.sh` (replace the body)
- Modify: `package.json` (`"check-auth"` script)
- Test: `test/check-auth.test.js`

**Interfaces:**
- Consumes: `higgsfieldBin()` and `resolveSpawn(bin, args)` from Task 2.
- Produces: `checkAuth({ bin, exists, exec, env, claudeOnPath, log }): Promise<0 | 1>` exported from `scripts/check-auth.js`.
  - `exists(bin) => Promise<boolean>`
  - `exec(bin, args) => Promise<{ code: number, stdout: string, stderr: string }>` — called as `exec(bin, ['model', 'list'])` and `exec(bin, ['workspace', 'status'])`, where `bin` is the JavaScript entry. The real `main` wraps `exec` with `resolveSpawn` so the process is `node <entry>`. Tests pass a fake `exec` and must not spawn.
  - `claudeOnPath() => Promise<boolean>`
  - `log(line: string)` receives each printed line.

Behavior, matching `scripts/check-auth.sh`:

- Missing CLI (`exists` false): log includes `higgsfield CLI not found`, do not call `exec`, return 1.
- `model list` non-zero: log includes `not authenticated`, return 1. Do not call `workspace status`.
- `workspace status` non-zero: log includes `No billing workspace`, return 1.
- `workspace status` zero: log one `[info]` line that includes the stdout, even when that stdout contains `No workspace selected`. That case is not a failure.
- `ANTHROPIC_API_KEY` non-empty: log includes `ANTHROPIC_API_KEY`, do not call `claudeOnPath`.
- Otherwise `claudeOnPath()` true: log includes `claude CLI found`.
- Otherwise: log includes `Neither ANTHROPIC_API_KEY nor the claude CLI`, return 1.
- All passed: log includes `All auth checks passed.` and return 0. Any failure also logs `Fix the above`.
- Tags are the plain strings `[pass]`, `[fail]`, and `[info]`.

The real entry (`import.meta.url` equals `pathToFileURL(process.argv[1]).href`) calls `process.exit` with that code. `exists` uses `fs.access` on `higgsfieldBin()`. `claudeOnPath` spawns `claude` with `['--version']` and `shell` unset; ENOENT is false.

`package.json`: `"check-auth": "node scripts/check-auth.js"`.

`scripts/check-auth.sh` becomes:

```bash
#!/usr/bin/env bash
exec node "$(cd "$(dirname "$0")" && pwd)/check-auth.js"
```

- [ ] **Step 1: Write the failing test**

`test/check-auth.test.js` imports `checkAuth` from `../scripts/check-auth.js`. Each behavior bullet above is its own `test()`. Shared shape: `const log = []; const logs = (line) => log.push(line);`. Assert the returned number and `log.join('\n')`.

- Missing CLI: `exists: async () => false`, and `exec` throws if called. Code `1`. Log matches `/higgsfield CLI not found/` and `/Fix the above/`.
- `model list` returns `{ code: 1, stdout: '', stderr: 'login' }`. `exec` throws if the args are `['workspace', 'status']`. Code `1`. Log matches `/not authenticated/`.
- `workspace status` returns `{ code: 1, stdout: '', stderr: 'none' }` after a zero `model list`. Code `1`. Log matches `/No billing workspace/`.
- `workspace status` returns `{ code: 0, stdout: 'Private is_selected:true but No workspace selected', stderr: '' }` and `env` is `{ ANTHROPIC_API_KEY: 'sk-test' }`. Code `0`. Log includes that stdout and `All auth checks passed.` Log does not include `[fail]`.
- `ANTHROPIC_API_KEY: 'sk-test'` with a passing Higgsfield fake. `claudeOnPath` throws if called. Code `0`. Log matches `/ANTHROPIC_API_KEY/`.
- `env` is `{}` and `claudeOnPath: async () => true`. Code `0`. Log matches `/claude CLI found/`.
- `env` is `{}` and `claudeOnPath: async () => false`. Code `1`. Log matches `/Neither ANTHROPIC_API_KEY nor the claude CLI/`.

Also read the entry points:

```javascript
test('npm check-auth does not call bash, and the shell script only execs node', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts['check-auth'], 'node scripts/check-auth.js');
  const sh = readFileSync('scripts/check-auth.sh', 'utf8');
  assert.match(sh, /exec node "\$\(cd "\$\(dirname "\$0"\)" && pwd\)\/check-auth\.js"/);
  assert.equal(sh.includes('higgsfield model list'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/check-auth.test.js`
Expected: FAIL because `scripts/check-auth.js` does not exist.

- [ ] **Step 3: Implement `checkAuth`, the package script, and the bash forwarder**

Follow the Interfaces block. The real executor uses `execFile` on `resolveSpawn(bin, args)` with no `shell` and the same `{ code, stdout, stderr }` shape as `defaultExec`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/check-auth.test.js`
Expected: PASS, and no network calls.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-auth.js scripts/check-auth.sh test/check-auth.test.js package.json
git commit -m "fix: run the auth preflight without bash"
```

### Task 4: Seedance-stitch commands Windows can run

**Files:**
- Modify: `templates/skills/seedance-stitch/SKILL.md`
- Modify: `templates/skills/seedance-stitch/README.md`
- Create: `test/seedance-stitch-skill.test.js`
- Test: `test/seedance-stitch-skill.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: the two markdown files, with these commands in place of every `python3` invocation:
  - `uv run --with numpy --with opencv-python-headless python templates/skills/seedance-stitch/scripts/stitch.py prep A.mp4 B.mp4 --out JOBDIR`
  - `uv run --with numpy --with opencv-python-headless python templates/skills/seedance-stitch/scripts/stitch.py assemble JOBDIR --bridge JOBDIR/bridge.mp4 --morph 8`
  - `uv run python scripts/vace_join.py A.mp4 B.mp4 --pushin 1.7 --out JOBDIR/vace/joined.mp4`
  - `uv run python scripts/vace_join.py A.mp4 B.mp4 --out JOBDIR/vace/joined.mp4`

Leave the `#!/usr/bin/env python3` shebangs in the `.py` files. Do not change `vace_join.py`'s `curl` argv.

Replace the bash key line `export WAVESPEED_API_KEY="$(pipeline wavespeed-key)"` with prose: set `WAVESPEED_API_KEY` from the value `pipeline wavespeed-key` prints (`.env`, then the home-directory `.wavespeed/key` file) before the `uv run python` command. A bare interpreter does not load `.env`. Delete both prose mentions of a bare `` `python3` `` in `SKILL.md` and the one in `README.md`.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const skill = readFileSync('templates/skills/seedance-stitch/SKILL.md', 'utf8');
const readme = readFileSync('templates/skills/seedance-stitch/README.md', 'utf8');

test('seedance-stitch docs do not tell Claude to run python3 or a bash export', () => {
  for (const text of [skill, readme]) {
    assert.equal(text.includes('python3 '), false);
    assert.equal(text.includes('export WAVESPEED_API_KEY="$(pipeline wavespeed-key)"'), false);
  }
});

test('stitch.py goes through uv with numpy and opencv', () => {
  const cmd = 'uv run --with numpy --with opencv-python-headless python templates/skills/seedance-stitch/scripts/stitch.py';
  assert.equal(skill.includes(`${cmd} prep A.mp4 B.mp4 --out JOBDIR`), true);
  assert.equal(skill.includes(`${cmd} assemble JOBDIR --bridge JOBDIR/bridge.mp4 --morph 8`), true);
});

test('vace_join.py goes through uv run python', () => {
  assert.equal(skill.includes('uv run python scripts/vace_join.py A.mp4 B.mp4 --pushin 1.7 --out JOBDIR/vace/joined.mp4'), true);
  assert.equal(skill.includes('uv run python scripts/vace_join.py A.mp4 B.mp4 --out JOBDIR/vace/joined.mp4'), true);
  assert.equal(skill.includes('pipeline wavespeed-key'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/seedance-stitch-skill.test.js`
Expected: FAIL because `SKILL.md` still contains `python3 `.

- [ ] **Step 3: Update the two markdown files**

Apply the replacements in the Interfaces block. Do not edit the Python scripts.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/seedance-stitch-skill.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/skills/seedance-stitch/SKILL.md templates/skills/seedance-stitch/README.md test/seedance-stitch-skill.test.js
git commit -m "fix: invoke seedance-stitch through uv so Windows can run it"
```

### Task 5: PowerShell installer

**Files:**
- Create: `scripts/install.ps1`
- Create: `test/install-ps1.test.js`
- Modify: `scripts/install.sh` (one warning line in the non-macOS branch, about lines 52–55)
- Test: `test/install-ps1.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks. `npm install` still runs `scripts/fetch-models.js`.
- Produces: `scripts/install.ps1`, invoked as `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1`, with switches `-Yes`, `-SkipWinget`, `-SkipModels`.

Pinned constants at the top of the script:

- Node winget id `OpenJS.NodeJS.20`
- ffmpeg id `Gyan.FFmpeg` (provides `ffmpeg` and `ffprobe`)
- uv id `astral-sh.uv`
- git id `Git.Git`
- `$WhisperZipUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.5/whisper-bin-x64.zip'`
- Extracted binary: `Join-Path $env:LOCALAPPDATA '2d-animation-pipeline\bin\whisper-cli.exe'`

Behavior:

- Idempotent. A probe that already succeeds skips that install.
- Node probe runs `node -p "process.versions.node"` and succeeds only when the major component is `20`. Missing `node`, or any other major, installs `OpenJS.NodeJS.20`.
- ffmpeg probe succeeds only when both `ffmpeg` and `ffprobe` resolve. Either missing installs `Gyan.FFmpeg`.
- Every `winget install` uses `--id <id> -e --accept-package-agreements --accept-source-agreements` and tries `--scope user` first. A user-scope refusal is retried once without `--scope user`. A second failure is recorded and the script continues.
- `-SkipWinget` skips every winget install and the whisper download. A missing required probe is then a recorded failure, same idea as `--skip-brew`.
- Whisper: if `Get-Command whisper-cli` succeeds, do nothing. Otherwise download the pinned zip, copy `whisper-cli.exe` out of whatever folder the zip nests it in, and append the bin directory to the user `Path` only when `GetEnvironmentVariable('Path', 'User')` does not already contain that directory.
- `-SkipModels` sets `SKIP_MODEL_DOWNLOAD=1` for `npm install`.
- `npm install` failure is a hard failure. `npm link` failure is a warning that names `npm run pipeline --` and `node bin/pipeline.js`. It does not by itself make the script fail.
- End text matches `install.sh`: Higgsfield `auth login`, `workspace list` / `workspace set`, Claude Code when neither `ANTHROPIC_API_KEY` nor `claude` is present, then `npm run check-auth`.
- `-Yes` does not prompt. There is nothing to confirm today; accept the switch so the flag exists.

`scripts/install.sh`, inside the existing `OS != Darwin` warning, adds:

```bash
warn "On Windows, run: powershell -ExecutionPolicy Bypass -File scripts/install.ps1"
```

- [ ] **Step 1: Write the failing test**

`test/install-ps1.test.js` reads `scripts/install.ps1` and `scripts/install.sh` as text.

```javascript
test('install.ps1 pins the winget ids, Node 20, ffprobe, and whisper', () => {
  const ps1 = readFileSync('scripts/install.ps1', 'utf8');
  for (const needle of [
    'OpenJS.NodeJS.20',
    'Gyan.FFmpeg',
    'astral-sh.uv',
    'Git.Git',
    'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.5/whisper-bin-x64.zip',
    '2d-animation-pipeline',
    'LOCALAPPDATA',
    '[switch]$Yes',
    '[switch]$SkipWinget',
    '[switch]$SkipModels',
    'ffprobe',
    'process.versions.node',
    "Get-Command whisper-cli",
    "GetEnvironmentVariable('Path', 'User')",
    'npm run pipeline --',
    'npm run check-auth',
  ]) {
    assert.equal(ps1.includes(needle), true, needle);
  }
});

test('install.sh points Windows at the PowerShell installer', () => {
  const sh = readFileSync('scripts/install.sh', 'utf8');
  assert.equal(
    sh.includes('warn "On Windows, run: powershell -ExecutionPolicy Bypass -File scripts/install.ps1"'),
    true,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/install-ps1.test.js`
Expected: FAIL because `scripts/install.ps1` does not exist.

- [ ] **Step 3: Write `scripts/install.ps1` and the one `install.sh` line**

Before committing the whisper URL, confirm the asset exists:

Run: `curl -sI -o /dev/null -w "%{http_code}" https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.5/whisper-bin-x64.zip`
Expected: `200` or `302`. If both fail, use the newest `ggml-org/whisper.cpp` release whose `whisper-bin-x64.zip` returns a redirect, and put that tag in the constant and in the test.

Implement the behavior in the Interfaces block. Accumulate failures and exit 1 when any hard failure was recorded, exit 0 otherwise.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/install-ps1.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/install.ps1 scripts/install.sh test/install-ps1.test.js
git commit -m "feat: add a Windows installer beside the Mac one"
```

### Task 6: README setup for Windows

**Files:**
- Modify: `README.md` (the Setup section, starting at "Apple Silicon Mac assumed.")
- Modify: `web/README.md` (the optional server command)
- Create: `test/readme-windows.test.js`
- Test: `test/readme-windows.test.js`

**Interfaces:**
- Consumes: the installer command from Task 5, `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1`.
- Produces: a Setup section with two peer paths, macOS then Windows.

Replace the sentence `Apple Silicon Mac assumed.` with `macOS and Windows are both supported.` Keep the existing Mac steps under a `### macOS` heading; do not rewrite them.

Windows section, in this order:

1. The sentences `Git for Windows is enough.` and `WSL is not required.`
2. If `git` is missing: `winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements`
3. Clone into `%USERPROFILE%\anim-pipeline`. The command that a PowerShell reader runs is `git clone https://github.com/wilmotli-maker/2d-animation-pipeline.git "$env:USERPROFILE\anim-pipeline"`. The literal `%USERPROFILE%\anim-pipeline` appears in the prose so the path is recognizable in cmd too.
4. Run `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1` from the repo.
5. Open a new terminal so `%AppData%\npm` is on PATH (`npm link` writes `pipeline.cmd` there).
6. The same auth commands the Mac section already shows: `npm run higgsfield -- auth login`, `workspace list`, `workspace set`, `npm run check-auth`, `pipeline init`.
7. `pipeline sync-skills` in a project that was initialized before this change, so Claude Code picks up the updated skills.

`web/README.md`: replace `python3 -m http.server -d web 8000` with `uv run python -m http.server -d web 8000`. The sentence that says opening `index.html` directly works stays.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readme = readFileSync('README.md', 'utf8');
const web = readFileSync('web/README.md', 'utf8');

test('README documents a Windows install that does not need WSL', () => {
  assert.equal(readme.includes('Apple Silicon Mac assumed'), false);
  for (const needle of [
    'macOS and Windows are both supported.',
    'Git for Windows is enough.',
    'WSL is not required.',
    '%USERPROFILE%\\anim-pipeline',
    'powershell -ExecutionPolicy Bypass -File .\\scripts\\install.ps1',
    '%AppData%\\npm',
    'pipeline sync-skills',
  ]) {
    assert.equal(readme.includes(needle), true, needle);
  }
});

test('web README serves with uv', () => {
  assert.equal(web.includes('uv run python -m http.server -d web 8000'), true);
  assert.equal(web.includes('python3 -m http.server'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/readme-windows.test.js`
Expected: FAIL because the README still says `Apple Silicon Mac assumed`.

- [ ] **Step 3: Edit the two READMEs**

Follow the Interfaces block. Leave the command reference, concepts, and costs sections as they are.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/readme-windows.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add README.md web/README.md test/readme-windows.test.js
git commit -m "docs: add the Windows setup path to the README"
```

### Task 7: LF line endings

**Files:**
- Create: `.gitattributes`
- Test: `git check-attr` in the verification step

**Interfaces:**
- Consumes: nothing
- Produces: `.gitattributes` with `* text=auto eol=lf` and binary rules for `*.png`, `*.jpg`, `*.jpeg`, `*.webp`, `*.gif`, `*.mp4`, `*.mov`, `*.webm`, `*.wav`, `*.onnx`, `*.bin`.

- [ ] **Step 1: Write `.gitattributes` with those rules**

No separate failing unit test. The verification command is the test.

- [ ] **Step 2: Verify attributes**

Run: `git check-attr eol -- src/cli.js templates/skills/seedance-stitch/SKILL.md scripts/install.ps1`
Expected: each line ends with `eol: lf`.

Run: `git check-attr text -- web/matte-best-vs-fast/index.html`
Expected: `web/matte-best-vs-fast/index.html: text: auto`

Do not mark HTML binary.

Do not run `git add --renormalize`. Adding the attributes file is the whole change.

- [ ] **Step 3: Commit**

```bash
git add .gitattributes
git commit -m "fix: keep text files LF so a Windows checkout does not rewrite them"
```

### Task 8: Windows CI job

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `test/windows-ci.test.js`
- Test: `test/windows-ci.test.js`

**Interfaces:**
- Consumes: the test files from Tasks 1–7, which `npm test` already picks up.
- Produces: a second job, `test-windows`, `runs-on: windows-latest`. Same `env.SKIP_MODEL_DOWNLOAD`, `actions/setup-node@v4` with `node-version: "20"`, `npm ci`, `npm test`, `astral-sh/setup-uv@v5` with `enable-cache: false`, and `npm run test:py` as the Ubuntu job. The job does not mention `install.ps1`, `winget`, `ffmpeg`, or `whisper`.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('CI runs the unit tests on windows-latest', () => {
  const yml = readFileSync('.github/workflows/ci.yml', 'utf8');
  const jobs = yml.split(/^ {2}\S/m).filter((block) => block.includes('windows-latest'));
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  for (const needle of [
    'runs-on: windows-latest',
    'SKIP_MODEL_DOWNLOAD: "1"',
    'node-version: "20"',
    'npm ci',
    'npm test',
    'astral-sh/setup-uv@v5',
    'enable-cache: false',
    'npm run test:py',
  ]) {
    assert.equal(job.includes(needle), true, needle);
  }
  for (const absent of ['install.ps1', 'winget', 'ffmpeg', 'whisper']) {
    assert.equal(job.includes(absent), false, absent);
  }
});
```

The `split` above is fragile if the job key is not indented two spaces. Structure the workflow so the Windows job is a sibling of `test:` at two-space indent, and put `SKIP_MODEL_DOWNLOAD` on that job's own `env:` (the workflow-level env does not exist today; each job has its own).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/windows-ci.test.js`
Expected: FAIL because no block contains `windows-latest`.

- [ ] **Step 3: Add the `test-windows` job**

Copy the Ubuntu job's steps. Set `runs-on: windows-latest`. Give the job its own `env:`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/windows-ci.test.js && npm test`
Expected: PASS. `npm test` is the full local suite, still on this Mac.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml test/windows-ci.test.js
git commit -m "ci: run unit tests on Windows"
```

The spec's acceptance steps (install on a Windows machine, log in, generate a shot, open studio and the edit UI, open a review page) are not a task. This repo is edited on a Mac, and those steps spend nothing in CI. Leave them for the collaborator. Do not claim they passed from the Mac test run.
