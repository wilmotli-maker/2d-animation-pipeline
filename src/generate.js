import path from 'node:path';
import { readdir, writeFile } from 'node:fs/promises';
import { runBatch as defaultRunBatch } from './batch.js';
import { downloadTo as defaultDownloadTo } from './download.js';
import { estimateCredits, recordCreditAttempt, resolveActiveTask } from './credits.js';
import { appendGeneration } from './element.js';
import { sheetInstanceDir, shotDraftDir } from './paths.js';
import { splitPanels as defaultSplitPanels, SHEET_PANEL_LABELS } from './split-panels.js';
import { makeBlankSpeechVideo as defaultMakeBlankSpeechVideo } from './speechclip.js';
import { validateElementSheet, validateShotGenerate } from './validate.js';

// Highest vNNN in a directory (matches v001.png, v001.prompt.md, ...), + 1.
async function nextVersion(dir) {
  let entries = [];
  try { entries = await readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const nums = entries.map((e) => /^v(\d+)/.exec(e)).filter(Boolean).map((m) => Number(m[1]));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

function formatVersion(n) { return 'v' + String(n).padStart(3, '0'); }

function extFromUrl(url, fallback) {
  return path.extname(new URL(url).pathname) || fallback;
}

// Throw a clear error if validation has any hard failure; warn on any warn.
function enforce(v, what) {
  for (const c of v.checks) if (c.status === 'warn') console.warn(`warning: ${c.detail}`);
  if (!v.ok) {
    const fails = v.checks.filter((c) => c.status === 'fail').map((c) => `${c.label}: ${c.detail}`);
    throw new Error(`cannot generate ${what} — ${fails.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// Element sheets
//
// prepare* does everything up to (but not including) submission: resolve the
// active task, validate/enforce inputs, build the runner opts, and estimate
// credits. finalize* consumes the batch result for one request and does the
// download + credit logging (+ panel split). The single-item generate*
// functions and the *Batch functions both compose these two halves, so batched
// runs behave exactly like N single runs — only the submit/poll is shared.
// ---------------------------------------------------------------------------

export async function prepareElementSheet(root, spec) {
  const { type, name, sheet, id, model, prompt, promptFile, images = [] } = spec;
  const task = await resolveActiveTask(root, spec);

  const v = await validateElementSheet(root, { type, name, sheet, id, prompt, promptFile, images });
  enforce(v, `${type}/${name} ${sheet}/${id}`);

  const opts = { prompt: v.promptText };
  if (images.length) opts.imageReferences = images;

  const { credits, source: creditsSource } = await estimateCredits({
    runner: spec.runner, model, prompt: v.promptText, images,
  });

  return {
    kind: 'element',
    ref: `${name}/${sheet}/${id}`,
    request: { ref: `${name}/${sheet}/${id}`, model, opts },
    ctx: {
      type, name, sheet, id, model, images, promptText: v.promptText,
      task, credits, creditsSource,
    },
  };
}

async function finalizeElementSheet(root, prepared, result, { downloadTo, splitPanels }) {
  const { type, name, sheet, id, model, images, promptText, task, credits, creditsSource } = prepared.ctx;
  const location = { kind: 'element', type, name };
  const creditFields = { credits, creditsSource, kind: 'element', task };

  if (result.status !== 'completed' || !result.outputUrl) {
    await recordCreditAttempt(root, location, {
      sheetType: sheet, sheetId: id, model, jobId: result.id ?? null,
      status: 'failed', failurePhase: 'generation',
      billedLikely: !!result.id,
      error: result.error || String(result.status),
      ...creditFields,
    });
    throw new Error(`generation for ${name}/${sheet}/${id} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  const dir = sheetInstanceDir(root, type, name, sheet, id);
  try {
    const vtag = formatVersion(await nextVersion(dir));
    const outputPath = path.join(dir, `${vtag}${extFromUrl(result.outputUrl, '.png')}`);
    await downloadTo(result.outputUrl, outputPath);
    await writeFile(path.join(dir, `${vtag}.prompt.md`), promptText);

    // Turnaround and pose sheets are a single 3×2 grid; split them into per-panel
    // files so later prompt-generation can reference one panel by name. The folder
    // matches the sheet's name (e.g. v001.png -> v001/) and sits beside it.
    let panelsDir = null;
    let panels = null;
    const panelLabels = SHEET_PANEL_LABELS[sheet];
    if (panelLabels) {
      panelsDir = path.join(dir, vtag);
      panels = await splitPanels(outputPath, panelsDir, panelLabels);
    }

    await appendGeneration(root, type, name, {
      sheetType: sheet, sheetId: id, version: vtag, model, jobId: result.id,
      prompt: promptText, promptFile: path.join(dir, `${vtag}.prompt.md`),
      imageReferences: images, output: outputPath, panelsDir, panels: panels || [],
      status: 'generated', ...creditFields,
    });
    return { outputPath, jobId: result.id, version: vtag, sheetId: id, panelsDir, panels, task };
  } catch (err) {
    await recordCreditAttempt(root, location, {
      sheetType: sheet, sheetId: id, model, jobId: result.id,
      status: 'failed', failurePhase: 'post_complete',
      billedLikely: true,
      error: String(err?.message || err),
      ...creditFields,
    });
    throw err;
  }
}

export async function generateElementSheet(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
  splitPanels = defaultSplitPanels,
} = {}) {
  const prepared = await prepareElementSheet(root, { ...spec, runner });
  const [result] = await runBatch(runner, [prepared.request]);
  return finalizeElementSheet(root, prepared, result, { downloadTo, splitPanels });
}

// ---------------------------------------------------------------------------
// Shot drafts
// ---------------------------------------------------------------------------

export async function prepareShotDraft(root, spec, { makeBlankSpeechVideo = defaultMakeBlankSpeechVideo } = {}) {
  const {
    shotId, version, model, prompt, promptFile, images = [],
    speechAudio, videos = [], audios = [],
    resolution, duration, aspectRatio, generateAudio, mode,
  } = spec;
  const task = await resolveActiveTask(root, spec);

  const v = await validateShotGenerate(root, {
    shotId, version, model, prompt, promptFile, images,
    speechAudio, videos, audios, resolution, duration, aspectRatio, generateAudio,
  });
  enforce(v, `shot ${shotId} v${version}`);

  const dir = shotDraftDir(root, shotId, version);

  // --speech-audio: wrap the wav into a blank mid-gray video and hand it to
  // Seedance as a VIDEO reference (exact-pacing lip-sync trick). Persist it
  // beside the output so the run is reproducible.
  const videoReferences = [...videos];
  if (speechAudio) {
    const speechRef = path.join(dir, 'speech-ref.mp4');
    await makeBlankSpeechVideo(speechAudio, speechRef, { aspect: aspectRatio || '3:4' });
    videoReferences.unshift(speechRef);
  }

  const opts = { prompt: v.promptText };
  if (images.length) opts.imageReferences = images;
  if (videoReferences.length) opts.videoReferences = videoReferences;
  if (audios.length) opts.audioReferences = audios;
  if (resolution != null) opts.resolution = resolution;
  if (duration != null) opts.duration = duration;
  if (aspectRatio != null) opts.aspectRatio = aspectRatio;
  if (generateAudio != null) opts.generateAudio = generateAudio;
  if (mode != null) opts.mode = mode;

  const { credits, source: creditsSource } = await estimateCredits({
    runner: spec.runner, model, prompt: v.promptText, images,
    videoReferences: videoReferences.length ? videoReferences : undefined,
    audioReferences: audios.length ? audios : undefined,
    resolution, duration, aspectRatio, generateAudio, mode,
  });

  return {
    kind: 'shot',
    ref: `${shotId}/v${version}`,
    request: { ref: `${shotId}/v${version}`, model, opts },
    ctx: {
      shotId, version, model, dir, images, videoReferences, audios,
      resolution, duration, aspectRatio, generateAudio, mode,
      speechAudio: speechAudio || null, promptText: v.promptText,
      task, credits, creditsSource,
    },
  };
}

async function finalizeShotDraft(root, prepared, result, { downloadTo }) {
  const {
    shotId, version, model, dir, images, videoReferences, audios,
    resolution, duration, aspectRatio, generateAudio, mode, speechAudio,
    promptText, task, credits, creditsSource,
  } = prepared.ctx;
  const location = { kind: 'shot', shotId };
  const creditFields = { credits, creditsSource, kind: 'shot', task };

  if (result.status !== 'completed' || !result.outputUrl) {
    await recordCreditAttempt(root, location, {
      model, jobId: result.id ?? null, version: formatVersion(version),
      status: 'failed', failurePhase: 'generation',
      billedLikely: !!result.id,
      error: result.error || String(result.status),
      ...creditFields,
    });
    throw new Error(`shot draft ${shotId} v${version} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  try {
    const outputPath = path.join(dir, `output${extFromUrl(result.outputUrl, '.mp4')}`);
    await downloadTo(result.outputUrl, outputPath);

    const successEntry = {
      model, jobId: result.id, prompt: promptText,
      imageReferences: images, videoReferences, audioReferences: audios,
      resolution, duration, aspectRatio, generateAudio, mode,
      speechAudio: speechAudio || null, output: outputPath,
      version: formatVersion(version),
      status: 'generated', ...creditFields,
    };

    await writeFile(path.join(dir, 'output.json'), JSON.stringify({
      ...successEntry, ts: new Date().toISOString(),
    }, null, 2) + '\n');

    await recordCreditAttempt(root, location, successEntry);

    return { outputPath, jobId: result.id, task };
  } catch (err) {
    await recordCreditAttempt(root, location, {
      model, jobId: result.id, version: formatVersion(version),
      status: 'failed', failurePhase: 'post_complete',
      billedLikely: true,
      error: String(err?.message || err),
      ...creditFields,
    });
    throw err;
  }
}

export async function generateShotDraft(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
  makeBlankSpeechVideo = defaultMakeBlankSpeechVideo,
} = {}) {
  const prepared = await prepareShotDraft(root, { ...spec, runner }, { makeBlankSpeechVideo });
  const [result] = await runBatch(runner, [prepared.request]);
  return finalizeShotDraft(root, prepared, result, { downloadTo });
}

// ---------------------------------------------------------------------------
// Batched generation
//
// Prepare every spec, submit the valid ones through a single concurrency-capped
// runBatch (up to `concurrency` in flight), then finalize each. Nothing throws
// out of the batch: a spec that fails preparation, generation, or download is
// recorded as { ref, ok: false, error } and the rest still run. Order matches
// the input specs.
// ---------------------------------------------------------------------------

async function runGenerationBatch(root, specs, prepareOne, finalizeOne, {
  runner, runBatch = defaultRunBatch, downloadTo, splitPanels, concurrency = 8,
}) {
  // 1) Prepare all. A preparation failure (validation, credit estimate) becomes
  //    a terminal per-item failure with no job to submit.
  const prepared = await Promise.all(specs.map(async (spec) => {
    try {
      return { ok: true, ref: spec.ref ?? null, prepared: await prepareOne(root, { ...spec, runner }) };
    } catch (err) {
      return { ok: false, ref: spec.ref ?? null, error: err.message };
    }
  }));

  // 2) Submit + poll the prepared jobs together, capped at `concurrency`.
  const toSubmit = prepared.filter((p) => p.ok);
  const results = toSubmit.length
    ? await runBatch(runner, toSubmit.map((p) => p.prepared.request), { concurrency })
    : [];
  const resultByRef = new Map(results.map((r, i) => [toSubmit[i], r]));

  // 3) Finalize each in input order; isolate per-item finalize failures.
  const out = [];
  for (const p of prepared) {
    if (!p.ok) { out.push({ ref: p.ref, ok: false, error: p.error }); continue; }
    const result = resultByRef.get(p);
    try {
      const done = await finalizeOne(root, p.prepared, result, { downloadTo, splitPanels });
      out.push({ ref: p.prepared.ref, ok: true, ...done });
    } catch (err) {
      out.push({ ref: p.prepared.ref, ok: false, jobId: result?.id ?? null, error: err.message });
    }
  }
  return out;
}

export async function generateElementSheetsBatch(root, specs, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
  splitPanels = defaultSplitPanels, concurrency = 8,
} = {}) {
  return runGenerationBatch(root, specs, prepareElementSheet, finalizeElementSheet, {
    runner, runBatch, downloadTo, splitPanels, concurrency,
  });
}

export async function generateShotDraftsBatch(root, specs, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
  makeBlankSpeechVideo = defaultMakeBlankSpeechVideo, concurrency = 8,
} = {}) {
  const prepareOne = (r, spec) => prepareShotDraft(r, spec, { makeBlankSpeechVideo });
  return runGenerationBatch(root, specs, prepareOne, finalizeShotDraft, {
    runner, runBatch, downloadTo, concurrency,
  });
}
