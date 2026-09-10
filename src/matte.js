import path from 'node:path';
import { spawn } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  matteModelPath, matteRunner, matteScriptPath, matteModelUrl, matteThreads,
  MATTE_DEPS, MATTE_MODELS, MATTE_DEFAULT_QUALITY,
  plateMatteScriptPath, plateMatteRunner, PLATE_MATTE_DEPS,
} from './config.js';
import { shotFinalDir, shotDraftDir, shotAlphaPath } from './paths.js';

// Matte methods. 'ml' is the learned, background-agnostic segmenter (isnet/
// birefnet, the historical default). 'plate' is the classical trimap+closed-form
// matte for footage shot on a designed solid plate — see plateMatteEngine.
export const MATTE_METHODS = ['ml', 'plate'];
export const MATTE_DEFAULT_METHOD = 'ml';

// Under --method plate the matte is composed of a basic core (--matte) and an
// optional edge refinement (--refine). 'chroma' is the colour-distance key (it
// has no final alpha of its own, so it requires closed-form refinement);
// 'keylight' is the per-pixel keyer, runnable raw or refined. See
// docs/superpowers/specs/2026-09-08-matte-consolidation-design.md.
export const MATTE_CORES = ['chroma', 'keylight'];
export const MATTE_REFINES = ['none', 'closed-form'];
export const MATTE_DEFAULT_CORE = 'chroma';
export const MATTE_DEFAULT_REFINE = 'closed-form';

// Deprecated alias, retained so existing commands keep working:
//   --key-engine trimap   == --matte chroma  --refine closed-form
//   --key-engine keylight == --matte keylight --refine none
export const MATTE_KEY_ENGINES = ['trimap', 'keylight'];
export const MATTE_DEFAULT_KEY_ENGINE = 'trimap';
export function keyEngineToComposition(keyEngine) {
  return keyEngine === 'keylight'
    ? { core: 'keylight', refine: 'none' }
    : { core: 'chroma', refine: 'closed-form' };
}

async function pathExists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

// Like cli.js defaultExec, but the child's stderr is INHERITED rather than
// captured. Matting a 5s shot takes ~9 minutes; execFile would buffer the
// sidecar's progress lines until exit, leaving the user staring at a silent
// terminal for the whole run. stdout is still captured — that's the JSON report.
// Never throws on a non-zero code; the caller decides what it means.
export function streamingExec(bin, args) {
  return new Promise((resolve) => {
    let stdout = '';
    let spawnError = '';
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', (err) => { spawnError = String(err.message); });
    child.on('close', (code) => {
      resolve({ code: spawnError ? 127 : code ?? 0, stdout, stderr: spawnError });
    });
  });
}

// Output containers. ProRes 4444 is the default because After Effects reads it
// natively AND its alpha plane is not chroma-subsampled — the entire point of
// this step is to stop losing edge detail, so a 4:2:0 alpha would defeat it.
// `ext: null` means a numbered PNG sequence, i.e. a folder not a file.
export const MATTE_FORMATS = {
  prores4444: { ext: 'mov' },
  webm: { ext: 'webm' },
  png: { ext: null },
};

export const MATTE_QUALITIES = Object.keys(MATTE_MODELS);

// Which clip to matte. `version` null/'final' means the promoted clip.
// promoteDraft() names finals `<shotId>-vNNN.<ext>`, so prefer that — it is the
// pipeline's own convention and records which draft is live. Older projects
// also carry a plain `output.mp4`, so fall back to it rather than failing.
export async function resolveSourceClip(root, shotId, version = null) {
  const dir = version == null || version === 'final'
    ? shotFinalDir(root, shotId)
    : shotDraftDir(root, shotId, version);

  let entries = [];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    throw new Error(`no such shot version: ${dir}`);
  }

  if (version == null || version === 'final') {
    const promoted = entries
      .filter((n) => new RegExp(`^${shotId}-v\\d+\\.(mp4|mov)$`).test(n))
      .sort();
    if (promoted.length) return path.join(dir, promoted[promoted.length - 1]);
  }
  for (const name of ['output.mp4', 'output.mov']) {
    if (entries.includes(name)) return path.join(dir, name);
  }
  throw new Error(
    `no clip to matte in ${dir} — promote a draft first ` +
    '(`pipeline shot promote`), or pass --input <file>');
}

// The sidecar prints one JSON object on stdout; progress goes to stderr. Scan
// backwards so a stray stdout line before the report can't break parsing.
export function parseMatteReport(stdout) {
  const lines = String(stdout).trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try { return JSON.parse(line); } catch { /* not the report line; keep looking */ }
    }
  }
  throw new Error('matte sidecar produced no JSON report');
}

