#!/usr/bin/env node
// Regenerate the pages table in web/README.md from the folders in web/.
//
// Descriptions in that table are hand-written prose — the generator preserves
// whatever is already there, keyed by folder name, and only ever adds rows for
// new pages or drops rows for deleted ones. A new page gets a placeholder
// description seeded from its <title>/subtitle, marked TODO so it is obvious
// the prose still needs a human.
//
//   node scripts/update-web-index.js           rewrite the table
//   node scripts/update-web-index.js --check   exit 1 if the table is stale
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'web');
const readmePath = join(webDir, 'README.md');

const START = '<!-- pages:start -->';
const END = '<!-- pages:end -->';
const TODO = '_TODO: describe this page._';

// Named entities our pages actually use in titles and subtitles; numeric refs
// (&#8212; / &#x2014;) are decoded generically below.
const ENTITIES = {
  '&mdash;': '—', '&ndash;': '–', '&times;': '×', '&nbsp;': ' ', '&middot;': '·',
  '&hellip;': '…', '&lsquo;': '‘', '&rsquo;': '’', '&ldquo;': '“', '&rdquo;': '”',
  '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&',
};

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

function text(html) {
  return decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// Every web/<slug>/ that actually has a page in it.
function findPages() {
  return readdirSync(webDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(webDir, e.name, 'index.html')))
    .map((e) => e.name)
    .sort();
}

// Seed text for a page we have not seen before: subtitle if the page has one,
// otherwise its <title>. Either way it is a starting point, not final prose.
function seedDescription(slug) {
  const html = readFileSync(join(webDir, slug, 'index.html'), 'utf8');
  const sub = html.match(/<p[^>]*class="[^"]*\bsub\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  if (sub) return `${text(sub[1])} ${TODO}`;
  const title = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (title) return `${text(title[1])} ${TODO}`;
  return TODO;
}

// Pull existing descriptions out of the current table so hand-written prose
// survives regeneration. Row shape: | [slug](slug/index.html) | description |
function existingDescriptions(block) {
  const found = new Map();
  for (const line of block.split('\n')) {
    const row = line.match(/^\|\s*\[([^\]]+)\]\([^)]*\)\s*\|(.*)\|\s*$/);
    if (row) found.set(row[1].trim(), row[2].trim());
  }
  return found;
}

function buildTable(slugs, descriptions) {
  const rows = slugs.map((slug) => {
    const desc = descriptions.get(slug) ?? seedDescription(slug);
    return `| [${slug}](${slug}/index.html) | ${desc.replace(/\|/g, '\\|')} |`;
  });
  return ['| Page | What it shows |', '| --- | --- |', ...rows].join('\n');
}

const check = process.argv.includes('--check');
const readme = readFileSync(readmePath, 'utf8');
const start = readme.indexOf(START);
const end = readme.indexOf(END);

if (start === -1 || end === -1 || end < start) {
  console.error(`${readmePath}: missing ${START} / ${END} markers around the pages table.`);
  process.exit(1);
}

const before = readme.slice(0, start + START.length);
const block = readme.slice(start + START.length, end);
const after = readme.slice(end);

const slugs = findPages();
const updated = `${before}\n${buildTable(slugs, existingDescriptions(block))}\n${after}`;

if (updated === readme) {
  if (!check) console.log(`web/README.md is up to date (${slugs.length} page(s)).`);
  process.exit(0);
}

if (check) {
  console.error('web/README.md pages table is out of date. Run: npm run web:index');
  process.exit(1);
}

writeFileSync(readmePath, updated);
console.log(`Updated web/README.md (${slugs.length} page(s)).`);
