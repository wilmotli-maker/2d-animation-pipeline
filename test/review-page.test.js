// test/review-page.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { buildReviewPage } from '../src/review-page.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-page-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function seedShot(root, id) {
  const dir = path.join(root, 'shots', id, 'drafts', 'v001');
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(root, 'shots', id, 'final'), { recursive: true });
  await writeFile(path.join(dir, 'output.mp4'), 'video-bytes');
  await writeFile(path.join(dir, 'output.json'),
    JSON.stringify({ model: 'seedance_2_5', resolution: '480p', ts: 'T' }));
  await writeFile(path.join(root, 'shots', id, 'shot.yaml'),
    YAML.stringify({ shotId: id, elements: [{ type: 'characters', name: 'mira' }] }));
}

test('buildReviewPage: vendors clips and writes a self-contained bundle', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'art-talk-01');
    const res = await buildReviewPage(root, { type: 'shots', slug: 'ep1', title: 'Ep 1' });
    const html = await readFile(path.join(root, 'web', 'ep1', 'index.html'), 'utf8');
    assert.match(html, /assets\//);
    assert.doesNotMatch(html, /https?:\/\//);
    // vendored clip exists under web/ep1/assets and is referenced page-relative
    const vendored = path.join(root, 'web', 'ep1', 'assets', 'shots', 'art-talk-01', 'drafts', 'v001', 'output.mp4');
    assert.ok((await stat(vendored)).isFile());
    const saved = JSON.parse(await readFile(path.join(root, 'web', 'ep1', 'review.json'), 'utf8'));
    assert.equal(saved.selection.versions['art-talk-01'][0], 'v001');
    assert.equal(res.pageDir, path.join(root, 'web', 'ep1'));
  });
});

test('buildReviewPage: --update wipes stale/orphaned assets', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'art-talk-01');
    await buildReviewPage(root, { type: 'shots', slug: 'ep1' });
    // simulate an orphaned asset left by an earlier build (e.g. a final/ clip)
    const orphan = path.join(root, 'web', 'ep1', 'assets', 'shots', 'art-talk-01', 'final', 'alpha-review.mp4');
    await mkdir(path.dirname(orphan), { recursive: true });
    await writeFile(orphan, 'stale');
    await buildReviewPage(root, { type: 'shots', slug: 'ep1', update: true });
    await assert.rejects(() => stat(orphan));  // gone after rebuild
    // the real, referenced clip is re-vendored
    const live = path.join(root, 'web', 'ep1', 'assets', 'shots', 'art-talk-01', 'drafts', 'v001', 'output.mp4');
    assert.ok((await stat(live)).isFile());
  });
});

test('buildReviewPage: refuses existing slug without update', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'a');
    await buildReviewPage(root, { type: 'shots', slug: 'ep1' });
    await assert.rejects(() => buildReviewPage(root, { type: 'shots', slug: 'ep1' }), /--update/);
  });
});

test('buildReviewPage: warns on unknown filter values but succeeds with a real one', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'art-talk-01');
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const res = await buildReviewPage(root, {
        type: 'shots', slug: 'ep1', filters: { characters: ['mira', 'nobody'] },
      });
      assert.equal(res.count, 1);
    } finally {
      console.warn = origWarn;
    }
    assert.ok(warnings.some((w) => /no character matching "nobody"/.test(w)));
  });
});

test('buildReviewPage: errors on empty result', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'shots'), { recursive: true });
    await assert.rejects(
      () => buildReviewPage(root, { type: 'shots', slug: 'x', filters: { match: 'zzz' } }),
      /no .* match/i);
  });
});

test('buildReviewPage: --out writes to a custom folder off no default web/', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'art-talk-01');
    const outDir = path.join(root, 'reviews');
    const res = await buildReviewPage(root, { type: 'shots', slug: 'ep1', out: outDir });
    assert.equal(res.pageDir, path.join(outDir, 'ep1'));
    assert.ok((await stat(path.join(outDir, 'ep1', 'index.html'))).isFile());
    // default <root>/web should not have gained an ep1 page
    await assert.rejects(() => stat(path.join(root, 'web', 'ep1', 'index.html')));
  });
});

