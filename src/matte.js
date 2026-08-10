import path from 'node:path';
import { spawn } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  matteModelPath, matteRunner, matteScriptPath, MATTE_MODEL_URL, MATTE_DEPS,
} from './config.js';
import { shotFinalDir, shotDraftDir, shotAlphaPath } from './paths.js';

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
  model = matteModelPath(),
  exec = streamingExec,
} = {}) {
  return {
    async run({ input, output, format = 'prores4444' }) {
      if (!(await pathExists(model))) {
        throw new Error(
          `matte model not found at ${model} — download it:\n` +
          `  curl -L -o "${model}" ${MATTE_MODEL_URL}\n` +
          '(or set MATTE_MODEL, or pass --model-file)');
      }
      const args = [
        ...runner.prefixArgs, script,
        '--input', input, '--output', output, '--model', model, '--format', format,
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

// Matte one shot version. Returns the resolved source, the written output, and
// whatever the sidecar reported (frame count, timing, alpha stats).
export async function matteShot(root, spec, { engine }) {
  const { shotId, version = null, format = 'prores4444', input = null } = spec;
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

  const report = await engine.run({ input: source, output, format });
  return { source, output, ...report };
}
