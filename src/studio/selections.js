// src/studio/selections.js
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function selectionsPath(root) { return path.join(root, '.pipeline', 'studio', 'selections.json'); }

export async function readSelections(root) {
  try {
    const doc = JSON.parse(await readFile(selectionsPath(root), 'utf8'));
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
    const file = selectionsPath(root);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n');
    await rename(tmp, file);
    return doc;
  });
  chain = run.catch(() => {});
  return run;
}
