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

// The single rule for what a selection key / version may be, on read and write.
export function isValidVersion(v) { return typeof v === 'string' && /^v\d+$/.test(v); }
function isValidKey(key) { return typeof key === 'string' && !!key && key.length <= 512 && key !== '__proto__'; }
function sortVersions(vs) { return [...new Set(vs)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))); }
function isPlainObject(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

const UNTOUCHED = 'starting empty (file left untouched until the next save)';

// Never fails on bad content: a hand-edited or corrupt file must not brick the
// studio. Unparseable JSON or a non-object `selected` reads as empty; otherwise
// only valid keys with arrays of valid versions survive (deduped, sorted, empty
// keys dropped). Anything ignored is reported in `warnings`. The file itself is
// left alone; the next setSelection rewrites it from this normalized doc.
// I/O failures (other than a missing file) still throw.
export async function readSelections(root) {
  const file = await contained(root, selectionsPath(root));
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, selected: {} };
    throw err;
  }
  let doc;
  try { doc = JSON.parse(raw); } catch {
    return { version: 1, selected: {}, warnings: [`selections.json is not valid JSON; ${UNTOUCHED}`] };
  }
  if (!isPlainObject(doc) || (doc.selected !== undefined && !isPlainObject(doc.selected))) {
    return { version: 1, selected: {}, warnings: [`selections.json has no valid "selected" object; ${UNTOUCHED}`] };
  }
  const selected = {};
  let dropped = 0;
  for (const [key, vs] of Object.entries(doc.selected || {})) {
    if (!isValidKey(key) || !Array.isArray(vs)) { dropped++; continue; }
    const ok = vs.filter(isValidVersion);
    dropped += vs.length - ok.length;
    if (ok.length) selected[key] = sortVersions(ok);
  }
  const out = { version: 1, selected };
  if (dropped) out.warnings = [`ignored ${dropped} invalid selection ${dropped === 1 ? 'entry' : 'entries'}`];
  return out;
}

// Writes are read-modify-write on one file; chain them so concurrent PUTs from
// the page (fast checkbox clicks) can't drop each other's keys.
let chain = Promise.resolve();

// Validation failures are the caller's fault (400); anything else thrown is storage (500).
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }

export function setSelection(root, key, versions) {
  if (!isValidKey(key)) return Promise.reject(invalid('selection: invalid key'));
  if (!Array.isArray(versions)) return Promise.reject(invalid('selection: versions must be an array'));
  for (const v of versions) {
    if (!isValidVersion(v)) return Promise.reject(invalid(`selection: invalid version "${v}"`));
  }
  const sorted = sortVersions(versions);
  const run = chain.then(async () => {
    const { selected } = await readSelections(root);   // normalized; warnings are not persisted
    const doc = { version: 1, selected };
    if (sorted.length) doc.selected[key] = sorted; else delete doc.selected[key];
    const file = await contained(root, selectionsPath(root));
    await mkdir(path.dirname(file), { recursive: true });
    // Re-check now that the directory chain exists (it may have been swapped meanwhile).
    const dir = await contained(root, path.dirname(file));
    const tmp = path.join(dir, `${path.basename(file)}.${process.pid}.tmp`);
    // 'wx' (O_EXCL) never follows a symlink planted at the temp path; clear any stale one first.
    await rm(tmp, { force: true });
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' });
    await rename(tmp, path.join(dir, path.basename(file)));   // `file` is already the real path: an in-project symlinked selections.json is followed to its real target inside the project (outside targets were refused by contained())
    return doc;
  });
  chain = run.catch(() => {});
  return run;
}
