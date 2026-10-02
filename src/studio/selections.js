// src/studio/selections.js
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { realWithin } from './contain.js';

export function selectionsPath(root) { return path.join(root, '.pipeline', 'studio', 'selections.json'); }

function outside() { return Object.assign(new Error('selection store is outside the project'), { status: 403 }); }

// Real path of `p` (which may not exist yet) if every existing component stays
// inside the project; a symlinked .pipeline / studio / selections.json that
// resolves elsewhere is refused rather than read or written through.
async function contained(root, p) {
  const real = await realWithin(root, p, { forWrite: true });
  if (!real) throw outside();
  return real;
}

export async function readSelections(root) {
  const file = await contained(root, selectionsPath(root));
  try {
    const doc = JSON.parse(await readFile(file, 'utf8'));
    return { version: 1, selected: doc && typeof doc.selected === 'object' && doc.selected ? doc.selected : {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, selected: {} };
    throw err;
  }
}

// Writes are read-modify-write on one file; chain them so concurrent PUTs from
// the page (fast checkbox clicks) can't drop each other's keys.
let chain = Promise.resolve();

// Validation failures are the caller's fault (400); anything else thrown is storage (500).
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }

export function setSelection(root, key, versions) {
  if (typeof key !== 'string' || !key || key.length > 512 || key === '__proto__') return Promise.reject(invalid('selection: invalid key'));
  if (!Array.isArray(versions)) return Promise.reject(invalid('selection: versions must be an array'));
  for (const v of versions) {
    if (typeof v !== 'string' || !/^v\d+$/.test(v)) return Promise.reject(invalid(`selection: invalid version "${v}"`));
  }
  const sorted = [...new Set(versions)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const run = chain.then(async () => {
    const doc = await readSelections(root);
    if (sorted.length) doc.selected[key] = sorted; else delete doc.selected[key];
    const file = await contained(root, selectionsPath(root));
    await mkdir(path.dirname(file), { recursive: true });
    // Re-check now that the directory chain exists (it may have been swapped meanwhile).
    const dir = await contained(root, path.dirname(file));
    const tmp = path.join(dir, `${path.basename(file)}.${process.pid}.tmp`);
    // 'wx' (O_EXCL) never follows a symlink planted at the temp path; clear any stale one first.
    await rm(tmp, { force: true });
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' });
    await rename(tmp, path.join(dir, path.basename(file)));   // replaces a link at `file`, never follows it
    return doc;
  });
  chain = run.catch(() => {});
  return run;
}
