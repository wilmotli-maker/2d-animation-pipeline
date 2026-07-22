import { mkdir, writeFile, copyFile, access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  shotDir, shotYamlPath, shotDraftsDir, shotDraftDir, shotFinalDir, formatVersion,
} from './paths.js';

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function createShot(root, { shotId, elements = [], duration = null, mode = null, description = '' }) {
  const dir = shotDir(root, shotId);
  if (await exists(dir)) {
    throw new Error(`shot already exists: ${dir}`);
  }
  await mkdir(shotDraftsDir(root, shotId), { recursive: true });
  await mkdir(shotFinalDir(root, shotId), { recursive: true });
  await writeFile(shotYamlPath(root, shotId),
    YAML.stringify({ shotId, elements, duration, mode, description }));
  return { dir, shotId };
}

// Next draft version = highest existing vNNN + 1, starting at 1.
async function nextVersion(root, shotId) {
  const draftsDir = shotDraftsDir(root, shotId);
  let entries = [];
  try {
    entries = await readdir(draftsDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const nums = entries
    .map((e) => /^v(\d+)$/.exec(e))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

export async function newDraft(root, shotId) {
  const version = await nextVersion(root, shotId);
  const dir = shotDraftDir(root, shotId, version);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'prompt.md'),
    `<!-- Prompt used for ${shotId} draft ${formatVersion(version)} (low-res). -->\n`);
  await writeFile(path.join(dir, 'notes.md'),
    `<!-- Critique / regenerate-or-accept decision log for ${formatVersion(version)}. -->\n`);
  return { version, dir };
}

export async function promoteDraft(root, shotId, version, outputFile) {
  const ext = path.extname(outputFile) || '.out';
  const dest = path.join(shotFinalDir(root, shotId), `output${ext}`);
  await copyFile(outputFile, dest);
  await writeFile(path.join(shotFinalDir(root, shotId), 'source-draft.txt'),
    `${formatVersion(version)}\n`);
  return { finalPath: dest };
}
