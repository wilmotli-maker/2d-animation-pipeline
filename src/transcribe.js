import path from 'node:path';
import { readdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { defaultExec } from './cli.js';
import { whisperBin, whisperModelPath, WHISPER_MODEL } from './config.js';

// Audio extensions the --dir scan and enumeration recognize (case-insensitive).
export const AUDIO_EXTS = ['.wav', '.mp3', '.m4a', '.flac', '.ogg'];

async function pathExists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

// Pull a clean transcript string out of whisper.cpp's stdout. With `-nt` each
// line is plain text; without it lines are prefixed `[hh:mm:ss.mmm --> ...]`.
// Be lenient: strip any leading timestamp token, drop blank lines, collapse
// whitespace, and join. Empty result is an error, never a silent empty sidecar.
const TIMESTAMP_RE = /^\s*\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/;
export function extractTranscript(stdout) {
  const cleaned = [];
  for (const rawLine of String(stdout).split('\n')) {
    const line = rawLine.replace(TIMESTAMP_RE, '').trim();
    if (line) cleaned.push(line);
  }
  const text = cleaned.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('could not extract a transcript from whisper output');
  return text;
}

// The local whisper.cpp engine. `exec(bin, args) -> { code, stdout, stderr }`
// never throws (mirrors src/cli.js defaultExec); this factory owns error
// interpretation so both the missing-binary and missing-model paths are testable
// by injecting a fake exec.
export function whisperTranscriber({ bin = whisperBin(), model = whisperModelPath(), exec = defaultExec } = {}) {
  return {
    async transcribe(audioPath) {
      if (!(await pathExists(model))) {
        throw new Error(
          `whisper model not found at ${model} — run \`npm run fetch-models\`, or download one, e.g.:\n` +
          `  curl -L -o "${model}" ${WHISPER_MODEL.url}\n` +
          '(or set WHISPER_CPP_MODEL, or pass --model-file)');
      }
      const { code, stdout, stderr } = await exec(bin, ['-m', model, '-f', audioPath, '-nt']);
      if (code !== 0) {
        if (/ENOENT|not found|no such file/i.test(stderr) && /whisper|spawn/i.test(stderr)) {
          throw new Error(
            `whisper binary "${bin}" not found — install whisper.cpp ` +
            '(e.g. `brew install whisper-cpp`) or set WHISPER_CPP_BIN');
        }
        throw new Error(`whisper failed (exit ${code}): ${stderr.trim()}`);
      }
      return { text: extractTranscript(stdout), raw: stdout };
    },
  };
}

// Engine registry. whisper is the only working backend today; higgsfield is a
// deferred stub because `generate create` still rejects data jobs (verified on
// CLI 1.1.19/1.1.20).
export function getTranscriber(engine = 'whisper', opts = {}) {
  if (engine == null || engine === 'whisper') return whisperTranscriber(opts);
  if (engine === 'higgsfield') {
    return {
      async transcribe() {
        throw new Error(
          'Higgsfield speech2text is not callable via the CLI yet (data jobs unsupported); ' +
          'use --engine whisper');
      },
    };
  }
  throw new Error(`unknown transcription engine "${engine}" (expected: whisper, higgsfield)`);
}

// Source audio `X.wav` -> sibling transcript `X.txt`.
export function sidecarPathFor(audioPath) {
  const ext = path.extname(audioPath);
  return `${audioPath.slice(0, audioPath.length - ext.length)}.txt`;
}

// Audio files directly inside `dir`, sorted, filtered to AUDIO_EXTS.
export async function listAudioFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && AUDIO_EXTS.includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .sort();
}

// Transcribe a set of inputs to sidecars. spec: { audios?, dir?, out?, force? }.
// Skips a source whose sidecar already exists unless force (transcription is not
// free everywhere and re-runs should be safe). Returns one record per source.
export async function transcribeInputs(spec, { transcriber }) {
  const { audios = [], dir = null, out = null, force = false } = spec;
  if (out && (dir || audios.length !== 1)) {
    throw new Error('--out is only valid with a single --audio and no --dir');
  }
  const sources = [...audios];
  if (dir) sources.push(...await listAudioFiles(dir));
  if (!sources.length) {
    throw new Error('no audio inputs — pass --audio <file> and/or --dir <folder>');
  }

  const results = [];
  for (const audio of sources) {
    const sidecar = out || sidecarPathFor(audio);
    if (!force && await pathExists(sidecar)) {
      results.push({ audio, sidecar, status: 'skipped' });
      continue;
    }
    const { text } = await transcriber.transcribe(audio);
    await writeFile(sidecar, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    results.push({ audio, sidecar, status: 'transcribed' });
  }
  return results;
}
