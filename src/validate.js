import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import YAML from 'yaml';
import { SHEET_TYPES } from './element.js';
import { elementDir, styleLockPath, sheetPromptPath } from './paths.js';

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

// Validate an existing shot draft before generating its output.
export async function validateShotGenerate(root, { shotId, version, prompt, promptFile, images = [] }, deps = {}) {
  const checks = [];
  const add = (label, status, detail) => checks.push({ label, status, detail });

  const pr = await resolvePrompt({ prompt, promptFile, canonicalPath: deps.canonicalPath });
  let promptText = null;
  if (pr.error) add('prompt present', 'fail', pr.error);
  else { promptText = pr.text; add('prompt present', 'pass', pr.file ? `from ${pr.file}` : 'inline'); }

  for (const img of images) {
    add('reference image', (await exists(img)) ? 'pass' : 'fail', img);
  }

  const ok = checks.every((c) => c.status !== 'fail');
  return { checks, ok, promptText };
}