import { parseReviewArgs } from '../src/review-page.js';

test('parseReviewArgs: --out is captured', () => {
  const o = parseReviewArgs('shots', ['--slug', 'ep1', '--out', '/tmp/reviews']);
  assert.equal(o.out, '/tmp/reviews');
});

test('parseReviewArgs: --exclude is captured into filters', () => {
  const o = parseReviewArgs('shots', ['--slug', 'ep1', '--match', '^art-', '--exclude', 'candidates']);
  assert.equal(o.filters.exclude, 'candidates');
  assert.equal(o.filters.match, '^art-');
});

test('parseReviewArgs: shots filters and boolean --update', () => {
  const o = parseReviewArgs('shots',
    ['--slug', 'ep1', '--match', '^art-', '--characters', 'mira,joh', '--episode', '1,2', '--update']);
  assert.equal(o.type, 'shots');
  assert.equal(o.slug, 'ep1');
  assert.deepEqual(o.filters.characters, ['mira', 'joh']);
  assert.deepEqual(o.filters.episodes, ['1', '2']);
  assert.equal(o.filters.match, '^art-');
  assert.equal(o.update, true);
});

test('parseReviewArgs: images sheets filter', () => {
  const o = parseReviewArgs('images', ['--slug', 's', '--sheets', 'turnaround,pose']);
  assert.equal(o.type, 'images');
  assert.deepEqual(o.filters.sheets, ['turnaround', 'pose']);
  assert.equal(o.update, false);
});

async function seedFolder(root, files) {
  const dir = path.join(root, 'candidates');
  await mkdir(dir, { recursive: true });
  for (const n of files) await writeFile(path.join(dir, n), 'v');
  return dir;
}

test('buildReviewPage: --folder builds a page from filenames and vendors the files', async () => {
  await withTempRoot(async (root) => {
    const dir = await seedFolder(root, ['ai-1-v003.mp4', 'ai-1-v006.mp4', 'art-2-v015.mp4']);
    const res = await buildReviewPage(root, { type: 'shots', slug: 'cand', folder: dir });
    assert.equal(res.count, 2);                          // ai-1, art-2
    const saved = JSON.parse(await readFile(path.join(root, 'web', 'cand', 'review.json'), 'utf8'));
    assert.deepEqual(saved.selection.versions['ai-1'], ['v003', 'v006']);   // all versions
    const vendored = path.join(root, 'web', 'cand', 'assets', 'candidates', 'ai-1-v003.mp4');
    assert.ok((await stat(vendored)).isFile());
  });
});

test('buildReviewPage: --folder with images is rejected', async () => {
  await withTempRoot(async (root) => {
    const dir = await seedFolder(root, ['x-v001.mp4']);
    await assert.rejects(
      () => buildReviewPage(root, { type: 'images', slug: 'x', folder: dir }),
      /only valid with 'shots'/);
  });
});

test('buildReviewPage: --folder with no video files is rejected', async () => {
  await withTempRoot(async (root) => {
    const dir = await seedFolder(root, ['readme.txt']);
    await assert.rejects(
      () => buildReviewPage(root, { type: 'shots', slug: 'x', folder: dir }),
      /no video files/);
  });
});

test('parseReviewArgs: --folder captured on opts', () => {
  const o = parseReviewArgs('shots', ['--slug', 'cand', '--folder', '/tmp/candidates']);
  assert.equal(o.folder, '/tmp/candidates');
});

test('parseReviewArgs: rejects unknown subcommand', () => {
  assert.throws(() => parseReviewArgs('bogus', ['--slug', 's']), /shots\|images/);
});

test('buildReviewPage: embeds the page slug for marks storage/download', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'art-talk-01');
    await buildReviewPage(root, { type: 'shots', slug: 'ep1' });
    const html = await readFile(path.join(root, 'web', 'ep1', 'index.html'), 'utf8');
    assert.match(html, /"slug": ?"ep1"/);
    assert.match(html, /"type": ?"shots"/);
  });
});
