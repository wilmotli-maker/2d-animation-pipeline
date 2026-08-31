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

function relTo(root, p) { return p == null ? null : path.relative(root, p); }

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// Collect alpha.*, upscaled-*.mp4, and a qc/ listing from a version's dir.
async function readVariants(versionDir) {
  const out = { alpha: null, upscaled: [], qc: [] };
  for (const name of await listFiles(versionDir)) {
    if (name === 'alpha.mov' || name === 'alpha.mp4') out.alpha = path.join(versionDir, name);
    else if (/^upscaled-.*\.mp4$/.test(name)) out.upscaled.push(path.join(versionDir, name));
  }
  const qcDir = path.join(versionDir, 'qc');
  if (await isDir(qcDir)) out.qc = (await listFiles(qcDir)).map((n) => path.join(qcDir, n));
  return out;
}

async function listFiles(p) {
  try {
    return (await readdir(p, { withFileTypes: true }))
      .filter((e) => e.isFile()).map((e) => e.name);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function readShotYaml(shotRoot, id) {
  try {
    const y = YAML.parse(await readFile(path.join(shotRoot, 'shots', id, 'shot.yaml'), 'utf8'));
    return y || {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function readMeta(dir) {
  try {
    const j = JSON.parse(await readFile(path.join(dir, 'output.json'), 'utf8'));
    const { model, prompt, resolution, aspectRatio, mode, ts } = j;
    return { model, prompt, resolution, aspectRatio, mode, ts };
  } catch { return {}; }
}

async function scanOneShot(projectRoot, shotRoot, episode, id) {
  const y = await readShotYaml(shotRoot, id);
  const characters = Array.isArray(y.elements)
    ? y.elements.map((e) => (typeof e === 'string' ? e : e && e.name)).filter(Boolean) : [];
  const versions = [];

  const draftsDir = shotDraftsDir(shotRoot, id);
  const draftNames = (await listDirs(draftsDir)).filter((n) => /^v\d+$/.test(n))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const v of draftNames) {
    const dir = shotVersionDir(shotRoot, id, Number(v.slice(1)));
    const video = path.join(dir, 'output.mp4');
    versions.push({
      version: v, kind: 'draft',
      video: (await fileExists(video)) ? relTo(projectRoot, video) : null,
      variants: mapVariants(projectRoot, await readVariants(dir)),
      meta: await readMeta(dir),
    });
  }

  const finalDir = shotFinalDir(shotRoot, id);
  const finalMp4 = (await listFiles(finalDir)).find((n) => n.endsWith('.mp4'));
  if (finalMp4) {
    versions.push({
      version: 'final', kind: 'final',
      video: relTo(projectRoot, path.join(finalDir, finalMp4)),
      variants: mapVariants(projectRoot, await readVariants(finalDir)),
      meta: await readMeta(finalDir),
    });
  }

  return {
    shotId: id, episode,
    description: y.description ?? '', mode: y.mode ?? null, duration: y.duration ?? null,
    characters, versions,
  };
}

function mapVariants(projectRoot, v) {
  return {
    alpha: relTo(projectRoot, v.alpha),
    upscaled: v.upscaled.map((p) => relTo(projectRoot, p)),
    qc: v.qc.map((p) => relTo(projectRoot, p)),
  };
}

export async function scanShots(projectRoot, { episodes } = {}) {
  const roots = await discoverShotRoots(projectRoot);
  const shots = [];
  for (const { root: shotRoot, episode } of roots) {
    if (episodes && episodes.length && (episode == null || !episodes.includes(episode))) continue;
    for (const id of (await listDirs(path.join(shotRoot, 'shots'))).sort()) {
      shots.push(await scanOneShot(projectRoot, shotRoot, episode, id));
    }
  }
  return { generatedAt: new Date().toISOString(), type: 'shots', shots };
}
