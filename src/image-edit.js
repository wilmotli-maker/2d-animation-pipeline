// Standalone single-image edit — the image counterpart of `image upscale` (src/upscale-image.js):
// reference image(s) + a prompt -> one edited image on disk, via an injected runner (default the fal
// Nano Banana /edit runner). No element or credit bookkeeping, so a skill or any caller can use it.
import path from 'node:path';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { runBatch as defaultRunBatch } from './batch.js';
import { downloadTo as defaultDownloadTo } from './download.js';

export const IMAGE_EDIT_DEFAULT_MODEL = 'nano_banana_2_lite';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Next free `<stem>-edit-v<NN>.png` in `dir` (01 if none exist) — never overwrites a prior edit.
async function nextEditPath(dir, stem) {
  let files = [];
  try { files = await readdir(dir); } catch { /* dir may not exist yet */ }
  const re = new RegExp(`^${escapeRe(stem)}-edit-v(\\d+)\\.png$`);
  let max = 0;
  for (const f of files) { const m = re.exec(f); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  const tag = `v${String(max + 1).padStart(2, '0')}`;
  return path.join(dir, `${stem}-edit-${tag}.png`);
}

export async function editImage(root, spec, deps = {}) {
  const { images = [], prompt, promptFile, out, model = IMAGE_EDIT_DEFAULT_MODEL } = spec;
  const { runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo } = deps;

  if (!images.length) throw new Error('image edit: at least one --image reference is required');
  let promptText = (prompt != null && prompt !== '') ? String(prompt) : '';
  if (!promptText) {
    if (!promptFile) throw new Error('image edit: a --prompt or --prompt-file is required');
    promptText = (await readFile(promptFile, 'utf8')).trim();
  }

  const outDir = out || path.dirname(images[0]);
  await mkdir(outDir, { recursive: true });
  const stem = path.basename(images[0]).replace(/\.[^.]+$/, '');
  const outputPath = await nextEditPath(outDir, stem);

  const opts = { prompt: promptText, imageReferences: images };
  const [result] = await runBatch(runner, [{ ref: stem, model, opts }]);
  if (!result || result.status !== 'completed' || !result.outputUrl) {
    throw new Error(`image edit did not complete: ${result ? result.status : 'no result'}${result && result.error ? ' — ' + result.error : ''}`);
  }
  await downloadTo(result.outputUrl, outputPath);
  return { outputPath, jobId: result.id };
}
