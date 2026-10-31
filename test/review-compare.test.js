// test/review-compare.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildReviewPage, buildComparePage, parseReviewArgs } from '../src/review-page.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-compare-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function seed(root) {
  await mkdir(path.join(root, 'media'), { recursive: true });
  for (const f of ['src.mp4', 'splice.mp4', 'harm.mp4', 'final.mp4']) await writeFile(path.join(root, 'media', f), 'v');
  await writeFile(path.join(root, 'media', 'bg.png'), 'i');
}

async function manifest(root) {
  const m = {
    title: 'Composite comparison',
    rows: [{
      id: 'v4',
      label: 'steeple edit',
      inputs: [{ label: 'source', path: 'media/src.mp4' }, { label: 'bg', path: 'media/bg.png' }],
      results: [
        { label: 'splice', path: 'media/splice.mp4' },
        { label: 'harmonized', path: 'media/harm.mp4' },
        { label: 'composite', path: 'media/final.mp4' },
      ],
    }],
  };
  const p = path.join(root, 'manifest.json');
  await writeFile(p, JSON.stringify(m));
  return p;
}

test('parseReviewArgs accepts compare + --manifest', () => {
  const opts = parseReviewArgs('compare', ['--slug', 'cmp', '--manifest', 'm.json', '--layout', 'stacked']);
  assert.equal(opts.type, 'compare');
  assert.equal(opts.manifest, 'm.json');
  assert.equal(opts.layout, 'stacked');
});

test('buildComparePage vendors inputs+results, infers media kinds, selects results only', async () => {
  await withTempRoot(async (root) => {
    await seed(root);
    const res = await buildComparePage(root, { slug: 'cmp', manifest: await manifest(root), title: 'T' });
    assert.equal(res.count, 1);
    const saved = JSON.parse(await readFile(path.join(root, 'web', 'cmp', 'review.json'), 'utf8'));
    // selection only lists results, never inputs
    assert.deepEqual(saved.selection.versions.v4, ['splice', 'harmonized', 'composite']);
    const row = saved.model.rows[0];
    assert.equal(row.inputs.length, 2);
    assert.equal(row.inputs.find((i) => i.label === 'bg').kind, 'image');
    assert.equal(row.inputs.find((i) => i.label === 'source').kind, 'video');
    assert.equal(row.results[0].kind, 'video');
    // files vendored under assets/<rowId>/
    assert.ok((await stat(path.join(root, 'web', 'cmp', 'assets', 'v4', '01-bg.png'))).isFile());
  });
});

test('compare page HTML renders the divider, an image tag, non-selectable inputs, selectable results', async () => {
  await withTempRoot(async (root) => {
    await seed(root);
    await buildComparePage(root, { slug: 'cmp', manifest: await manifest(root) });
    const html = await readFile(path.join(root, 'web', 'cmp', 'index.html'), 'utf8');
    assert.match(html, /class="divider"/);          // vertical divider present
    assert.match(html, /col input/);                 // input column class
    assert.match(html, /<img /);                      // image support (the bg plate)
    assert.doesNotMatch(html, /https?:\/\//);        // self-contained
  });
});

test('buildReviewPage routes type=compare to the compare builder', async () => {
  await withTempRoot(async (root) => {
    const res = await buildReviewPage(root, { type: 'compare', slug: 'cmp', manifest: await manifest(root) });
    assert.equal(res.count, 1);
  });
});

test('compare: unknown media kind without an explicit kind errors', async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, 'weird.dat'), 'x');
    const p = path.join(root, 'm.json');
    await writeFile(p, JSON.stringify({ rows: [{ id: 'r', results: [{ label: 'x', path: 'weird.dat' }] }] }));
    await assert.rejects(buildComparePage(root, { slug: 's', manifest: p }), /cannot infer media kind/);
  });
});
