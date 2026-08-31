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
  // minimal web/README.md with markers so the index refresh has something to update
  await mkdir(path.join(root, 'web'), { recursive: true });
  await writeFile(path.join(root, 'web', 'README.md'),
    '# Web\n<!-- pages:start -->\n<!-- pages:end -->\n');
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

test('buildReviewPage: refuses existing slug without update', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'a');
    await buildReviewPage(root, { type: 'shots', slug: 'ep1' });
    await assert.rejects(() => buildReviewPage(root, { type: 'shots', slug: 'ep1' }), /--update/);
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

import { parseReviewArgs } from '../src/review-page.js';

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

test('parseReviewArgs: rejects unknown subcommand', () => {
  assert.throws(() => parseReviewArgs('bogus', ['--slug', 's']), /shots\|images/);
});
