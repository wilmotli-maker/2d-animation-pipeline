// src/review-page.js
import { mkdir, copyFile, writeFile, readFile, stat, cp } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanShots, scanImages } from './review-scan.js';
import {
  applyShotFilters, applyImageFilters, defaultShotSelection, defaultImageSelection,
} from './review-filter.js';
import { renderShotPage, renderImagePage } from './review-render.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }
async function readJson(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }

// Merge a stored selection with fresh defaults: keep stored picks for items that
// still exist; add default picks for items that appeared since.
function mergeSelection(stored, fresh) {
  if (!stored) return fresh;
  const versions = { ...fresh.versions };
  for (const [k, v] of Object.entries(stored.versions || {})) {
    if (k in versions) versions[k] = v;
  }
  return { layout: stored.layout || fresh.layout, versions };
}

// Copy one source file into the page's assets/ tree and return its page-relative path.
async function vendorFile(projectRoot, pageDir, relSrc) {
  if (!relSrc) return null;
  const src = path.join(projectRoot, relSrc);
  if (!(await exists(src))) return null;
  const destRel = path.join('assets', relSrc.replace(/^(\.\.[/\\])+/, ''));
  const dest = path.join(pageDir, destRel);
  await mkdir(path.dirname(dest), { recursive: true });
  if ((await stat(src)).isDirectory()) await cp(src, dest, { recursive: true });
  else await copyFile(src, dest);
  return destRel.split(path.sep).join('/');
}

// Rewrite every artifact path in the model to a vendored page-relative path.
async function vendorShotModel(projectRoot, pageDir, model) {
  const shots = [];
  for (const s of model.shots) {
    const versions = [];
    for (const v of s.versions) {
      versions.push({
        ...v,
        video: await vendorFile(projectRoot, pageDir, v.video),
        variants: {
          alpha: await vendorFile(projectRoot, pageDir, v.variants.alpha),
          upscaled: (await Promise.all(v.variants.upscaled.map((u) => vendorFile(projectRoot, pageDir, u)))).filter(Boolean),
          qc: (await Promise.all(v.variants.qc.map((q) => vendorFile(projectRoot, pageDir, q)))).filter(Boolean),
        },
      });
    }
    shots.push({ ...s, versions });
  }
  return { ...model, shots };
}

async function vendorImageModel(projectRoot, pageDir, model) {
  const characters = [];
  for (const c of model.characters) {
    const sheets = [];
    for (const sh of c.sheets) {
      const versions = [];
      for (const v of sh.versions) {
        versions.push({
          ...v,
          images: (await Promise.all(v.images.map((i) => vendorFile(projectRoot, pageDir, i)))).filter(Boolean),
          upscaled: (await Promise.all((v.upscaled || []).map((u) => vendorFile(projectRoot, pageDir, u)))).filter(Boolean),
        });
      }
      sheets.push({ ...sh, versions });
    }
    characters.push({ ...c, sheets });
  }
  return { ...model, characters };
}

async function refreshWebIndex(projectRoot) {
  const script = path.join(__dirname, '..', 'scripts', 'update-web-index.js');
  if (!(await exists(script)) || !(await exists(path.join(projectRoot, 'web', 'README.md')))) return;
  try { await execFileP(process.execPath, [script], { cwd: projectRoot }); } catch { /* index is best-effort */ }
}

export async function buildReviewPage(root, opts) {
  const { type, slug, filters = {}, selection: providedSelection, update = false, title } = opts;
  if (!slug) throw new Error('review: --slug is required');

  const raw = type === 'images' ? await scanImages(root) : await scanShots(root, { episodes: filters.episodes });
  const filtered = type === 'images' ? applyImageFilters(raw, filters) : applyShotFilters(raw, filters);
  const count = type === 'images'
    ? filtered.characters.reduce((a, c) => a + c.sheets.length, 0) : filtered.shots.length;
  if (count === 0) throw new Error(`review: no ${type} match the given filters`);

  const pageDir = path.join(root, 'web', slug);
  const pageExists = await exists(pageDir);
  if (pageExists && !update) {
    throw new Error(`review: web/${slug}/ already exists — pass --update to refresh it or choose a new --slug`);
  }

  const fresh = type === 'images' ? defaultImageSelection(filtered) : defaultShotSelection(filtered);
  const stored = update ? await readJson(path.join(pageDir, 'review.json')) : null;
  const selection = providedSelection || mergeSelection(stored && stored.selection, fresh);

  await mkdir(pageDir, { recursive: true });
  const pageModel = type === 'images'
    ? await vendorImageModel(root, pageDir, filtered)
    : await vendorShotModel(root, pageDir, filtered);

  const html = type === 'images'
    ? renderImagePage({ model: pageModel, selection, title: title || 'Image review' })
    : renderShotPage({ model: pageModel, selection, title: title || 'Shot review' });

  await writeFile(path.join(pageDir, 'index.html'), html);
  await writeFile(path.join(pageDir, 'review.json'),
    JSON.stringify({ type, filters, selection, model: filtered, generatedAt: new Date().toISOString() }, null, 2) + '\n');

  await refreshWebIndex(root);
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
  if (f.characters) filters.characters = splitList(f.characters);
  if (sub === 'shots' && f.episode) filters.episodes = splitList(f.episode);
  if (sub === 'images' && f.sheets) filters.sheets = splitList(f.sheets);
  return { type: sub, slug: f.slug, title: f.title, root: f.root, layout: f.layout, filters, update };
}
