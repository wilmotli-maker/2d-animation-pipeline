// src/studio/tree.js
// Compact project tree for the studio's navigation rail. Reuses the review
// scanners for shots/sheets so the studio and the static review pages agree on
// what a "version" is; adds element dirs with no sheets yet and empty episodes so
// the tree reflects everything the user has created, not only what has output.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { scanShots, scanImages, discoverShotRoots, isShotDir } from '../review-scan.js';

async function listEntries(p) {
  try {
    return await readdir(p, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
}

async function listDirs(p) {
  return (await listEntries(p)).filter((e) => e.isDirectory()).map((e) => e.name);
}

// Same extensions scanFolder reviews.
const VIDEO_RE = /\.(mp4|mov|webm|m4v)$/i;
export const FOLDER_DEPTH = 4;   // levels below shots/

// Whether `relPath` (below shots/) is a place scanWorkingFolders may list: no hidden
// segments, at most FOLDER_DEPTH segments, and no shot dir at or above it (shot
// dirs are never entered). Shared with the server so "tree lists it <=> API opens it".
export async function isWorkingFolderPath(shotsDir, relPath) {
  const segs = String(relPath ?? '').split(/[\\/]+/).filter(Boolean);
  if (!segs.length || segs.length > FOLDER_DEPTH || segs.some((x) => x.startsWith('.'))) return false;
  for (let i = 1; i <= segs.length; i++) {
    if (await isShotDir(path.join(shotsDir, ...segs.slice(0, i)))) return false;
  }
  return true;
}

// Number of video files directly in `ents` (Dirents); the one "holds videos" rule.
function countClips(ents) {
  return ents.filter((e) => e.isFile() && VIDEO_RE.test(e.name)).length;
}

// The single predicate for "the tree lists this folder": a working folder path that
// directly holds at least one video. Used by the walk's rule and the server.
export async function isListableFolder(shotsDir, relPath) {
  if (!(await isWorkingFolderPath(shotsDir, relPath))) return false;
  return countClips(await listEntries(path.join(shotsDir, relPath))) > 0;
}

// Working folders under <shotRoot>/shots/ (candidates/, assembled/, …): any non-shot
// dir that directly holds videos, found recursively up to FOLDER_DEPTH. Shot dirs are
// never entered; a non-shot dir without videos is not listed but is still walked.
async function scanWorkingFolders(shotsDir) {
  const out = [];
  const walk = async (rel, depth) => {
    const ents = await listEntries(rel ? path.join(shotsDir, rel) : shotsDir);
    if (rel) {
      const clips = countClips(ents);
      if (clips) out.push({ path: rel, clips });
    }
    if (depth >= FOLDER_DEPTH) return;
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (await isShotDir(path.join(shotsDir, childRel))) continue;
      await walk(childRel, depth + 1);
    }
  };
  await walk('', 0);
  return out.sort((a, b) => naturalCompare(a.path, b.path));
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function shotKey(s) { return s.episode ? `${s.episode}/${s.shotId}` : s.shotId; }
export function sheetKey(type, name, sh) { return `${type}/${name}/${sh.sheetType}/${sh.slug}`; }

function summarize(s) {
  return {
    shotId: s.shotId, versions: s.versions.length, promotedVersion: s.promotedVersion,
    mattes: s.versions.filter((v) => v.variants.alpha).length,
  };
}

export async function scanProjectTree(root) {
  const [shotModel, imageModel, shotRoots] = await Promise.all([
    scanShots(root), scanImages(root), discoverShotRoots(root),
  ]);

  const sheetsByEl = new Map(imageModel.characters.map((c) => [`${c.type}/${c.name}`, c.sheets]));
  const elements = [];
  const elementsDir = path.join(root, 'elements');
  for (const type of (await listDirs(elementsDir)).sort()) {
    for (const name of (await listDirs(path.join(elementsDir, type))).sort(naturalCompare)) {
      const sheets = sheetsByEl.get(`${type}/${name}`) || [];
      elements.push({ type, name, sheets: sheets.length,
        versions: sheets.reduce((a, sh) => a + sh.versions.length, 0) });
    }
  }

  const episodes = new Map();
  for (const r of shotRoots) if (r.episode != null) episodes.set(r.episode, []);
  const shots = [];
  for (const s of shotModel.shots) {
    if (s.episode == null) shots.push(summarize(s));
    else episodes.get(s.episode).push(summarize(s));
  }

  const foldersByEp = new Map();
  let folders = [];
  for (const r of shotRoots) {
    const found = await scanWorkingFolders(path.join(r.root, 'shots'));
    if (r.episode == null) folders = found; else foldersByEp.set(r.episode, found);
  }

  return {
    project: path.basename(root),
    elements,
    episodes: [...episodes.keys()].sort(naturalCompare)
      .map((id) => ({ id, shots: episodes.get(id), folders: foldersByEp.get(id) || [] })),
    shots,
    folders,
  };
}
