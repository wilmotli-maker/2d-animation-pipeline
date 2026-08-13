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

// Weights for `pipeline shot matte`, keyed by --quality. Same policy as the
// whisper model: downloaded rather than bundled, and a missing file is reported
// with the exact curl command.
//
//   fast — isnet-general-use. DEFAULT. 7.4x faster over a full corpus with no
//          structural regression: background cleanliness, interior integrity and
//          antenna presence all match `best` (zero missing-antenna frames across
//          990 AI_ALT2 frames, for both). Its matte is measurably wider — ~50%
//          more soft pixels, +20-43% edge-band pixels — which admits more plate
//          green on some shots. Reviewed side by side on all 13 ArtAI shots and
//          accepted as the default.
//   best — BiRefNet-DIS, trained for fine-structure segmentation and picked over
//          five alternatives (docs/plans/shot-matte-alpha.md §6). Tighter edges,
//          ~7x slower. The shipped ArtAI with-alpha/ set was matted with it, so
//          reproducing those exact files requires --quality best.
//
// Pre/post-processing differs per model and lives in python/matte.py under the
// same keys. It is NOT interchangeable: birefnet applies a sigmoid to its
// logits, isnet does not. Read any new model's recipe from the reference
// implementation rather than assuming it.
export const MATTE_MODELS = {
  best: {
    file: 'birefnet-dis.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-DIS-epoch_590.onnx',
  },
  fast: {
    file: 'isnet-general-use.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
  },
};
export const MATTE_DEFAULT_QUALITY = 'fast';

export function matteModelPath(explicit, quality = MATTE_DEFAULT_QUALITY, root = REPO_ROOT) {
  if (explicit) return explicit;
  // MATTE_MODEL pins one file and therefore ignores --quality; MATTE_MODEL_DIR
  // relocates the whole set (e.g. to ~/.u2net, where rembg downloads them).
  if (process.env.MATTE_MODEL) return process.env.MATTE_MODEL;
  const model = MATTE_MODELS[quality];
  if (!model) {
    throw new Error(
      `unknown matte quality "${quality}" (expected: ${Object.keys(MATTE_MODELS).join(', ')})`);
  }
  return path.join(process.env.MATTE_MODEL_DIR || path.join(root, 'models'), model.file);
}

export function matteModelUrl(quality = MATTE_DEFAULT_QUALITY) {
  return (MATTE_MODELS[quality] || MATTE_MODELS[MATTE_DEFAULT_QUALITY]).url;
}

// onnxruntime threads per inference. Measured optimum is 4: letting it default
// to all 18 cores is 1.5x SLOWER on the fast model, because the efficiency cores
// drag the pool. Running several workers instead does not help either — this
// workload is memory-bandwidth bound and one process already saturates the
// machine (docs/plans/shot-matte-performance.md §2c-2d).
export function matteThreads(explicit) {
  const n = Number(explicit ?? process.env.MATTE_THREADS);
  return Number.isInteger(n) && n > 0 ? n : 4;
}

export function matteScriptPath(root = REPO_ROOT) {
  return path.join(root, 'python', 'matte.py');
}

// Python packages the matte sidecar imports. Kept here (not in the script) so
// the uv invocation and the MATTE_PYTHON error message can't drift apart.
export const MATTE_DEPS = ['numpy', 'pillow', 'onnxruntime', 'scipy'];

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
