import path from 'node:path';
import { access, writeFile, mkdir, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { runBatch as defaultRunBatch } from './batch.js';
import { downloadTo as defaultDownloadTo } from './download.js';
import { estimateCredits, recordCreditAttempt, resolveActiveTask } from './credits.js';
import { elementUpscalePath, sheetInstanceDir } from './paths.js';
import {
  splitPanels as defaultSplitPanels, stitchPanels as defaultStitchPanels,
  SHEET_PANEL_LABELS, COLS, ROWS,
} from './split-panels.js';
import { appendGeneration } from './element.js';

// Image upscalers enlarge a finished still. topaz_image is non-generative and
// preserves line weight and paper texture on flat cartoon art (the same reason
// topaz_video is the clip default); bytedance is the cheaper enum-sized option.
// topaz_image_generative is deliberately excluded — it invents detail, wrong for
// a faithful upscale of a locked design.
export const UPSCALE_IMAGE_MODELS = {
  topaz_image: {
    kind: 'dimensions',              // needs explicit output_width/height
    defaults: { variant: 'Standard V2' },
  },
  bytedance_image_upscale: {
    kind: 'enum',                    // takes a 2k/4k resolution, not dims
    scaleToResolution: { 2: '2k', 4: '4k' },
  },
};

export const UPSCALE_IMAGE_DEFAULT_MODEL = 'topaz_image';
const VALID_SCALES = [2, 4];

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

// Build the per-job opts for one image at { width, height } source dims.
function buildOpts(cfg, mediaId, scale, width, height) {
  const opts = { imageReferences: [mediaId] };
  if (cfg.kind === 'dimensions') {
    opts.outputWidth = Math.round(width * scale);
    opts.outputHeight = Math.round(height * scale);
    Object.assign(opts, cfg.defaults);
  } else {
    opts.resolution = cfg.scaleToResolution[scale];
  }
  return opts;
}

function validate(model, scale) {
  const cfg = UPSCALE_IMAGE_MODELS[model];
  if (!cfg) {
    throw new Error(`unknown upscale model "${model}" — expected one of ${Object.keys(UPSCALE_IMAGE_MODELS).join(', ')}`);
  }
  if (!VALID_SCALES.includes(scale)) {
    throw new Error(`--scale must be one of ${VALID_SCALES.join(', ')}, got "${scale}"`);
  }
  return cfg;
}

/**
 * Upscale one image. `spec.mode` selects the flow:
 *   - 'image'   : standalone loose file (this task) — flat, one job.
 *   - 'element' : element sheet (Task 5) — panel-aware for turnaround/pose.
 */
export async function upscaleImage(root, spec, deps = {}) {
  const {
    runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
    splitPanels, stitchPanels, sharpImpl,
  } = deps;
  const {
    mode = 'image', model = UPSCALE_IMAGE_DEFAULT_MODEL, scale = 2,
  } = spec;
  const cfg = validate(model, Number(scale));
  const task = await resolveActiveTask(root, spec);

  if (mode === 'element') {
    return upscaleElementSheet(root, spec, { cfg, task, runner, runBatch, downloadTo, splitPanels, stitchPanels, sharpImpl });
  }
  return upscaleStandalone(root, spec, { cfg, model, scale: Number(scale), task, runner, runBatch, downloadTo, sharpImpl });
}

async function readDims(sharpImpl, file) {
  const sharp = sharpImpl || (await import('sharp')).default;
  const { width, height } = await sharp(file).metadata();
  if (!width || !height) throw new Error(`cannot read image dimensions for ${file}`);
  return { width, height };
}

async function upscaleStandalone(root, spec, ctx) {
  const { cfg, model, scale, task, runner, runBatch, downloadTo, sharpImpl } = ctx;
  const { input, out } = spec;
  if (!input) throw new Error('image upscale: --input is required');
  if (!await exists(input)) throw new Error(`no such image: ${input}`);

  const media = await runner.upload(input);
  let opts;
  if (cfg.kind === 'dimensions') {
    const { width, height } = await readDims(sharpImpl, input);
    opts = buildOpts(cfg, media.id, scale, width, height);
  } else {
    opts = buildOpts(cfg, media.id, scale);
  }

  const { credits, source: creditsSource } = await estimateCredits({ runner, model, images: [media.id], ...opts });
  const tag = `${scale}x-${model}`;
  const stem = path.basename(input).replace(/\.[^.]+$/, '');
  const outputPath = path.join(out || path.dirname(input), `${stem}.upscaled-${tag}.png`);
  const location = { kind: 'image' };
  const creditFields = { credits, creditsSource, kind: 'upscale', task, model, scale };

  const [result] = await runBatch(runner, [{ ref: stem, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    await recordCreditAttempt(root, location, {
      ...creditFields, jobId: result.id ?? null, status: 'failed', failurePhase: 'generation',
      billedLikely: !!result.id, error: result.error || String(result.status),
      source: input, sourceMediaId: media.id,
    });
    throw new Error(`image upscale for ${input} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  try {
    await downloadTo(result.outputUrl, outputPath);
    await writeFile(outputPath.replace(/\.png$/, '.json'), JSON.stringify({
      ...creditFields, jobId: result.id, source: input, sourceMediaId: media.id,
      params: opts, output: outputPath, upscaledAt: new Date().toISOString(), status: 'generated',
    }, null, 2) + '\n');
    await recordCreditAttempt(root, location, {
      ...creditFields, jobId: result.id, status: 'generated',
      source: input, sourceMediaId: media.id, output: outputPath,
    });
    return { outputPath, jobId: result.id, model, scale, source: input, task };
  } catch (err) {
    await recordCreditAttempt(root, location, {
      ...creditFields, jobId: result.id, status: 'failed', failurePhase: 'post_complete',
      billedLikely: true, error: String(err?.message || err), source: input, sourceMediaId: media.id,
    });
    throw err;
  }
}

// Highest vNNN.png in a sheet instance dir, or null.
async function latestVersion(dir) {
  let files;
  try { files = await readdir(dir); } catch { return null; }
  const versions = files
    .map((f) => /^(v\d+)\.png$/.exec(f))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
  return versions.length ? versions[versions.length - 1] : null;
}

async function upscaleElementSheet(root, spec, ctx) {
  const { cfg, task, runner, runBatch, downloadTo, splitPanels = defaultSplitPanels, stitchPanels = defaultStitchPanels, sharpImpl } = ctx;
  const { type, name, sheet, id, input } = spec;
  const model = spec.model || UPSCALE_IMAGE_DEFAULT_MODEL;
  const scale = Number(spec.scale ?? 2);
  const dir = sheetInstanceDir(root, type, name, sheet, id);

  // Resolve the source version.
  let version = spec.version;
  if (input) {
    if (!await exists(input)) throw new Error(`no such image: ${input}`);
  } else {
    if (version == null || version === 'latest') {
      version = await latestVersion(dir);
    } else if (/^\d+$/.test(String(version))) {
      version = `v${String(version).padStart(3, '0')}`;
    }
    if (!version || !await exists(path.join(dir, `${version}.png`))) {
      throw new Error(`no such sheet version: ${path.join(dir, `${version || 'v???'}.png`)}`);
    }
  }

  const tag = `${scale}x-${model}`;
  const location = { kind: 'element', type, name };
  const panelLabels = SHEET_PANEL_LABELS[sheet];

  // Flat flow: cycles, or --input override.
  if (input || !panelLabels) {
    const src = input || path.join(dir, `${version}.png`);
    return flatIntoSheet(root, { src, dir, tag, model, scale, cfg, sheet, id, task, location }, { runner, runBatch, downloadTo, sharpImpl });
  }

  // Panel flow: split (or reuse) panels, upscale each, stitch.
  const src = path.join(dir, `${version}.png`);
  const panelsDir = path.join(dir, version);
  let panelPaths;
  if (await exists(panelsDir)) {
    panelPaths = panelLabels.map((l) => path.join(panelsDir, `${l}.png`));
  } else {
    panelPaths = await splitPanels(src, panelsDir, panelLabels);
  }

  // Per-panel source dims (topaz) → target cells for stitch.
  const cells = [];
  const jobs = [];
  const uploads = [];
  for (let i = 0; i < panelPaths.length; i++) {
    const media = await runner.upload(panelPaths[i]);
    uploads.push(media);
    let opts, cell;
    if (cfg.kind === 'dimensions') {
      const { width, height } = await readDims(sharpImpl, panelPaths[i]);
      opts = buildOpts(cfg, media.id, scale, width, height);
      cell = { w: opts.outputWidth, h: opts.outputHeight };
    } else {
      opts = buildOpts(cfg, media.id, scale);
      // enum models: derive a target cell from the panel's own scaled dims so
      // the grid stays consistent regardless of what the model returns.
      const { width, height } = await readDims(sharpImpl, panelPaths[i]);
      cell = { w: Math.round(width * scale), h: Math.round(height * scale) };
    }
    cells.push(cell);
    jobs.push({ ref: `${panelLabels[i]}`, model, opts });
  }

  const outTag = `upscaled-${tag}`;
  const upscaledPanelsDir = path.join(dir, outTag);
  await mkdir(upscaledPanelsDir, { recursive: true });

  const creditFields = { credits: null, creditsSource: null, kind: 'upscale', task, model, scale };
  const results = await runBatch(runner, jobs);

  // Log each panel job; a single failure fails the whole sheet.
  const outPanelPaths = [];
  let failed = null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const entryBase = { ...creditFields, sheetType: sheet, sheetId: id, panel: panelLabels[i], jobId: r.id ?? null, source: panelPaths[i], sourceMediaId: uploads[i].id };
    if (r.status !== 'completed' || !r.outputUrl) {
      await appendGeneration(root, type, name, { ...entryBase, status: 'failed', failurePhase: 'generation', billedLikely: !!r.id, error: r.error || String(r.status) });
      failed = failed || panelLabels[i];
      continue;
    }
    const dest = path.join(upscaledPanelsDir, `${panelLabels[i]}.png`);
    await downloadTo(r.outputUrl, dest);
    outPanelPaths.push(dest);
    await appendGeneration(root, type, name, { ...entryBase, status: 'generated', output: dest });
  }
  if (failed) {
    throw new Error(`element upscale for ${type}/${name} ${sheet}/${id} did not complete: panel ${failed} failed`);
  }

  const compositePath = elementUpscalePath(root, type, name, sheet, id, tag);
  await stitchPanels(outPanelPaths, cells, compositePath, { sharpImpl });
  await writeFile(compositePath.replace(/\.png$/, '.json'), JSON.stringify({
    ...creditFields, sheetType: sheet, sheetId: id, source: src, panels: outPanelPaths,
    output: compositePath, upscaledAt: new Date().toISOString(), status: 'generated',
  }, null, 2) + '\n');

  return { outputPath: compositePath, panelsDir: upscaledPanelsDir, panels: outPanelPaths, jobIds: results.map((r) => r.id), model, scale, source: src, task };
}

// Flat flow that writes into a sheet dir (cycles / --input).
async function flatIntoSheet(root, p, deps) {
  const { src, dir, tag, model, scale, cfg, sheet, id, task, location } = p;
  const { runner, runBatch, downloadTo, sharpImpl } = deps;
  const media = await runner.upload(src);
  let opts;
  if (cfg.kind === 'dimensions') {
    const { width, height } = await readDims(sharpImpl, src);
    opts = buildOpts(cfg, media.id, scale, width, height);
  } else {
    opts = buildOpts(cfg, media.id, scale);
  }
  const { credits, source: creditsSource } = await estimateCredits({ runner, model, images: [media.id], ...opts });
  const creditFields = { credits, creditsSource, kind: 'upscale', task, model, scale, sheetType: sheet, sheetId: id };
  const outputPath = path.join(dir, `upscaled-${tag}.png`);

  const [result] = await runBatch(runner, [{ ref: id, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    await appendGeneration(root, location.type, location.name, {
      ...creditFields, jobId: result.id ?? null, status: 'failed', failurePhase: 'generation',
      billedLikely: !!result.id, error: result.error || String(result.status), source: src, sourceMediaId: media.id,
    });
    throw new Error(`element upscale for ${location.type}/${location.name} ${sheet}/${id} did not complete: ${result.status}`);
  }
  await downloadTo(result.outputUrl, outputPath);
  await writeFile(outputPath.replace(/\.png$/, '.json'), JSON.stringify({
    ...creditFields, jobId: result.id, source: src, sourceMediaId: media.id, params: opts,
    output: outputPath, upscaledAt: new Date().toISOString(), status: 'generated',
  }, null, 2) + '\n');
  await appendGeneration(root, location.type, location.name, {
    ...creditFields, jobId: result.id, status: 'generated', source: src, sourceMediaId: media.id, output: outputPath,
  });
  return { outputPath, jobId: result.id, model, scale, source: src, task };
}
