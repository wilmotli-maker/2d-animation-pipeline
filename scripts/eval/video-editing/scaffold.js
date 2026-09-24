#!/usr/bin/env node
// Materialize the test folder structure from tests.json (the single source of
// truth). Creates evaluation/video-editing-eval/<category>/<id>/ for every test
// and writes a human-readable prompt.md into each, so the edit definitions live
// in the folder structure. Idempotent; never touches generated media.
//
//   node scaffold.js            # create/refresh all test folders + prompt.md
//   node scaffold.js --list     # print the matrix, write nothing

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

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

console.log(`${manifest.suite}: ${manifest.tests.length} tests\n`);
for (const cat of Object.keys(manifest.categories)) {
  const inCat = manifest.tests.filter((t) => t.category === cat);
  console.log(`${cat} — ${manifest.categories[cat]}`);
  for (const t of inCat) {
    const sourceAbs = path.join(manifest.sourceBase, t.source);
    console.log(`  [${t.status === 'done' ? 'x' : ' '}] ${t.id.padEnd(24)} ${t.character.padEnd(8)} ${t.source}`);
    if (listOnly) continue;
    const dir = path.join(repoRoot, manifest.evalRoot, cat, t.id);
    await mkdir(path.join(dir, (t.model || manifest.defaults.model)), { recursive: true });
    await writeFile(path.join(dir, 'prompt.md'), promptMd(t, sourceAbs, manifest.defaults));
  }
  console.log('');
}
console.log(listOnly ? '(--list: nothing written)' : `Scaffolded under ${manifest.evalRoot}/`);
