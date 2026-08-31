#!/usr/bin/env node
// Download the local ML model weights the pipeline needs — whisper.cpp ggml for
// `voice transcribe`, and the ONNX mattes for `shot matte` — into models/.
//
// The weights are large (~1.3 GB total) and gitignored, so a fresh clone has an
// empty models/ dir. This script (run as an npm `postinstall`, or manually via
// `npm run fetch-models`) populates it. The model list is derived from
// src/config.js so it stays the single source of truth with the code that reads
// the files at runtime.
//
// Behaviour:
//   - Skips a file that is already present AND matches the server's advertised
//     size (Content-Length). A size mismatch means a truncated/partial download
//     from a prior interrupted run — it is re-fetched rather than trusted.
//   - Streams to a `.part` temp file and renames on success, so an interrupted
//     run never leaves a half-written model in place of a good one.
//   - `SKIP_MODEL_DOWNLOAD=1` makes it a no-op (for CI, or `npm ci` where the
//     download is unwanted). The postinstall hook honours this.
//   - `--force` re-downloads even when a valid file is present.
//   - `--only <fast|best|whisper>` (repeatable) limits the set; default is all.
import { createWriteStream } from 'node:fs';
import { stat, mkdir, rename, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { WHISPER_MODEL, MATTE_MODELS, modelsDir } from '../src/config.js';

// The full manifest: a stable key, the destination filename, and the source URL.
// Keys double as `--only` selectors. `whisper` first so the smallest/most-used
// asset lands even if a later (larger) download is interrupted.
export const MODELS = [
  { key: 'whisper', file: WHISPER_MODEL.file, url: WHISPER_MODEL.url },
  { key: 'fast', file: MATTE_MODELS.fast.file, url: MATTE_MODELS.fast.url },
  { key: 'best', file: MATTE_MODELS.best.file, url: MATTE_MODELS.best.url },
];

function parseArgs(argv) {
  const only = [];
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--only') only.push(argv[++i]);
    else if (a.startsWith('--only=')) only.push(a.slice('--only='.length));
  }
  return { only, force };
}

async function fileSize(p) {
  try { return (await stat(p)).size; } catch { return null; }
}

// Returns 'skipped' | 'downloaded'. `fetchImpl` is injectable for tests.
export async function fetchModel(model, { dir, force = false, fetchImpl = fetch, log = console.error } = {}) {
  const dest = path.join(dir, model.file);
  await mkdir(dir, { recursive: true });

  // Probe the remote size first so we can both validate an existing file and
  // verify the bytes we write. HEAD is cheap; fall back to the GET's headers if
  // the host rejects HEAD.
  let expected = null;
  try {
    const head = await fetchImpl(model.url, { method: 'HEAD' });
    if (head.ok) {
      const len = head.headers.get('content-length');
      if (len) expected = Number(len);
    }
  } catch { /* HEAD unsupported — validated against the GET below */ }

  const have = await fileSize(dest);
  if (!force && have != null && (expected == null || have === expected)) {
    log(`  ✓ ${model.file} present (${fmtMB(have)}) — skipping`);
    return 'skipped';
  }
  if (have != null && expected != null && have !== expected) {
    log(`  ! ${model.file} is ${fmtMB(have)} but server reports ${fmtMB(expected)} — re-downloading`);
  }

  const res = await fetchImpl(model.url);
  if (!res.ok) throw new Error(`download failed for ${model.url} (status ${res.status})`);
  if (expected == null) {
    const len = res.headers.get('content-length');
    if (len) expected = Number(len);
  }

  const tmp = `${dest}.part`;
  log(`  ↓ ${model.file}${expected ? ` (${fmtMB(expected)})` : ''} …`);
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }

  const got = await fileSize(tmp);
  if (expected != null && got !== expected) {
    await unlink(tmp).catch(() => {});
    throw new Error(`size mismatch for ${model.file}: got ${got}, expected ${expected} bytes`);
  }
  await rename(tmp, dest);
  log(`  ✓ ${model.file} downloaded (${fmtMB(got)})`);
  return 'downloaded';
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export async function fetchModels({ only = [], force = false, dir = modelsDir(), fetchImpl = fetch, log = console.error } = {}) {
  const selected = only.length ? MODELS.filter((m) => only.includes(m.key)) : MODELS;
  if (!selected.length) {
    throw new Error(`--only matched nothing; valid keys: ${MODELS.map((m) => m.key).join(', ')}`);
  }
  log(`Fetching ${selected.length} model file(s) into ${dir}`);
  const results = [];
  for (const model of selected) {
    results.push([model.key, await fetchModel(model, { dir, force, fetchImpl, log })]);
  }
  return results;
}

async function main() {
  if (process.env.SKIP_MODEL_DOWNLOAD === '1') {
    console.error('SKIP_MODEL_DOWNLOAD=1 — skipping model download.');
    return;
  }
  const { only, force } = parseArgs(process.argv.slice(2));
  try {
    await fetchModels({ only, force });
    console.error('Done.');
  } catch (err) {
    // A postinstall failure must not break `npm install` — the models are only
    // needed for matte/transcribe, which report their own actionable hint when a
    // file is missing. Warn loudly and exit 0.
    console.error(`\nModel download failed: ${err.message}`);
    console.error('Run `npm run fetch-models` later to retry (matte/transcribe still print a manual download hint).');
  }
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
