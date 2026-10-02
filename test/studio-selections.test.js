// test/studio-selections.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSelections, setSelection, selectionsPath } from '../src/studio/selections.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-sel-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('readSelections: missing file -> empty doc', async () => {
  await withTempRoot(async (root) => {
    assert.deepEqual(await readSelections(root), { version: 1, selected: {} });
  });
});

test('setSelection: writes sorted, dedupes, empty list removes key', async () => {
  await withTempRoot(async (root) => {
    await setSelection(root, '1/ai-1', ['v010', 'v002', 'v002']);
    let doc = JSON.parse(await readFile(selectionsPath(root), 'utf8'));
    assert.deepEqual(doc.selected, { '1/ai-1': ['v002', 'v010'] });
    await setSelection(root, '1/ai-1', []);
    doc = await readSelections(root);
    assert.deepEqual(doc.selected, {});
  });
});

test('setSelection: rejects bad keys and versions', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(setSelection(root, '', ['v001']), /key/);
    await assert.rejects(setSelection(root, 'x'.repeat(600), ['v001']), /key/);
    await assert.rejects(setSelection(root, '__proto__', ['v001']), /key/);
    await assert.rejects(setSelection(root, 'a', ['final']), /version/);
    await assert.rejects(setSelection(root, 'a', 'v001'), /versions/);
  });
});

test('setSelection: concurrent writes to different keys all land', async () => {
  await withTempRoot(async (root) => {
    await Promise.all(['a', 'b', 'c', 'd'].map((k) => setSelection(root, k, ['v001'])));
    assert.deepEqual(Object.keys((await readSelections(root)).selected).sort(), ['a', 'b', 'c', 'd']);
  });
});
