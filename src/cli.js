import { execFile } from 'node:child_process';
import { higgsfieldBin } from './config.js';
import { parseJobId, parseJobResult } from './jobresult.js';

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

const MEDIA_FLAGS = {
  image: '--image',
  startImage: '--start-image',
  endImage: '--end-image',
  video: '--video',
  audio: '--audio',
  sketch: '--sketch',
};

// Exported for direct unit testing of arg construction.
export function buildGenerateArgs(model, opts = {}) {
  const args = ['generate', 'create', model];
  if (opts.prompt != null) args.push('--prompt', String(opts.prompt));
  for (const [key, flag] of Object.entries(MEDIA_FLAGS)) {
    // ⚠️ ASSUMPTION: a local file path here is auto-uploaded (sanity check 5).
    if (opts[key] != null) args.push(flag, String(opts[key]));
  }
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);
  if (opts.wait) args.push('--wait');
  return args;
}

export function createRunner({ exec = defaultExec, bin = higgsfieldBin() } = {}) {
  async function run(args) {
    const { code, stdout, stderr } = await exec(bin, args);
    // ⚠️ ASSUMPTION: failure => non-zero exit (sanity check 2).
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
      const stdout = await run(buildGenerateArgs(model, opts));
      const id = parseJobId(stdout);
      return { id, ...parseJobResult(stdout) };
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
