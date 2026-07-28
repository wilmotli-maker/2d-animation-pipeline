import { execFile } from 'node:child_process';
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
  };
}
