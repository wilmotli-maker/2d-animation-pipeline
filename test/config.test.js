import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectRoot } from '../src/config.js';

test('projectRoot prefers an explicit argument', () => {
  assert.equal(projectRoot('/tmp/explicit'), '/tmp/explicit');
});

test('projectRoot falls back to ANIMATION_PIPELINE_ROOT, then cwd', () => {
  const saved = process.env.ANIMATION_PIPELINE_ROOT;
  try {
    process.env.ANIMATION_PIPELINE_ROOT = '/tmp/env-root';
    assert.equal(projectRoot(), '/tmp/env-root');
    delete process.env.ANIMATION_PIPELINE_ROOT;
    assert.equal(projectRoot(), path.resolve(process.cwd()));
  } finally {
    if (saved === undefined) delete process.env.ANIMATION_PIPELINE_ROOT;
    else process.env.ANIMATION_PIPELINE_ROOT = saved;
  }
});

test('projectRoot resolves a relative explicit path against cwd', () => {
  assert.equal(projectRoot('my-project'), path.resolve(process.cwd(), 'my-project'));
});
