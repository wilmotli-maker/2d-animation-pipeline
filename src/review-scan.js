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

// Numeric-aware compare so shot ids sort chronologically (ai-1, ai-2, … ai-10)
// rather than lexicographically (ai-1, ai-10, ai-11, ai-2).
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
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
    if (name === 'alpha.mov' || name === 'alpha.mp4' || name === 'alpha.webm') out.alpha = path.join(versionDir, name);
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
  // deliverable is the draft named in source-draft.txt. We just badge that draft,
  // and attribute final/'s alpha, upscales and qc to it (`pipeline shot matte`
  // without --version writes them to final/).
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
    const variants = await readVariants(dir);
    if (v === promotedVersion) {
      const fin = await readVariants(shotFinalDir(shotRoot, id));
      variants.alpha ??= fin.alpha;
      variants.upscaled.push(...fin.upscaled);
      variants.qc.push(...fin.qc);
    }
    versions.push({
      version: v, kind: 'draft',
      promoted: v === promotedVersion,
      video: relTo(projectRoot, video),
      variants: mapVariants(projectRoot, variants),
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

// A folder under shots/ is a shot only if it has a shot.yaml or a drafts/ dir;
// anything else (candidates/, assembled/, …) is a working folder, not a shot.
export async function isShotDir(dir) {
  return (await fileExists(path.join(dir, 'shot.yaml'))) || (await isDir(path.join(dir, 'drafts')));
}

export async function scanShots(projectRoot, { episodes } = {}) {
  const roots = await discoverShotRoots(projectRoot);
  const shots = [];
  for (const { root: shotRoot, episode } of roots) {
    if (episodes && episodes.length && (episode == null || !episodes.includes(episode))) continue;
    for (const id of (await listDirs(path.join(shotRoot, 'shots'))).sort(naturalCompare)) {
      if (!(await isShotDir(path.join(shotRoot, 'shots', id)))) continue;
      shots.push(await scanOneShot(projectRoot, shotRoot, episode, id));
    }
  }
  return { generatedAt: new Date().toISOString(), type: 'shots', shots };
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

const IMG_RE = /\.(png|jpe?g|webp)$/i;
const sortNatural = (names) => [...names].sort(naturalCompare);

// Versions found directly in one directory (a slug dir, or a sheetType dir for the
// slug-less layout). Disk is the source of truth, so this never consults the log.
//   vNNN.<img> and/or vNNN/<images>   -> a version (per-panel images win over the composite)
//   vNNN.upscaled-*.<img>             -> that version's `upscaled`, never a version itself
//   no vNNN at all, only loose images -> a candidates folder: one version per image
async function readSheetVersions(projectRoot, dir) {
  const files = (await listFiles(dir)).filter((n) => !n.startsWith('.'));
  const images = files.filter((n) => IMG_RE.test(n));
  const rel = (name) => relTo(projectRoot, path.join(dir, name));

  const byV = new Map(); // 'v001' -> { composite, panels, extras, upscaled }
  const norm = (n) => formatVersion(Number(n)); // V001 / v1 / v001 all -> v001
  const slot = (n) => {
    const v = norm(n);
    if (!byV.has(v)) byV.set(v, { composite: null, panels: [], extras: [], upscaled: [] });
    return byV.get(v);
  };
  for (const f of sortNatural(images)) {
    const up = /^v(\d+)\.upscaled-.+\.[^.]+$/i.exec(f);
    if (up) { slot(up[1]).upscaled.push(f); continue; }
    const m = /^v(\d+)\.[^.]+$/i.exec(f);
    if (m) {
      const sl = slot(m[1]);
      sl.composite ??= f; // duplicate composites (V001.PNG + v1.png): first by natural order wins
      continue;
    }
    const ex = /^v(\d+)[-_].+\.[^.]+$/i.exec(f); // v001-alt.png: another image of that version
    if (ex) slot(ex[1]).extras.push(f);
  }
  // Alias dirs (v1/, V001/, v001/) normalize to one version: merge their panels.
  // Duplicate file name across alias dirs -> keep one, preferring the canonical
  // `v001/` dir, then the others in sorted dir-name order.
  const panelDirs = new Map(); // 'v001' -> [dirName]
  for (const d of await listDirs(dir)) {
    const m = /^v(\d+)$/i.exec(d); // also skips vNNN.upscaled-*/ panel dirs
    if (!m) continue;
    const v = norm(m[1]);
    if (!panelDirs.has(v)) panelDirs.set(v, []);
    panelDirs.get(v).push(d);
  }
  for (const [v, names] of panelDirs) {
    const ordered = [...names.filter((d) => d === v), ...names.filter((d) => d !== v).sort()];
    const seen = new Map(); // file name -> relative path
    for (const d of ordered) {
      for (const n of (await listFiles(path.join(dir, d))).filter((f) => IMG_RE.test(f))) {
        if (!seen.has(n)) seen.set(n, path.join(d, n));
      }
    }
    if (seen.size) slot(v.slice(1)).panels = sortNatural([...seen.keys()]).map((n) => seen.get(n));
  }

  const versions = [...byV.entries()]
    .filter(([, v]) => v.composite || v.panels.length)
    .sort(([a], [b]) => naturalCompare(a, b))
    .map(([version, v]) => ({
      version,
      images: [...(v.panels.length ? v.panels.map(rel) : [rel(v.composite)]), ...v.extras.map(rel)],
      upscaled: sortNatural(v.upscaled).map(rel),
      meta: {},
    }));
  if (versions.length) return versions;

  // Candidates folder: loose, unversioned images are alternatives to review.
  // <stem>.upscaled-<tag>.<img> files belong to the candidate <stem>.<ext>.
  const loose = images.filter((n) => !/^v\d+([._-]|$)/i.test(n));
  const upRe = /^(.+?)\.upscaled-.+\.[^.]+$/i;
  const cands = sortNatural(loose.filter((n) => !upRe.test(n)));
  const stemOf = (n) => n.slice(0, n.lastIndexOf('.'));
  return cands.map((n) => ({
    // Version id = file name: stable when siblings are added/removed (selections key on it).
    version: n, images: [rel(n)],
    upscaled: sortNatural(loose.filter((u) => { const m = upRe.exec(u); return m && m[1] === stemOf(n); })).map(rel),
    meta: { label: n },
  }));
}

async function walkSheets(projectRoot, elDir) {
  const sheetsDir = path.join(elDir, 'sheets');
  const found = []; // [{ sheetType, slug, versions }]
  for (const sheetType of await listDirs(sheetsDir)) {
    const typeDir = path.join(sheetsDir, sheetType);
    const slugs = ['']; // '' = images directly in the sheetType dir; kept as candidates so real reference images surface
    // Slug dirs only: not hidden, not vNNN panel dirs or vNNN.upscaled-*/ dirs.
    for (const d of await listDirs(typeDir)) if (!/^\./.test(d) && !/^v\d+(\.|$)/i.test(d)) slugs.push(d);
    for (const slug of slugs) {
      const versions = await readSheetVersions(projectRoot, slug ? path.join(typeDir, slug) : typeDir);
      if (versions.length) found.push({ sheetType, slug, versions });
    }
  }
  return found.sort((a, b) => (a.sheetType + a.slug).localeCompare(b.sheetType + b.slug));
}

// Log metadata keyed by sheetType/slug/version; the last entry wins so a
// regeneration of the same version shows its latest model/prompt.
function logMetaMap(log) {
  const map = new Map();
  for (const e of log || []) {
    if (!e.sheetType) continue;
    const vm = /^v(\d+)$/i.exec(e.version ?? 'v001');
    const version = vm ? formatVersion(Number(vm[1])) : e.version;
    map.set(`${e.sheetType}\u0000${e.sheetId ?? ''}\u0000${version}`,
      { model: e.model, prompt: e.prompt, ts: e.ts });
  }
  return map;
}

async function scanOneElement(projectRoot, type, name, elDir) {
  const meta = logMetaMap(await readGenerationsLog(elDir));
  const sheets = await walkSheets(projectRoot, elDir);
  for (const s of sheets) {
    for (const v of s.versions) {
      v.meta = { ...v.meta, ...meta.get(`${s.sheetType}\u0000${s.slug}\u0000${v.version}`) };
    }
  }
  return { type, name, sheets };
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
    if (!shotId) continue;                       // e.g. a bare ".mp4" — no shot id to key on
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
  }).sort((a, b) => naturalCompare(a.shotId, b.shotId));
  return { generatedAt: new Date().toISOString(), type: 'shots', shots };
}
