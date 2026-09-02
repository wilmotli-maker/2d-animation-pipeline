// src/review-page.js
import { mkdir, copyFile, writeFile, readFile, stat, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { scanShots, scanImages, scanFolder } from './review-scan.js';
import {
  applyShotFilters, applyImageFilters, defaultShotSelection, defaultImageSelection,
} from './review-filter.js';
import { renderShotPage, renderImagePage } from './review-render.js';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }
async function readJson(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }

// On --update, the version selection is refreshed to the current model (all
// versions) so newly-added drafts appear and removed ones drop off; per-version
// curation is a client-side concern (the page's per-column hide control), so
// there is no stored per-version selection to preserve — only the layout carries
// over from the stored page.
function mergeSelection(stored, fresh) {
  if (!stored) return fresh;
  return { layout: stored.layout || fresh.layout, versions: fresh.versions };
}

// Copy one source file into the page's assets/ tree and return its page-relative path.
// `seen` maps dest -> source across the whole build so we can warn (not abort) when two
// distinct sources collide on the same vendored destination.
async function vendorFile(projectRoot, pageDir, relSrc, seen) {
  if (!relSrc) return null;
  const src = path.join(projectRoot, relSrc);
  if (!(await exists(src))) return null;
  const destRel = path.join('assets', relSrc.replace(/^(\.\.[/\\])+/, ''));
  const dest = path.join(pageDir, destRel);
  const destKey = destRel.split(path.sep).join('/');
  if (seen) {
    const previous = seen.get(destKey);
    if (previous && previous !== src) {
      console.warn(`review: asset path collision — "${src}" overwrites "${previous}" at ${destKey}`);
    }
    seen.set(destKey, src);
  }
  await mkdir(path.dirname(dest), { recursive: true });
  if ((await stat(src)).isDirectory()) await cp(src, dest, { recursive: true });
  else await copyFile(src, dest);
  return destKey;
}

// Rewrite every artifact path in the model to a vendored page-relative path.
async function vendorShotModel(projectRoot, pageDir, model, seen) {
  const shots = [];
  for (const s of model.shots) {
    const versions = [];
    for (const v of s.versions) {
      versions.push({
        ...v,
        video: await vendorFile(projectRoot, pageDir, v.video, seen),
        variants: {
          alpha: await vendorFile(projectRoot, pageDir, v.variants.alpha, seen),
          upscaled: (await Promise.all(v.variants.upscaled.map((u) => vendorFile(projectRoot, pageDir, u, seen)))).filter(Boolean),
          qc: (await Promise.all(v.variants.qc.map((q) => vendorFile(projectRoot, pageDir, q, seen)))).filter(Boolean),
        },
      });
    }
    shots.push({ ...s, versions });
  }
  return { ...model, shots };
}

async function vendorImageModel(projectRoot, pageDir, model, seen) {
  const characters = [];
  for (const c of model.characters) {
    const sheets = [];
    for (const sh of c.sheets) {
      const versions = [];
      for (const v of sh.versions) {
        versions.push({
          ...v,
          images: (await Promise.all(v.images.map((i) => vendorFile(projectRoot, pageDir, i, seen)))).filter(Boolean),
          upscaled: (await Promise.all((v.upscaled || []).map((u) => vendorFile(projectRoot, pageDir, u, seen)))).filter(Boolean),
        });
      }
      sheets.push({ ...sh, versions });
    }
    characters.push({ ...c, sheets });
  }
  return { ...model, characters };
}

// Warn to stderr (and skip, not abort) when a requested filter value doesn't match
// anything in the raw scanned model.
function warnUnknownFilters(type, raw, filters) {
  const warnFor = (kind, requested, available) => {
    if (!requested || !requested.length) return;
    const known = new Set(available);
    for (const value of requested) {
      if (!known.has(value)) console.warn(`review: no ${kind} matching "${value}"`);
    }
  };

  if (type === 'images') {
    const chars = new Set();
    const sheets = new Set();
    for (const c of raw.characters) {
      chars.add(c.name);
      for (const sh of c.sheets) sheets.add(sh.sheetType);
    }
    warnFor('character', filters.characters, chars);
    warnFor('sheet', filters.sheets, sheets);
  } else {
    const chars = new Set();
    const episodes = new Set();
    for (const s of raw.shots) {
      for (const c of s.characters) chars.add(c);
      if (s.episode != null) episodes.add(s.episode);
    }
    warnFor('character', filters.characters, chars);
    warnFor('episode', filters.episodes, episodes);
  }
}

