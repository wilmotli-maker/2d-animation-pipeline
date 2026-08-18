import path from 'node:path';
import { readdir, writeFile } from 'node:fs/promises';
import { runBatch as defaultRunBatch } from './batch.js';
import { downloadTo as defaultDownloadTo } from './download.js';
import { estimateCredits } from './credits.js';
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

export async function generateElementSheet(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
  splitPanels = defaultSplitPanels,
} = {}) {
  const { type, name, sheet, id, model, prompt, promptFile, images = [] } = spec;

  const v = await validateElementSheet(root, { type, name, sheet, id, prompt, promptFile, images });
  enforce(v, `${type}/${name} ${sheet}/${id}`);

  const opts = { prompt: v.promptText };
  if (images.length) opts.imageReferences = images;

  const { credits, source: creditsSource } = await estimateCredits({
    runner, model, prompt: v.promptText, images,
  });

  const [result] = await runBatch(runner, [{ ref: `${name}/${sheet}/${id}`, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    throw new Error(`generation for ${name}/${sheet}/${id} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  const dir = sheetInstanceDir(root, type, name, sheet, id);
  const vtag = formatVersion(await nextVersion(dir));
  const outputPath = path.join(dir, `${vtag}${extFromUrl(result.outputUrl, '.png')}`);
  await downloadTo(result.outputUrl, outputPath);
  await writeFile(path.join(dir, `${vtag}.prompt.md`), v.promptText);

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
    prompt: v.promptText, promptFile: path.join(dir, `${vtag}.prompt.md`),
    imageReferences: images, output: outputPath, panelsDir, panels: panels || [],
    status: 'generated', credits, creditsSource, kind: 'element',
  });
  return { outputPath, jobId: result.id, version: vtag, sheetId: id, panelsDir, panels };
}

export async function generateShotDraft(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
  makeBlankSpeechVideo = defaultMakeBlankSpeechVideo,
} = {}) {
  const {
    shotId, version, model, prompt, promptFile, images = [],
    speechAudio, videos = [], audios = [],
    resolution, duration, aspectRatio, generateAudio, mode,
  } = spec;

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
    runner, model, prompt: v.promptText, images,
    videoReferences: videoReferences.length ? videoReferences : undefined,
    audioReferences: audios.length ? audios : undefined,
    resolution, duration, aspectRatio, generateAudio, mode,
  });

  const [result] = await runBatch(runner, [{ ref: `${shotId}/v${version}`, model, opts }]);
  if (result.status !== 'completed' || !result.outputUrl) {
    throw new Error(`shot draft ${shotId} v${version} did not complete: ${result.status}${result.error ? ' — ' + result.error : ''}`);
  }

  const outputPath = path.join(dir, `output${extFromUrl(result.outputUrl, '.mp4')}`);
  await downloadTo(result.outputUrl, outputPath);

  // Record what produced this take, for parity with element-sheet bookkeeping.
  await writeFile(path.join(dir, 'output.json'), JSON.stringify({
    model, jobId: result.id, prompt: v.promptText,
    imageReferences: images, videoReferences, audioReferences: audios,
    resolution, duration, aspectRatio, generateAudio, mode,
    speechAudio: speechAudio || null, output: outputPath,
    credits, creditsSource, kind: 'shot',
    ts: new Date().toISOString(),
  }, null, 2) + '\n');

  return { outputPath, jobId: result.id };
}
