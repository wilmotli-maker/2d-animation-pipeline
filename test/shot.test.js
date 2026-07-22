import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createShot, newDraft, promoteDraft } from '../src/shot.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'pipeline-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('createShot writes shot.yaml with the given metadata', async () => {
  await withTempRoot(async (root) => {
    await createShot(root, {
      shotId: 's010_kitchen',
      elements: [{ type: 'characters', name: 'cecilia' }],
      duration: 6,
      mode: 'narrative',
      description: 'Cecilia enters the kitchen',
    });
    const yaml = YAML.parse(
      await readFile(path.join(root, 'shots', 's010_kitchen', 'shot.yaml'), 'utf8'));
    assert.equal(yaml.shotId, 's010_kitchen');
    assert.equal(yaml.duration, 6);
    assert.deepEqual(yaml.elements, [{ type: 'characters', name: 'cecilia' }]);
    const finalDir = await stat(path.join(root, 'shots', 's010_kitchen', 'final'));
    assert.ok(finalDir.isDirectory());
  });
});

test('createShot rejects an existing shot', async () => {
  await withTempRoot(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    await assert.rejects(() => createShot(root, { shotId: 's1', elements: [] }), /already exists/i);
  });
});

test('newDraft creates sequential v001, v002 dirs with a prompt file', async () => {
  await withTempRoot(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    const d1 = await newDraft(root, 's1');
    assert.equal(d1.version, 1);
    assert.match(d1.dir, /drafts\/v001$/);
    const d2 = await newDraft(root, 's1');
    assert.equal(d2.version, 2);
    assert.match(d2.dir, /drafts\/v002$/);
    const promptFile = await stat(path.join(d2.dir, 'prompt.md'));
    assert.ok(promptFile.isFile());
  });
});

test('promoteDraft copies a draft output into final/ and records its source', async () => {
  await withTempRoot(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    const d = await newDraft(root, 's1');
    const src = path.join(d.dir, 'output.mp4');
    await writeFile(src, 'FAKEVIDEO');
    await promoteDraft(root, 's1', 1, src);
    const finalOut = await readFile(path.join(root, 'shots', 's1', 'final', 'output.mp4'), 'utf8');
    assert.equal(finalOut, 'FAKEVIDEO');
    const source = await readFile(path.join(root, 'shots', 's1', 'final', 'source-draft.txt'), 'utf8');
    assert.match(source.trim(), /v001/);
  });
});
