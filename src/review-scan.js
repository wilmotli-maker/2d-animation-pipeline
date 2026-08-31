// src/review-scan.js
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {
  shotDir, shotDraftsDir, shotFinalDir, shotVersionDir, formatVersion,
  generationsLogPath,
} from './paths.js';

async function isDir(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

async function listDirs(p) {
  try {
    return (await readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// A "shot root" is a directory containing a shots/ folder. Episodic projects have
// one per episodes/<N>; flat projects have the top-level project dir itself. Both
// may coexist during a migration — union them.
export async function discoverShotRoots(root) {
  const out = [];
  if (await isDir(path.join(root, 'shots'))) out.push({ root, episode: null });
  const episodesDir = path.join(root, 'episodes');
  for (const n of (await listDirs(episodesDir)).sort()) {
    const epRoot = path.join(episodesDir, n);
    if (await isDir(path.join(epRoot, 'shots'))) out.push({ root: epRoot, episode: n });
  }
  return out;
}
