import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { runBatch as defaultRunBatch } from './batch.js';
import { downloadTo as defaultDownloadTo } from './download.js';
import { appendGeneration } from './element.js';
import { sheetDir, shotDraftDir } from './paths.js';

// Next vNNN inside a directory of vNNN-prefixed files (sheets are versioned by
// filename, e.g. v001.png). Starts at 1.
async function nextSheetVersion(dir) {
  let entries = [];
  try { entries = await readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const nums = entries.map((e) => /^v(\d+)\b/.exec(e)).filter(Boolean).map((m) => Number(m[1]));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

function extFromUrl(url, fallback) {
  const e = path.extname(new URL(url).pathname);
  return e || fallback;
}

// Generate one artifact for an element and save it under sheets/<sheet>/vNNN.
// deps (runBatch/downloadTo) are injectable for tests.
export async function generateElementSheet(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
} = {}) {
  const { type, name, sheet, model, prompt, mediaFlag, mediaPath } = spec;
  const opts = { prompt };
  if (mediaFlag && mediaPath) opts[mediaFlag] = mediaPath; // e.g. image: '/path'

  const [result] = await runBatch(runner, [{ ref: `${name}/${sheet}`, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    throw new Error(`generation for ${name}/${sheet} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  const dir = sheetDir(root, type, name, sheet);
  const version = await nextSheetVersion(dir);
  const vtag = 'v' + String(version).padStart(3, '0');
  const outputPath = path.join(dir, `${vtag}${extFromUrl(result.outputUrl, '.png')}`);
  await downloadTo(result.outputUrl, outputPath);

  await appendGeneration(root, type, name, {
    model, sheet, version: vtag, jobId: result.id,
    prompt, output: outputPath, status: 'generated',
  });
  return { outputPath, jobId: result.id, version: vtag };
}

// Generate the output for an existing shot draft (drafts/vNNN/output.<ext>).
export async function generateShotDraft(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
} = {}) {
  const { shotId, version, model, prompt, mediaFlag, mediaPath } = spec;
  const opts = { prompt };
  if (mediaFlag && mediaPath) opts[mediaFlag] = mediaPath;

  const [result] = await runBatch(runner, [{ ref: `${shotId}/v${version}`, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    throw new Error(`shot draft ${shotId} v${version} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  const dir = shotDraftDir(root, shotId, version);
  const outputPath = path.join(dir, `output${extFromUrl(result.outputUrl, '.mp4')}`);
  await downloadTo(result.outputUrl, outputPath);
  return { outputPath, jobId: result.id };
}
