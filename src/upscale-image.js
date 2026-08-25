import path from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { runBatch as defaultRunBatch } from './batch.js';
import { downloadTo as defaultDownloadTo } from './download.js';
import { estimateCredits, recordCreditAttempt, resolveActiveTask } from './credits.js';
import { elementUpscalePath } from './paths.js';

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

// Stub — implemented in Task 5.
async function upscaleElementSheet() {
  throw new Error('element sheet upscale not yet implemented');
}
