import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Repo root = one level up from src/. Stable regardless of CWD. This is the
// TOOL's own clone — used to locate the workspace-local CLI binary, NOT to store
// user data. Distinct from projectRoot() below.
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

// Where the USER's project data (elements/, shots/, style-locks, generated
// artifacts) lives — their data, kept separate from the tooling. Resolution
// order: explicit argument > ANIMATION_PIPELINE_ROOT env var > current directory.
// Defaulting to CWD means a user runs `pipeline` from inside their project and
// the data lands there, the way git or npm behave — one install, many projects.
export function projectRoot(explicit) {
  return path.resolve(explicit || process.env.ANIMATION_PIPELINE_ROOT || process.cwd());
}

// The four element categories from the handoff doc. Any other value is rejected
// by createElement so typos don't silently create a fifth category.
export const ELEMENT_TYPES = ['characters', 'props', 'scenes', 'other'];

// Prefer the workspace-local CLI binary over anything global. This mirrors the
// PATH logic in scripts/sanity-checks/lib.sh.
export function higgsfieldBin(root = REPO_ROOT) {
  return path.join(root, 'node_modules', '.bin', 'higgsfield');
}

// whisper.cpp binary for local speech-to-text. Not bundled — resolved from
// WHISPER_CPP_BIN, else `whisper-cli` on PATH (install via `brew install
// whisper-cpp`). A missing binary is reported with an install hint at call time.
export function whisperBin() {
  return process.env.WHISPER_CPP_BIN || 'whisper-cli';
}

// The ggml model file whisper.cpp loads. Precedence: explicit (--model-file) >
// WHISPER_CPP_MODEL env > a default under the tool's own models/ dir. Model files
// are not auto-downloaded; a missing one is reported with a download command.
export function whisperModelPath(explicit, root = REPO_ROOT) {
  return explicit || process.env.WHISPER_CPP_MODEL || path.join(root, 'models', 'ggml-base.en.bin');
}

// --- shot matte ----------------------------------------------------------

// BiRefNet-DIS weights for `pipeline shot matte`. DIS is trained for
// fine-structure segmentation, which is why it was picked over five
// alternatives — see docs/plans/shot-matte-alpha.md §6. Same policy as the
// whisper model: ~930 MB, so it is downloaded rather than bundled, and a
// missing file is reported with the exact curl command.
export const MATTE_MODEL_URL =
  'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-DIS-epoch_590.onnx';

export function matteModelPath(explicit, root = REPO_ROOT) {
  return explicit || process.env.MATTE_MODEL || path.join(root, 'models', 'birefnet-dis.onnx');
}

export function matteScriptPath(root = REPO_ROOT) {
  return path.join(root, 'python', 'matte.py');
}

// Python packages the matte sidecar imports. Kept here (not in the script) so
// the uv invocation and the MATTE_PYTHON error message can't drift apart.
export const MATTE_DEPS = ['numpy', 'pillow', 'onnxruntime'];

// How to invoke the Python sidecar. Default is `uv run --with ...`, which
// resolves deps per-run with no venv for the user to manage. MATTE_PYTHON
// overrides with an interpreter that already has MATTE_DEPS importable — for
// CI, or for anyone who would rather not have uv fetch wheels each run.
export function matteRunner() {
  const explicit = process.env.MATTE_PYTHON;
  if (explicit) return { bin: explicit, prefixArgs: [] };
  return {
    bin: 'uv',
    prefixArgs: ['run', '--quiet', ...MATTE_DEPS.flatMap((d) => ['--with', d]), 'python'],
  };
}
