import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement, writeStyleLock } from '../src/element.js';
import { styleLockToText } from '../src/prompt-style.js';
import { loadElementStyleLock } from '../src/edit-ui/elements-api.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'edit-ui-elements-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('loadElementStyleLock returns the parsed object and its prose', async () => {
  await withTempRoot(async (root) => {
    await createElement(root, { type: 'characters', name: 'ada' });
    const styleLock = { styleRegister: 'flat-cartoon', wardrobe: 'red hoodie' };
    await writeStyleLock(root, 'characters', 'ada', styleLock);
    const got = await loadElementStyleLock(root, 'characters', 'ada');
    assert.equal(got.type, 'characters');
    assert.equal(got.name, 'ada');
    assert.deepEqual(got.styleLock, styleLock);
    assert.equal(got.text, styleLockToText(styleLock));
  });
});

test('an existing element with no style-lock.yaml is an empty lock', async () => {
  await withTempRoot(async (root) => {
    await createElement(root, { type: 'characters', name: 'ada' });
    assert.deepEqual(await loadElementStyleLock(root, 'characters', 'ada'), {
      type: 'characters', name: 'ada', styleLock: null, text: '',
    });
  });
});

test('loadElementStyleLock rejects a missing element, a bad type, and an illegal name', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(loadElementStyleLock(root, 'characters', 'missing'), (err) => err.status === 404);
    await assert.rejects(loadElementStyleLock(null, 'characters', 'ada'), (err) => err.status === 404 && err.message === 'no project root');
    await assert.rejects(loadElementStyleLock(root, 'vehicles', 'ada'), (err) => err.status === 400);
    await assert.rejects(loadElementStyleLock(root, 'characters', '..'), (err) => err.status === 400);
    await assert.rejects(loadElementStyleLock(root, 'characters', 'undefined'), (err) => err.status === 400);
  });
});

test('an unparseable style-lock.yaml is a 400', async () => {
  await withTempRoot(async (root) => {
    await createElement(root, { type: 'characters', name: 'ada' });
    await writeFile(path.join(root, 'elements', 'characters', 'ada', 'style-lock.yaml'), '[\n');
    await assert.rejects(loadElementStyleLock(root, 'characters', 'ada'), (err) => err.status === 400);
  });
});
