// src/studio/tree.js
// Compact project tree for the studio's navigation rail. Reuses the review
// scanners for shots/sheets so the studio and the static review pages agree on
// what a "version" is; adds element dirs with no sheets yet and empty episodes so
// the tree reflects everything the user has created, not only what has output.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { scanShots, scanImages, discoverShotRoots } from '../review-scan.js';

async function listDirs(p) {
  try {
    return (await readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
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

  return {
    project: path.basename(root),
    elements,
    episodes: [...episodes.keys()].sort(naturalCompare).map((id) => ({ id, shots: episodes.get(id) })),
    shots,
  };
}
