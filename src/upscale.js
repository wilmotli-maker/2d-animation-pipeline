import path from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { runBatch as defaultRunBatch } from './batch.js';
import { downloadTo as defaultDownloadTo } from './download.js';
import { estimateCredits, recordCreditAttempt, resolveActiveTask } from './credits.js';
import { resolveSourceClip } from './matte.js';
import { shotUpscalePath } from './paths.js';

// Upscalers take a finished clip and enlarge it. Seedance 2.5 caps at 720p, so
// this is the only route to 1080p+ — and measurement showed its 720p carries
// little more real detail than its 480p, which makes "generate at 480p, finish
// with an upscaler" cheaper than generating at 720p for a larger result.
//
// Pricing measured 2026-08: topaz ~2.3 credits + 0.18/s (4s -> 3, 15s -> 5);
// bytedance ~0.81 for a 4s clip. Topaz costs more but preserves line weight and
// paper texture on flat cartoon art, where bytedance smooths them away.
export const UPSCALE_MODELS = {
  topaz_video: {
    resolutions: ['1080p', '2160p'],
    defaultResolution: '1080p',
    // aspect_ratio defaults to 'auto'; pass it only when the caller asks.
    scalars: ['resolution', 'aspectRatio'],
  },
  bytedance_video_upscale: {
    resolutions: ['1080p', '2k', '4k'],
    defaultResolution: '1080p',
    // `aigc` is the preset built for AI-generated video.
    defaults: { modelVersion: 'pro', preset: 'aigc' },
    scalars: ['resolution', 'modelVersion', 'preset', 'fps'],
  },
};

export const UPSCALE_DEFAULT_MODEL = 'topaz_video';

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

/**
 * Upscale one shot version and write the result beside the clip it came from.
 *
 * The source is uploaded first and passed by media id rather than handed to
 * `generate create` as a local path: the inline upload path can hang on video
 * inputs while still creating and billing the job (see runner.upload).
 */
export async function upscaleShot(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
} = {}) {
  const {
    shotId, version = null, input = null,
    model = UPSCALE_DEFAULT_MODEL, resolution, aspectRatio, fps,
    modelVersion, preset,
  } = spec;
  const task = await resolveActiveTask(root, spec);

  const cfg = UPSCALE_MODELS[model];
  if (!cfg) {
    throw new Error(`unknown upscale model "${model}" — expected one of ${Object.keys(UPSCALE_MODELS).join(', ')}`);
  }
  const res = resolution || cfg.defaultResolution;
  if (!cfg.resolutions.includes(res)) {
    throw new Error(`${model}: --resolution must be one of ${cfg.resolutions.join(', ')}, got "${res}"`);
  }

  const source = input || await resolveSourceClip(root, shotId, version);
  if (!await exists(source)) throw new Error(`no such clip: ${source}`);

  const media = await runner.upload(source);

  const opts = { videoReferences: [media.id], resolution: res };
  const withDefaults = { aspectRatio, fps, ...cfg.defaults, modelVersion, preset };
  for (const key of cfg.scalars) {
    if (key === 'resolution') continue;
    const value = withDefaults[key] ?? cfg.defaults?.[key];
    if (value != null) opts[key] = value;
  }

  const { credits, source: creditsSource } = await estimateCredits({
    runner, model, videoReferences: [media.id], ...opts,
  });

  const ref = `${shotId}/${version == null ? 'final' : `v${version}`}`;
  const location = { kind: 'upscale', shotId };
  const creditFields = { credits, creditsSource, kind: 'upscale', task };

  const [result] = await runBatch(runner, [{ ref, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    await recordCreditAttempt(root, location, {
      model, resolution: res, jobId: result.id ?? null,
      status: 'failed', failurePhase: 'generation',
      billedLikely: !!result.id,
      error: result.error || String(result.status),
      source, sourceMediaId: media.id,
      ...creditFields,
    });
    throw new Error(`upscale for ${ref} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  try {
    const outputPath = shotUpscalePath(root, shotId, version, res);
    await downloadTo(result.outputUrl, outputPath);

    const sidecar = outputPath.replace(/\.mp4$/, '.json');
    await writeFile(sidecar, JSON.stringify({
      model, resolution: res, jobId: result.id,
      source, sourceMediaId: media.id,
      params: { ...opts, videoReferences: [media.id] },
      upscaledAt: new Date().toISOString(),
      status: 'generated', ...creditFields,
    }, null, 2) + '\n');

    await recordCreditAttempt(root, location, {
      model, resolution: res, jobId: result.id,
      source, sourceMediaId: media.id, output: outputPath,
      status: 'generated', ...creditFields,
    });

    return { outputPath, sidecar, jobId: result.id, model, resolution: res, source, mediaId: media.id, task };
  } catch (err) {
    await recordCreditAttempt(root, location, {
      model, resolution: res, jobId: result.id,
      status: 'failed', failurePhase: 'post_complete',
      billedLikely: true,
      error: String(err?.message || err),
      source, sourceMediaId: media.id,
      ...creditFields,
    });
    throw err;
  }
}
