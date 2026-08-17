import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { SHEET_TYPES } from './element.js';
import { elementDir, styleLockPath, sheetPromptPath, shotDir, shotDraftDir } from './paths.js';

// Filesystem-safe, human-readable sheet-instance slug.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

// Prompt source precedence: at most one of prompt/promptFile; else canonicalPath.
// Returns { text } on success or { error } — never throws for expected cases.
export async function resolvePrompt({ prompt, promptFile, canonicalPath } = {}) {
  if (prompt != null && promptFile != null) {
    return { error: 'pass only one of --prompt or --prompt-file' };
  }
  if (prompt != null) {
    return prompt.trim() ? { text: prompt } : { error: 'prompt is empty' };
  }
  const file = promptFile ?? canonicalPath;
  if (!file) return { error: 'no prompt provided (use --prompt, --prompt-file, or the canonical prompt.md)' };
  try {
    const text = await readFile(file, 'utf8');
    return text.trim() ? { text, file } : { error: `prompt file is empty: ${file}` };
  } catch (err) {
    if (err.code === 'ENOENT') return { error: `prompt file not found: ${file}` };
    return { error: `cannot read prompt file ${file}: ${err.message}` };
  }
}

// Validate everything needed to generate an element sheet. Returns a checklist
// plus the resolved prompt text. ok === no 'fail' checks (warns are allowed).
export async function validateElementSheet(root, { type, name, sheet, id, prompt, promptFile, images = [] }) {
  const checks = [];
  const add = (label, status, detail) => checks.push({ label, status, detail });

  add('element exists', (await exists(elementDir(root, type, name))) ? 'pass' : 'fail', `${type}/${name}`);
  add('sheet type valid', SHEET_TYPES.includes(sheet) ? 'pass' : 'fail', String(sheet));
  const slugOk = typeof id === 'string' && SLUG_RE.test(id);
  add('sheet id valid', slugOk ? 'pass' : 'fail', id ? String(id) : '(missing)');

  const canonicalPath = (slugOk && SHEET_TYPES.includes(sheet))
    ? sheetPromptPath(root, type, name, sheet, id) : null;
  const pr = await resolvePrompt({ prompt, promptFile, canonicalPath });
  let promptText = null;
  if (pr.error) add('prompt present', 'fail', pr.error);
  else { promptText = pr.text; add('prompt present', 'pass', pr.file ? `from ${pr.file}` : 'inline'); }

  const slPath = styleLockPath(root, type, name);
  if (!(await exists(slPath))) {
    add('style-lock present', 'warn', 'no style-lock.yaml — the look may drift');
  } else {
    try { YAML.parse(await readFile(slPath, 'utf8')); add('style-lock present', 'pass', slPath); }
    catch (err) { add('style-lock present', 'fail', `style-lock.yaml is unparseable: ${err.message}`); }
  }

  for (const img of images) {
    add('reference image', (await exists(img)) ? 'pass' : 'fail', img);
  }

  const ok = checks.every((c) => c.status !== 'fail');
  return { checks, ok, promptText };
}

// Per-model reference caps and enums, from `higgsfield model get <model>`.
// These are MODEL-DEPENDENT: Seedance 2.0 and 2.5 differ enough that one set of
// hardcoded numbers would document one model while enforcing another. A null
// cap means the model states no sub-limit for that category — skip the check.
// `null` values in an enum list mean "do not enum-check this field".
const MODEL_RULES = {
  seedance_2_0: {
    caps: { images: 9, videos: 3, audios: 3, total: 12 },
    resolutions: ['480p', '720p', '1080p', '4k'],
    aspectRatios: ['3:4', '16:9', '9:16', '1:1', '4:3', '21:9', 'auto'],
  },
  seedance_2_0_mini: {
    caps: { images: 9, videos: 3, audios: 3, total: 12 },
    resolutions: ['480p', '720p', '1080p', '4k'],
    aspectRatios: ['3:4', '16:9', '9:16', '1:1', '4:3', '21:9', 'auto'],
  },
  seedance_2_5: {
    // `model get seedance_2_5`: ≤50 total, ≤30 images; no video/audio sub-caps.
    caps: { images: 30, videos: null, audios: null, total: 50 },
    resolutions: ['480p', '720p'],
    aspectRatios: ['3:4', '16:9', '9:16', '1:1', '4:3', '21:9', 'auto'],
  },
};

