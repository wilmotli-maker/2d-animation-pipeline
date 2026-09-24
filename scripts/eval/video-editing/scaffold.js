#!/usr/bin/env node
// Materialize the test folder structure from tests.json (the single source of
// truth). Creates evaluation/video-editing-eval/<category>/<id>/ for every test
// and writes a human-readable prompt.md into each, so the edit definitions live
// in the folder structure. Idempotent; never touches generated media.
//
//   node scaffold.js            # create/refresh all test folders + prompt.md
//   node scaffold.js --list     # print the matrix, write nothing

import { readFile, mkdir, writeFile, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

async function exists(p) { try { await access(p); return true; } catch { return false; } }

function promptMd(t, sourceAbs, defaults) {
  const lines = [
    `# ${t.id}`,
    '',
    `- **category:** ${t.category}`,
    `- **character:** ${t.character}`,
    `- **status:** ${t.status}`,
    `- **source:** ${sourceAbs}`,
    `- **model (default):** ${t.model || defaults.model}`,
    `- **ratio:** ${t.ratio || defaults.ratio}`,
  ];
  if (t.moment != null) lines.push(`- **moment:** ${t.moment}s`);
  lines.push('', '## Edit prompt', '', t.prompt, '', '## Must preserve', '', t.preserve || '(unspecified)');
  if (t.notes) lines.push('', '## Notes', '', t.notes);
  lines.push('', '---', '_Generated from tests.json by scaffold.js — edit tests.json, not this file._', '');
  return lines.join('\n');
}

const manifest = JSON.parse(await readFile(path.join(here, 'tests.json'), 'utf8'));
const listOnly = process.argv.includes('--list');
const localSourcesDir = path.join(repoRoot, manifest.evalRoot, manifest.localSources);

// Copy each distinct input clip from its origin into the eval folder so the suite
// is self-contained (runnable without the external source drive). Copies once;
// skips clips already present. A missing origin is only a problem if the local
// copy also doesn't exist yet.
async function ensureLocalSource(source) {
  const local = path.join(localSourcesDir, source);
  if (await exists(local)) return { local, copied: false };
  const origin = path.join(manifest.sourceOrigin, source);
  if (!(await exists(origin))) return { local, copied: false, missing: true };
  await mkdir(localSourcesDir, { recursive: true });
  await copyFile(origin, local);
  return { local, copied: true };
}

console.log(`${manifest.suite}: ${manifest.tests.length} tests\n`);
const missing = [];
for (const cat of Object.keys(manifest.categories)) {
  const inCat = manifest.tests.filter((t) => t.category === cat);
  console.log(`${cat} — ${manifest.categories[cat]}`);
  for (const t of inCat) {
    console.log(`  [${t.status === 'done' ? 'x' : ' '}] ${t.id.padEnd(24)} ${t.character.padEnd(8)} ${t.source}`);
    if (listOnly) continue;
    const src = await ensureLocalSource(t.source);
    if (src.missing) missing.push(`${t.source} (needed by ${t.id})`);
    if (src.copied) console.log(`      copied source -> ${manifest.localSources}/${t.source}`);
    const dir = path.join(repoRoot, manifest.evalRoot, cat, t.id);
    await mkdir(path.join(dir, (t.model || manifest.defaults.model)), { recursive: true });
    // prompt.md points at the LOCAL copy so the folder documents itself.
    await writeFile(path.join(dir, 'prompt.md'),
      promptMd(t, path.join(manifest.evalRoot, manifest.localSources, t.source), manifest.defaults));
  }
  console.log('');
}
if (missing.length) {
  console.log('WARNING: source clip(s) not found at origin and not yet copied locally:');
  for (const m of missing) console.log(`  - ${m}`);
  console.log(`  origin: ${manifest.sourceOrigin}`);
}
console.log(listOnly ? '(--list: nothing written)' : `Scaffolded under ${manifest.evalRoot}/ (inputs in ${manifest.localSources}/)`);