export async function buildReviewPage(root, opts) {
  const { type, slug, filters = {}, selection: providedSelection, update = false, title, out, folder } = opts;
  if (!slug) throw new Error('review: --slug is required');

  // Pages are project-specific output, not pipeline tooling. Default to a `web/`
  // folder off the project root (created if missing); --out overrides the base dir.
  const outBase = out ? path.resolve(out) : path.join(root, 'web');

  if (folder && type !== 'shots') throw new Error("review: --folder is only valid with 'shots'");
  const folderAbs = folder ? path.resolve(folder) : null;

  const raw = folderAbs
    ? await scanFolder(root, folderAbs)
    : (type === 'images' ? await scanImages(root) : await scanShots(root, { episodes: filters.episodes }));
  if (folderAbs && raw.shots.length === 0) throw new Error(`review: no video files in ${folderAbs}`);

  warnUnknownFilters(type, raw, filters);
  const filtered = type === 'images' ? applyImageFilters(raw, filters) : applyShotFilters(raw, filters);
  const count = type === 'images'
    ? filtered.characters.reduce((a, c) => a + c.sheets.length, 0) : filtered.shots.length;
  if (count === 0) throw new Error(`review: no ${type} match the given filters`);

  const pageDir = path.join(outBase, slug);
  const pageExists = await exists(pageDir);
  if (pageExists && !update) {
    throw new Error(`review: ${pageDir} already exists — pass --update to refresh it or choose a new --slug/--out`);
  }

  const fresh = type === 'images' ? defaultImageSelection(filtered) : defaultShotSelection(filtered);
  const stored = update ? await readJson(path.join(pageDir, 'review.json')) : null;
  const selection = providedSelection || mergeSelection(stored && stored.selection, fresh);

  // Vendor from a clean slate so a rebuild never leaves orphaned media behind —
  // e.g. the (no-longer-surfaced) final/ clips, dropped drafts, or artifacts that
  // fall outside a narrowed filter. Everything under assets/ is a copy that this
  // build re-creates, so wiping it first is safe.
  await rm(path.join(pageDir, 'assets'), { recursive: true, force: true });
  await mkdir(pageDir, { recursive: true });
  const seen = new Map();
  const pageModel = type === 'images'
    ? await vendorImageModel(root, pageDir, filtered, seen)
    : await vendorShotModel(root, pageDir, filtered, seen);

  const html = type === 'images'
    ? renderImagePage({ model: pageModel, selection, title: title || 'Image review', slug, type })
    : renderShotPage({ model: pageModel, selection, title: title || 'Shot review', slug, type });

  await writeFile(path.join(pageDir, 'index.html'), html);
  await writeFile(path.join(pageDir, 'review.json'),
    JSON.stringify({ type, filters, selection, model: filtered, generatedAt: new Date().toISOString() }, null, 2) + '\n');

  return { pageDir, count };
}

function splitList(s) { return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined; }

// Pure arg parser for `pipeline review <sub> ...`. `--update` is a valueless boolean.
export function parseReviewArgs(sub, rest) {
  if (sub !== 'shots' && sub !== 'images') {
    throw new Error('usage: pipeline review <shots|images> --slug <name> [filters]');
  }
  const argv = rest.filter((t) => t !== '--update');
  const update = argv.length !== rest.length;
  const f = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`review: expected --flag, got "${argv[i]}"`);
    f[argv[i].slice(2)] = argv[i + 1];
  }
  const filters = {};
  if (f.match) filters.match = f.match;
  if (f.exclude) filters.exclude = f.exclude;
  if (f.characters) filters.characters = splitList(f.characters);
  if (sub === 'shots' && f.episode) filters.episodes = splitList(f.episode);
  if (sub === 'images' && f.sheets) filters.sheets = splitList(f.sheets);
  return { type: sub, slug: f.slug, title: f.title, root: f.root, out: f.out, folder: f.folder, layout: f.layout, filters, update };
}
