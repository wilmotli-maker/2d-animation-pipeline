import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

// aspect ratio -> [width, height]. 720p-class dimensions; Seedance `mode: fast`
// only supports 480p/720p, so keep the short side at 720.
const ASPECT_DIMS = {
  '3:4': [720, 960],
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '1:1': [720, 720],
  '4:3': [960, 720],
};

export function aspectDims(aspect) {
  return ASPECT_DIMS[aspect] || null;
}

// Default executor. Injected as `run` in unit tests so no real ffmpeg is spawned.
// Turns a missing binary into an actionable message instead of a raw ENOENT.
async function defaultRun(bin, args) {
  try {
    const { stdout, stderr } = await execFileP(bin, args, { maxBuffer: 8 * 1024 * 1024 });
    return { stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`${bin} not found on PATH — install ffmpeg (e.g. \`brew install ffmpeg\`) to use --speech-audio`);
    }
    throw new Error(`${bin} failed: ${err.stderr ? String(err.stderr).trim() : err.message}`);
  }
}

// Wrap a speech .wav into a blank mid-gray video whose audio IS the wav and
// whose length matches it (-shortest). Passing speech as a VIDEO reference is
// the trick that makes Seedance 2.0 reproduce the recording's exact words AND
// pacing; a bare audio reference drifts (see docs/recipes/seedance-lipsync.md).
//
// The fill MUST be mid-gray (0x7f7f7f), not black — a black frame trips a
// false-positive `nsfw` moderation flag on the backend.
export async function makeBlankSpeechVideo(wavPath, outPath, {
  aspect = '3:4', fps = 24, color = '0x7f7f7f', run = defaultRun,
} = {}) {
  const dims = aspectDims(aspect);
  if (!dims) {
    throw new Error(`unsupported aspect "${aspect}" — expected one of ${Object.keys(ASPECT_DIMS).join(', ')}`);
  }
  const [w, h] = dims;
  await mkdir(path.dirname(outPath), { recursive: true });
  await run('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${color}:s=${w}x${h}:r=${fps}`,
    '-i', wavPath,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    outPath,
  ]);
  return outPath;
}
