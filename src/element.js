import { mkdir, writeFile, readFile, appendFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import YAML from 'yaml';
import { ELEMENT_TYPES } from './config.js';
import { elementDir, elementInputsDir, styleLockPath, generationsLogPath, sheetDir } from './paths.js';

const INPUT_SUBDIRS = ['reference-images', 'reference-videos', 'speech-samples'];
export const SHEET_TYPES = ['turnaround', 'pose', 'cycles'];

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function createElement(root, { type, name }) {
  if (!ELEMENT_TYPES.includes(type)) {
    throw new Error(`unknown element type "${type}" (expected one of ${ELEMENT_TYPES.join(', ')})`);
  }
  const dir = elementDir(root, type, name);
  if (await exists(dir)) {
    throw new Error(`element already exists: ${dir}`);
  }
  const inputs = elementInputsDir(root, type, name);
  for (const sub of INPUT_SUBDIRS) {
    await mkdir(`${inputs}/${sub}`, { recursive: true });
  }
  for (const sheet of SHEET_TYPES) {
    await mkdir(sheetDir(root, type, name, sheet), { recursive: true });
  }
  await writeFile(`${inputs}/prompt.md`,
    `# ${name}\n\n<!-- Base creation prompt / description for this ${type} element. -->\n`);
  return { dir, type, name };
}

export async function writeStyleLock(root, type, name, obj) {
  await writeFile(styleLockPath(root, type, name), YAML.stringify(obj));
}

export async function readStyleLock(root, type, name) {
  try {
    const text = await readFile(styleLockPath(root, type, name), 'utf8');
    return YAML.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function appendGeneration(root, type, name, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  await appendFile(generationsLogPath(root, type, name), line);
}
