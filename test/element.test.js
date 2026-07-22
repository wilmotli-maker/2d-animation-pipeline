import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement, writeStyleLock, readStyleLock, appendGeneration } from '../src/element.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'pipeline-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('createElement builds the full scaffold', async () => {
  await withTempRoot(async (root) => {
    const el = await createElement(root, { type: 'characters', name: 'cecilia' });
    for (const sub of ['inputs/reference-images', 'inputs/reference-videos',
      'inputs/speech-samples', 'sheets/turnaround', 'sheets/pose', 'sheets/cycles']) {
      const s = await stat(path.join(el.dir, sub));
      assert.ok(s.isDirectory(), `${sub} should exist`);
    }
    const prompt = await stat(path.join(el.dir, 'inputs', 'prompt.md'));
    assert.ok(prompt.isFile());
  });
});

test('createElement rejects an unknown type', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(() => createElement(root, { type: 'vehicles', name: 'x' }),
      /unknown element type/i);
  });
});

test('createElement refuses to clobber an existing element', async () => {
  await withTempRoot(async (root) => {
    await createElement(root, { type: 'props', name: 'lamp' });
    await assert.rejects(() => createElement(root, { type: 'props', name: 'lamp' }),
      /already exists/i);
  });
});

test('style-lock round-trips through YAML', async () => {
  await withTempRoot(async (root) => {
    await createElement(root, { type: 'characters', name: 'cecilia' });
    await writeStyleLock(root, 'characters', 'cecilia', { palette: ['#fff', '#f00'], lineWeight: 2 });
    const got = await readStyleLock(root, 'characters', 'cecilia');
    assert.deepEqual(got, { palette: ['#fff', '#f00'], lineWeight: 2 });
  });
});

test('readStyleLock returns null when absent', async () => {
  await withTempRoot(async (root) => {
    await createElement(root, { type: 'characters', name: 'nostyle' });
    assert.equal(await readStyleLock(root, 'characters', 'nostyle'), null);
  });
});

test('appendGeneration writes one JSON line per call with a timestamp', async () => {
  await withTempRoot(async (root) => {
    await createElement(root, { type: 'characters', name: 'cecilia' });
    await appendGeneration(root, 'characters', 'cecilia', { model: 'm', jobId: 'j1', status: 'accepted' });
    await appendGeneration(root, 'characters', 'cecilia', { model: 'm', jobId: 'j2', status: 'rejected' });
    const log = await readFile(
      path.join(root, 'elements', 'characters', 'cecilia', 'generations.jsonl'), 'utf8');
    const lines = log.trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.jobId, 'j1');
    assert.ok(typeof first.ts === 'string' && first.ts.length > 0);
  });
});
