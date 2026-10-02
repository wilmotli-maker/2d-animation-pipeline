// test/studio-tree.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanProjectTree, shotKey, sheetKey } from '../src/studio/tree.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-tree-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function seedDraft(shotRoot, id, v, extra = []) {
  const dir = path.join(shotRoot, 'shots', id, 'drafts', v);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'output.mp4'), 'x');
  for (const f of extra) await writeFile(path.join(dir, f), 'x');
}

test('scanProjectTree: elements (incl. empty), episodes, flat shots', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'elements', 'characters', 'mira', 'sheets', 'turnaround', 'hero'), { recursive: true });
    await writeFile(path.join(root, 'elements', 'characters', 'mira', 'sheets', 'turnaround', 'hero', 'v001.png'), 'x');
    await mkdir(path.join(root, 'elements', 'props', 'lamp'), { recursive: true });       // created, no sheets yet
    await seedDraft(path.join(root, 'episodes', '1'), 'ai-1', 'v001');
    await seedDraft(path.join(root, 'episodes', '1'), 'ai-1', 'v002', ['alpha.mov']);
    await mkdir(path.join(root, 'episodes', '2', 'shots'), { recursive: true });          // empty episode
    await seedDraft(root, 'pilot-1', 'v001');

    const t = await scanProjectTree(root);
    assert.equal(t.project, path.basename(root));
    assert.deepEqual(t.elements, [
      { type: 'characters', name: 'mira', sheets: 1, versions: 1 },
      { type: 'props', name: 'lamp', sheets: 0, versions: 0 },
    ]);
    assert.deepEqual(t.episodes.map((e) => e.id), ['1', '2']);
    assert.deepEqual(t.episodes[0].shots, [{ shotId: 'ai-1', versions: 2, promotedVersion: null, mattes: 1 }]);
    assert.deepEqual(t.episodes[1].shots, []);
    assert.deepEqual(t.shots.map((s) => s.shotId), ['pilot-1']);
  });
});

test('scanProjectTree: empty project yields empty lists', async () => {
  await withTempRoot(async (root) => {
    assert.deepEqual(await scanProjectTree(root),
      { project: path.basename(root), elements: [], episodes: [], shots: [] });
  });
});

test('shotKey/sheetKey', () => {
  assert.equal(shotKey({ episode: '1', shotId: 'ai-1' }), '1/ai-1');
  assert.equal(shotKey({ episode: null, shotId: 'pilot-1' }), 'pilot-1');
  assert.equal(sheetKey('characters', 'mira', { sheetType: 'turnaround', slug: 'hero' }), 'characters/mira/turnaround/hero');
});