// The Python matting engine. Mirrors whisperTranscriber: `exec` is injectable so
// the missing-model, missing-runtime, and non-zero-exit paths are all testable
// without a 930 MB download or a Python install.
export function matteEngine({
  runner = matteRunner(),
  script = matteScriptPath(),
  quality = MATTE_DEFAULT_QUALITY,
  model = null,
  threads = matteThreads(),
  exec = streamingExec,
} = {}) {
  // Resolved here rather than in the parameter default so `quality` can drive it.
  const weights = model || matteModelPath(null, quality);
  return {
    async run({ input, output, format = 'prores4444', despill = true }) {
      if (!(await pathExists(weights))) {
        throw new Error(
          `matte model for --quality ${quality} not found at ${weights} — run \`npm run fetch-models\`, or download it:\n` +
          `  curl -L -o "${weights}" ${matteModelUrl(quality)}\n` +
          '(or set MATTE_MODEL_DIR, MATTE_MODEL, or pass --model-file)');
      }
      const args = [
        ...runner.prefixArgs, script,
        '--input', input, '--output', output, '--model', weights, '--format', format,
        '--despill', despill ? 'true' : 'false',
        // --quality selects the pre/post recipe on the Python side; it MUST match
        // the weights above or the matte comes out a gradient instead of a mask.
        '--quality', quality,
        '--threads', String(threads),
      ];
      const { code, stdout, stderr } = await exec(runner.bin, args);
      if (code !== 0) {
        if (/ENOENT|not found|no such file/i.test(stderr) && /spawn|uv|python/i.test(stderr)) {
          throw new Error(
            `"${runner.bin}" not found — install uv (\`brew install uv\`), or set ` +
            `MATTE_PYTHON to a python with ${MATTE_DEPS.join(', ')} installed`);
        }
        throw new Error(`matte failed (exit ${code}): ${stderr.trim()}`);
      }
      return parseMatteReport(stdout);
    },
  };
}

// The plate matte engine (--method plate). Runs python/plate_matte.py, which
// auto-detects the plate colour per clip and needs no model weights. Mirrors
// matteEngine's run() contract (same {input, output, format, despill} and the
// same JSON report on stdout) so matteShot is method-agnostic.
export function plateMatteEngine({
  runner = plateMatteRunner(),
  script = plateMatteScriptPath(),
  feather = null,
  // Composed matte: `core` (--matte) + `refine` (--refine). `keylight` is a bag
  // of the Keylight-only controls the CLI has already validated (screenColour,
  // screenBalance, clipBlack, clipWhite, screenGain, screenPreBlur, despillBias,
  // insideMask, outsideMask); it is only forwarded when the core is 'keylight'.
  core = MATTE_DEFAULT_CORE,
  refine = MATTE_DEFAULT_REFINE,
  keylight = {},
  exec = streamingExec,
} = {}) {
  // Map camelCase option names to their --kebab-case sidecar flags.
  const KEYLIGHT_FLAGS = {
    screenColour: '--screen-colour', screenBalance: '--screen-balance',
    clipBlack: '--clip-black', clipWhite: '--clip-white', screenGain: '--screen-gain',
    screenPreBlur: '--screen-pre-blur', despillBias: '--despill-bias',
    insideMask: '--inside-mask', outsideMask: '--outside-mask',
  };
  return {
    async run({ input, output, format = 'prores4444', despill = true }) {
      const args = [
        ...runner.prefixArgs, script,
        '--input', input, '--output', output, '--format', format,
        // On plate, --despill toggles the generalized (dominant-channel) despill
        // that decontaminates the edge colour; it is not the ML spill guard.
        '--despill', despill ? 'true' : 'false',
        '--matte', core, '--refine', refine,
      ];
      if (feather != null) args.push('--feather', String(feather));
      if (core === 'keylight') {
        for (const [k, flag] of Object.entries(KEYLIGHT_FLAGS)) {
          if (keylight[k] != null) args.push(flag, String(keylight[k]));
        }
      }
      const { code, stdout, stderr } = await exec(runner.bin, args);
      if (code !== 0) {
        if (/ENOENT|not found|no such file/i.test(stderr) && /spawn|uv|python/i.test(stderr)) {
          throw new Error(
            `"${runner.bin}" not found — install uv (\`brew install uv\`), or set ` +
            `MATTE_PYTHON to a python with ${PLATE_MATTE_DEPS.join(', ')} importable`);
        }
        throw new Error(`plate matte failed (exit ${code}): ${stderr.trim()}`);
      }
      return parseMatteReport(stdout);
    },
  };
}

// Matte one shot version. Returns the resolved source, the written output, and
// whatever the sidecar reported (frame count, timing, alpha stats).
//
// Matte several shots SEQUENTIALLY. Running them concurrently does not help:
// measured aggregate throughput is flat at ~2.3 fps from 1 to 12 worker
// processes, because this workload is memory-bandwidth bound and a single
// 4-thread process already saturates the machine. A 2-way run of the ArtAI
// corpus measured at best 1.24x and cost 20 minutes of idle time waiting for the
// slower job in each pair. See docs/plans/shot-matte-performance.md §2d.
export async function matteShot(root, spec, { engine }) {
  const { shotId, version = null, format = 'prores4444', input = null, despill = true } = spec;
  if (!shotId) throw new Error('matteShot: shotId is required');

  const fmt = MATTE_FORMATS[format];
  if (!fmt) {
    throw new Error(
      `unknown --format "${format}" (expected: ${Object.keys(MATTE_FORMATS).join(', ')})`);
  }
  if (input && !(await pathExists(input))) {
    throw new Error(`--input not found: ${input}`);
  }

  const source = input || await resolveSourceClip(root, shotId, version);
  const output = shotAlphaPath(root, shotId, version, fmt.ext);
  // For a PNG sequence `output` is itself the folder; otherwise ensure its parent.
  await mkdir(fmt.ext == null ? output : path.dirname(output), { recursive: true });

  const report = await engine.run({ input: source, output, format, despill });
  return { source, output, ...report };
}
