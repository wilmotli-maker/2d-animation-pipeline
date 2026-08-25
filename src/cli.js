import { execFile, spawn } from 'node:child_process';
import { higgsfieldBin } from './config.js';
import { parseJobResult } from './jobresult.js';

export class HiggsfieldError extends Error {
  constructor(message, { code, stdout, stderr } = {}) {
    super(message);
    this.name = 'HiggsfieldError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

// Default executor: run the binary, capture output, NEVER throw on non-zero —
// the runner decides what a non-zero code means (see generate()).
export function defaultExec(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: stdout || '',
        stderr: stderr || (err ? String(err.message) : ''),
      });
    });
  });
}

// stderr-inheriting executor. Some higgsfield subcommands — notably
// `generate create` for the upscalers (topaz_video, bytedance_video_upscale) —
// render a progress UI to stderr and HANG indefinitely when stderr is a
// captured pipe, before the job is even created. With stderr inherited (a TTY
// or the parent's stderr) the same call returns a job id in ~1s and exits.
// matte.js hit the identical issue with its python sidecar. stdout is still
// captured — that's the JSON the parsers read; stderr is not, so it cannot feed
// a HiggsfieldError message, which is an acceptable trade for these calls.
export function inheritStderrExec(bin, args) {
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

// NOTE: which flag a given model accepts is MODEL-DEPENDENT (verified via
// `model get`): image models take --image / --image-references, video models
// take --start-image / --end-image. Callers must pick the right option key for
// their model — consult `model get <model>` when in doubt.
const MEDIA_FLAGS = {
  image: '--image',
  startImage: '--start-image',
  endImage: '--end-image',
  video: '--video',
  audio: '--audio',
  sketch: '--sketch',
};

// Scalar model parameters (mostly video models, e.g. seedance_2_0). Emitted only
// when present; values are stringified (booleans become "true"/"false"). Which a
// given model accepts is MODEL-DEPENDENT — consult `model get <model>`. camelCase
// opt key -> kebab CLI flag.
const SCALAR_PARAMS = {
  resolution: '--resolution',
  duration: '--duration',
  generateAudio: '--generate-audio',
  aspectRatio: '--aspect-ratio',
  mode: '--mode',
  bitrateMode: '--bitrate-mode',
  genre: '--genre',
  // Upscaler params (bytedance_video_upscale).
  modelVersion: '--model-version',
  preset: '--preset',
  fps: '--fps',
  // Image upscaler params (topaz_image).
  outputWidth: '--output-width',
  outputHeight: '--output-height',
  variant: '--variant',
};

// Exported for direct unit testing of arg construction.
export function buildGenerateArgs(model, opts = {}) {
  const args = ['generate', 'create', model];
  if (opts.prompt != null) args.push('--prompt', String(opts.prompt));
  for (const [key, flag] of Object.entries(MEDIA_FLAGS)) {
    // Local file paths are auto-uploaded (verified in sanity check 5).
    if (opts[key] != null) args.push(flag, String(opts[key]));
  }
  // Multiple reference images: repeat --image-references (path-or-id each). The
  // model enforces its own cap (e.g. nano_banana allows 8) and rejects overflow.
  if (Array.isArray(opts.imageReferences)) {
    for (const ref of opts.imageReferences) args.push('--image-references', String(ref));
  }
  // Video/audio reference arrays mirror imageReferences (repeat the flag). The
  // model enforces its own caps (Seedance: ≤3 video, ≤3 audio) and rejects overflow.
  if (Array.isArray(opts.videoReferences)) {
    for (const ref of opts.videoReferences) args.push('--video-references', String(ref));
  }
  if (Array.isArray(opts.audioReferences)) {
    for (const ref of opts.audioReferences) args.push('--audio-references', String(ref));
  }
  for (const [key, flag] of Object.entries(SCALAR_PARAMS)) {
    if (opts[key] != null) args.push(flag, String(opts[key]));
  }
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);
  if (opts.wait) args.push('--wait');
  return args;
}

