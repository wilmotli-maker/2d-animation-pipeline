// test/review-scan.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverShotRoots } from '../src/review-scan.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('discoverShotRoots: flat layout yields one root with episode null', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'shots', 's1'), { recursive: true });
    const roots = await discoverShotRoots(root);
    assert.deepEqual(roots, [{ root, episode: null }]);
  });
});

test('discoverShotRoots: episodic layout yields one root per episode', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'episodes', '1', 'shots', 'a'), { recursive: true });
    await mkdir(path.join(root, 'episodes', '2', 'shots', 'b'), { recursive: true });
    const roots = await discoverShotRoots(root);
    assert.deepEqual(roots.map((r) => r.episode).sort(), ['1', '2']);
    assert.equal(roots.find((r) => r.episode === '1').root, path.join(root, 'episodes', '1'));
  });
});