// Unknown/omitted model: fall back to Seedance 2.0's rules. They are the
// tightest, so a real overflow still surfaces; the detail line names the
// fallback so the message is not misleading.
const DEFAULT_MODEL = 'seedance_2_0';
function modelRules(model) {
  return { model: model || DEFAULT_MODEL, rules: MODEL_RULES[model] || MODEL_RULES[DEFAULT_MODEL] };
}

// Validate an existing shot draft before generating its output. Computes the
// canonical draft prompt path itself and checks shot/draft existence.
export async function validateShotGenerate(root, {
  shotId, version, model, prompt, promptFile, images = [],
  speechAudio, videos = [], audios = [],
  resolution, duration, aspectRatio, generateAudio,
}) {
  const checks = [];
  const add = (label, status, detail) => checks.push({ label, status, detail });

  add('shot exists', (await exists(shotDir(root, shotId))) ? 'pass' : 'fail', String(shotId));
  const draftDir = shotDraftDir(root, shotId, version);
  add('draft exists', (await exists(draftDir)) ? 'pass' : 'fail', `v${version}`);

  const canonicalPath = path.join(draftDir, 'prompt.md');
  const pr = await resolvePrompt({ prompt, promptFile, canonicalPath });
  let promptText = null;
  if (pr.error) add('prompt present', 'fail', pr.error);
  else { promptText = pr.text; add('prompt present', 'pass', pr.file ? `from ${pr.file}` : 'inline'); }

  for (const img of images) {
    add('reference image', (await exists(img)) ? 'pass' : 'fail', img);
  }
  if (speechAudio != null) {
    add('speech audio', (await exists(speechAudio)) ? 'pass' : 'fail', speechAudio);
  }
  for (const vid of videos) add('reference video', (await exists(vid)) ? 'pass' : 'fail', vid);
  for (const aud of audios) add('reference audio', (await exists(aud)) ? 'pass' : 'fail', aud);

  // Reference-count rules, per model (`model get <model>`). --speech-audio
  // becomes a video reference, so it counts toward the video cap.
  const { model: resolvedModel, rules } = modelRules(model);
  const { caps } = rules;
  const forModel = resolvedModel === model ? resolvedModel : `${resolvedModel} (default)`;
  const videoCount = videos.length + (speechAudio != null ? 1 : 0);
  const totalRefs = images.length + videoCount + audios.length;
  if (caps.images != null && images.length > caps.images) {
    add('image ref count', 'fail', `${images.length} image refs exceed the max of ${caps.images} for ${forModel}`);
  }
  if (caps.videos != null && videoCount > caps.videos) {
    add('video ref count', 'fail', `${videoCount} video refs exceed the max of ${caps.videos} for ${forModel}`);
  }
  if (caps.audios != null && audios.length > caps.audios) {
    add('audio ref count', 'fail', `${audios.length} audio refs exceed the max of ${caps.audios} for ${forModel}`);
  }
  if (caps.total != null && totalRefs > caps.total) {
    add('total ref count', 'fail', `${totalRefs} references exceed the max of ${caps.total} for ${forModel}`);
  }
  if (audios.length && images.length === 0 && videoCount === 0) {
    add('audio ref anchor', 'fail', 'audio references need at least one image or video/speech reference');
  }

  if (resolution != null && !rules.resolutions.includes(resolution)) {
    add('resolution', 'warn', `"${resolution}" not in ${rules.resolutions.join('/')} for ${forModel} — the model may reject it`);
  }
  if (aspectRatio != null && !rules.aspectRatios.includes(aspectRatio)) {
    add('aspect ratio', 'warn', `"${aspectRatio}" not in ${rules.aspectRatios.join('/')} for ${forModel} — the model may reject it`);
  }
  if (generateAudio != null
    && !(generateAudio === true || generateAudio === false
      || generateAudio === 'true' || generateAudio === 'false')) {
    add('generate-audio', 'fail', `expected true|false, got "${generateAudio}"`);
  }
  if (duration != null) {
    const n = Number(duration);
    if (!Number.isInteger(n) || n <= 0) add('duration', 'fail', `expected a positive integer, got "${duration}"`);
  }

  const ok = checks.every((c) => c.status !== 'fail');
  return { checks, ok, promptText };
}
