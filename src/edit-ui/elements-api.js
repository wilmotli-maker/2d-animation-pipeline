// Read one element's style-lock.yaml for the edit-ui picker.
// `root` is the pipeline project (elements/<type>/<name>/), never the video workspace.
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { ELEMENT_TYPES, assertSegment } from '../config.js';
import { elementDir } from '../paths.js';
import { readStyleLock } from '../element.js';
import { styleLockToText } from '../prompt-style.js';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export async function loadElementStyleLock(root, type, name) {
  if (!root) throw httpError(404, 'no project root');
  if (!ELEMENT_TYPES.includes(type)) throw httpError(400, `unknown element type "${type}"`);
  try { assertSegment(name, 'element name'); }
  catch (err) { throw httpError(400, err.message); }

  try { await access(elementDir(root, type, name), constants.F_OK); }
  catch (err) {
    if (err.code === 'ENOENT') throw httpError(404, `no element ${type}/${name}`);
    throw err;
  }

  let styleLock;
  try { styleLock = await readStyleLock(root, type, name); }
  catch (err) { throw httpError(400, err.message); }

  return { type, name, styleLock, text: styleLockToText(styleLock) };
}
