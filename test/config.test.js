import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectRoot, assertSegment } from '../src/config.js';

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

test('projectRoot rejects the "undefined"/"null"/empty root that wrappers leak', () => {
  for (const bad of ['undefined', 'null', '', '  ']) {
    assert.throws(() => projectRoot(bad), /--root received an invalid value/,
      `expected ${JSON.stringify(bad)} to be rejected`);
  }
  // A real directory literally spelled with those words as part of a path is fine.
  assert.equal(projectRoot('undefined-project'),
    path.resolve(process.cwd(), 'undefined-project'));
});

test('assertSegment rejects empty, undefined-ish, and traversal/separator names', () => {
  for (const bad of [undefined, null, '', '   ', 'undefined', 'null', '.', '..',
    'a/b', 'a\\b', 'a\0b']) {
    assert.throws(() => assertSegment(bad, 'element name'),
      `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('assertSegment returns a valid segment unchanged', () => {
  assert.equal(assertSegment('cecilia', 'element name'), 'cecilia');
  assert.equal(assertSegment('s010_kitchen', 'shot id'), 's010_kitchen');
});
