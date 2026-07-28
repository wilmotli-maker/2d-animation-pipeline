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

// Validate an existing shot draft before generating its output. Computes the
// canonical draft prompt path itself and checks shot/draft existence.
// Video-model reference enums. Values are MODEL-DEPENDENT, so a mismatch is a
// warning (the model may still accept it), not a hard failure.
const RESOLUTIONS = ['480p', '720p', '1080p', '4k'];
const ASPECT_RATIOS = ['3:4', '16:9', '9:16', '1:1', '4:3'];

export async function validateShotGenerate(root, {
  shotId, version, prompt, promptFile, images = [],
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

  // Seedance reference-count rules (`model get seedance_2_0`). --speech-audio
  // becomes a video reference, so it counts toward the video cap.
  const videoCount = videos.length + (speechAudio != null ? 1 : 0);
  const totalRefs = images.length + videoCount + audios.length;
  if (images.length > 9) add('image ref count', 'fail', `${images.length} image refs exceed the max of 9`);
  if (videoCount > 3) add('video ref count', 'fail', `${videoCount} video refs exceed the max of 3`);
  if (audios.length > 3) add('audio ref count', 'fail', `${audios.length} audio refs exceed the max of 3`);
  if (totalRefs > 12) add('total ref count', 'fail', `${totalRefs} references exceed the max of 12`);
  if (audios.length && images.length === 0 && videoCount === 0) {
    add('audio ref anchor', 'fail', 'audio references need at least one image or video/speech reference');
  }

  if (resolution != null && !RESOLUTIONS.includes(resolution)) {
    add('resolution', 'warn', `"${resolution}" not in ${RESOLUTIONS.join('/')} — the model may reject it`);
  }
  if (aspectRatio != null && !ASPECT_RATIOS.includes(aspectRatio)) {
    add('aspect ratio', 'warn', `"${aspectRatio}" not in ${ASPECT_RATIOS.join('/')} — the model may reject it`);
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
