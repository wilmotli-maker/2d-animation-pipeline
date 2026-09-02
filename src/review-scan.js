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
    const { model, resolution, aspectRatio, mode, ts } = j;
    return { model, resolution, aspectRatio, mode, ts };
  } catch { return {}; }
}

// The draft version promoted to final, from final/source-draft.txt (e.g. "v006").
// null when the shot has no promoted draft.
async function readPromotedVersion(finalDir) {
  try {
    const raw = (await readFile(path.join(finalDir, 'source-draft.txt'), 'utf8')).trim();
    const m = /^v\d+$/.exec(raw);
    return m ? raw : null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function scanOneShot(projectRoot, shotRoot, episode, id) {
  const y = await readShotYaml(shotRoot, id);
  const characters = Array.isArray(y.elements)
    ? y.elements.map((e) => (typeof e === 'string' ? e : e && e.name)).filter(Boolean) : [];
  const versions = [];

  // Which draft was promoted to final. The final/ folder itself is not surfaced as
  // a version — it holds alpha/comparison renders (often soundless), and the real
  // deliverable is the draft named in source-draft.txt. We just badge that draft.
  const promotedVersion = await readPromotedVersion(shotFinalDir(shotRoot, id));

  const draftsDir = shotDraftsDir(shotRoot, id);
  const draftNames = (await listDirs(draftsDir)).filter((n) => /^v\d+$/.test(n))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const v of draftNames) {
    const dir = shotVersionDir(shotRoot, id, Number(v.slice(1)));
    const video = path.join(dir, 'output.mp4');
    // Skip versions with no valid output (e.g. a draft folder that only has
    // prompt.md/notes.md) so they don't render as "missing artifact" columns.
    if (!(await fileExists(video))) continue;
    versions.push({
      version: v, kind: 'draft',
      promoted: v === promotedVersion,
      video: relTo(projectRoot, video),
      variants: mapVariants(projectRoot, await readVariants(dir)),
      meta: await readMeta(dir),
    });
  }

  return {
    shotId: id, episode,
    description: y.description ?? '', mode: y.mode ?? null, duration: y.duration ?? null,
    promotedVersion, characters, versions,
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

function pushVersion(map, key, entry) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(entry);
}

async function readGenerationsLog(elDir) {
  try {
    const text = await readFile(path.join(elDir, 'generations.jsonl'), 'utf8');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Walk sheets/<sheetType>/(<slug>/)?vNNN.<img> for elements without a usable log.
async function walkSheets(projectRoot, elDir) {
  const sheetsDir = path.join(elDir, 'sheets');
  const found = new Map(); // `${sheetType}\u0000${slug}` -> [{version, images}]
  for (const sheetType of await listDirs(sheetsDir)) {
    const typeDir = path.join(sheetsDir, sheetType);
    const direct = (await listFiles(typeDir)).filter((n) => /^v\d+\.(png|jpe?g|webp)$/i.test(n));
    for (const f of direct) {
      pushVersion(found, `${sheetType}\u0000`, {
        version: f.replace(/\.[^.]+$/, ''),
        images: [relTo(projectRoot, path.join(typeDir, f))], upscaled: [], meta: {},
      });
    }
    for (const slug of await listDirs(typeDir)) {
      const slugDir = path.join(typeDir, slug);
      const imgs = (await listFiles(slugDir)).filter((n) => /\.(png|jpe?g|webp)$/i.test(n));
      const byV = new Map();
      for (const f of imgs) {
        const m = /^(v\d+)/.exec(f);
        const v = m ? m[1] : 'v001';
        if (!byV.has(v)) byV.set(v, []);
        byV.get(v).push(relTo(projectRoot, path.join(slugDir, f)));
      }
      for (const [v, images] of byV) {
        pushVersion(found, `${sheetType}\u0000${slug}`, { version: v, images, upscaled: [], meta: {} });
      }
    }
  }
  return found;
}

function sheetEntriesFromMap(map) {
  const sheets = [];
  for (const [key, versions] of map) {
    const [sheetType, slug] = key.split('\u0000');
    versions.sort((a, b) => Number(a.version.slice(1)) - Number(b.version.slice(1)));
    sheets.push({ sheetType, slug, versions });
  }
  return sheets.sort((a, b) => (a.sheetType + a.slug).localeCompare(b.sheetType + b.slug));
}

async function scanOneElement(projectRoot, type, name, elDir) {
  const log = await readGenerationsLog(elDir);
  const map = new Map();
  if (log && log.some((e) => e.sheetType)) {
    for (const e of log) {
      if (!e.sheetType) continue;
      const slug = e.sheetId ?? '';
      const images = e.panels && e.panels.length
        ? e.panels.map((p) => relTo(projectRoot, path.isAbsolute(p) ? p : path.join(projectRoot, p)))
        : (e.output ? [relTo(projectRoot, path.isAbsolute(e.output) ? e.output : path.join(projectRoot, e.output))] : []);
      pushVersion(map, `${e.sheetType}\u0000${slug}`, {
        version: e.version ?? 'v001', images, upscaled: [],
        meta: { model: e.model, prompt: e.prompt, ts: e.ts },
      });
    }
  } else {
    for (const [k, v] of await walkSheets(projectRoot, elDir)) map.set(k, v);
  }
  return { type, name, sheets: sheetEntriesFromMap(map) };
}

export async function scanImages(projectRoot) {
  const elementsDir = path.join(projectRoot, 'elements');
  const characters = [];
  for (const type of await listDirs(elementsDir)) {
    for (const name of await listDirs(path.join(elementsDir, type))) {
      const elDir = path.join(elementsDir, type, name);
      const entry = await scanOneElement(projectRoot, type, name, elDir);
      if (entry.sheets.length) characters.push(entry);
    }
  }
  return { generatedAt: new Date().toISOString(), type: 'images', characters };
}

// A flat, manually-curated folder of shot files (e.g. episodes/N/shots/candidates/).
// Filenames encode shot + version as "<shotId>-vNNN.<ext>"; a file with no -vNNN
// suffix is a single-version shot (v001). Non-video files are skipped. Emits the
// same model shape as scanShots so filtering/selection/vendoring/rendering are reused.
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v']);

export async function scanFolder(projectRoot, dir) {
  const byShot = new Map();
  for (const name of await listFiles(dir)) {
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
    if (!VIDEO_EXT.has(ext)) continue;
    const stem = name.slice(0, dot);
    const m = /^(.+)-(v\d+)$/.exec(stem);       // "-v003" (empty stem) fails .+ -> falls through
    const shotId = m ? m[1] : stem;
    const version = m ? m[2] : 'v001';
    if (!byShot.has(shotId)) byShot.set(shotId, []);
    byShot.get(shotId).push({
      version, kind: 'draft', promoted: false,
      video: relTo(projectRoot, path.join(dir, name)),
      variants: { alpha: null, upscaled: [], qc: [] }, meta: {},
    });
  }
  const shots = [...byShot.entries()].map(([shotId, versions]) => {
    versions.sort((a, b) => (parseInt(a.version.slice(1), 10) || 0) - (parseInt(b.version.slice(1), 10) || 0));
    return { shotId, episode: null, description: '', mode: null, duration: null, promotedVersion: null, characters: [], versions };
  }).sort((a, b) => a.shotId.localeCompare(b.shotId));
  return { generatedAt: new Date().toISOString(), type: 'shots', shots };
}