// Same shape as buildGenerateArgs but targets `generate cost` (estimate only).
export function buildCostArgs(model, opts = {}) {
  const args = ['generate', 'cost', model];
  if (opts.prompt != null) args.push('--prompt', String(opts.prompt));
  for (const [key, flag] of Object.entries(MEDIA_FLAGS)) {
    if (opts[key] != null) args.push(flag, String(opts[key]));
  }
  if (Array.isArray(opts.imageReferences)) {
    for (const ref of opts.imageReferences) args.push('--image-references', String(ref));
  }
  if (Array.isArray(opts.videoReferences)) {
    for (const ref of opts.videoReferences) args.push('--video-references', String(ref));
  }
  if (Array.isArray(opts.audioReferences)) {
    for (const ref of opts.audioReferences) args.push('--audio-references', String(ref));
  }
  for (const [key, flag] of Object.entries(SCALAR_PARAMS)) {
    if (opts[key] != null) args.push(flag, String(opts[key]));
  }
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);
  return args;
}

export function createRunner({ exec = defaultExec, bin = higgsfieldBin() } = {}) {
  async function run(args) {
    // Global --json flag (verified): every subcommand prints structured JSON
    // instead of tables/bare URLs, which is what the parsers expect.
    const { code, stdout, stderr } = await exec(bin, [...args, '--json']);
    // Failure => non-zero exit (verified in sanity check 2: broken calls exit 4).
    if (code !== 0) {
      throw new HiggsfieldError(
        `higgsfield ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`,
        { code, stdout, stderr },
      );
    }
    return stdout;
  }

  return {
    async generate(model, opts = {}) {
      return parseJobResult(await run(buildGenerateArgs(model, opts)));
    },
    async get(jobId) {
      return parseJobResult(await run(['generate', 'get', jobId]));
    },
    async waitFor(jobId) {
      return parseJobResult(await run(['generate', 'wait', jobId]));
    },
    async listModels() {
      return run(['model', 'list']);
    },
    async getModel(modelType) {
      return run(['model', 'get', modelType]);
    },
    // Upload a local file and get back a media id usable anywhere a reference
    // flag accepts `<path-or-id>`.
    //
    // Media flags DO accept a local path and auto-upload it, so this looks
    // redundant — but for VIDEO inputs that inline upload can hang: `generate
    // create` stops returning while still creating and billing the job, so the
    // caller blocks forever on work that already succeeded, and a killed
    // process can leave a retry in flight that bills a duplicate. Uploading
    // first is a short, self-contained call that either returns an id or
    // throws. Prefer it for video.
    async upload(filePath) {
      const out = await run(['upload', 'create', String(filePath)]);
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        throw new HiggsfieldError(`upload create ${filePath}: response was not JSON: ${out.slice(0, 200)}`);
      }
      const rec = Array.isArray(parsed) ? parsed[0] : parsed;
      const id = typeof rec === 'string' ? rec : rec?.id;
      if (!id) {
        throw new HiggsfieldError(`upload create ${filePath}: no media id in response: ${out.slice(0, 200)}`);
      }
      return { id, type: rec?.type ?? null, url: rec?.url ?? null };
    },
    async estimateCost(model, opts = {}) {
      const out = await run(buildCostArgs(model, opts));
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        throw new HiggsfieldError(`generate cost ${model}: response was not JSON: ${out.slice(0, 200)}`);
      }
      const rec = Array.isArray(parsed) ? parsed[0] : parsed;
      const raw = rec?.credits ?? rec?.cost ?? rec;
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        throw new HiggsfieldError(`generate cost ${model}: no numeric credits in response: ${out.slice(0, 200)}`);
      }
      return Math.abs(n);
    },
    async fetchTransactions({ size = 100, cursor } = {}) {
      const args = ['account', 'transactions'];
      if (size != null) args.push('--size', String(size));
      if (cursor) args.push('--cursor', cursor);
      const out = await run(args);
      try {
        return JSON.parse(out);
      } catch {
        throw new HiggsfieldError(`account transactions: response was not JSON: ${out.slice(0, 200)}`);
      }
    },
  };
}
