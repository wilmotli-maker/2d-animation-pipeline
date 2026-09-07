import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnv } from '../src/env.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'env-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// Each test uses uniquely-named keys so it never collides with the real
// environment, and deletes them afterward to avoid leaking into sibling tests.
function cleanup(...keys) { for (const k of keys) delete process.env[k]; }

test('loadEnv sets keys from .env, stripping matching quotes', async () => {
  await withTemp(async (dir) => {
    await writeFile(path.join(dir, '.env'),
      'ENVTEST_PLAIN=abc123\nENVTEST_DQ="has spaces"\nENVTEST_SQ=\'single\'\n');
    const loaded = loadEnv(dir);
    try {
      assert.deepEqual(new Set(Object.keys(loaded)),
        new Set(['ENVTEST_PLAIN', 'ENVTEST_DQ', 'ENVTEST_SQ']));
      assert.equal(process.env.ENVTEST_PLAIN, 'abc123');
      assert.equal(process.env.ENVTEST_DQ, 'has spaces');
      assert.equal(process.env.ENVTEST_SQ, 'single');
    } finally {
      cleanup('ENVTEST_PLAIN', 'ENVTEST_DQ', 'ENVTEST_SQ');
    }
  });
});

test('loadEnv does NOT override a variable already in the shell environment', async () => {
  await withTemp(async (dir) => {
    process.env.ENVTEST_WINS = 'from-shell';
    await writeFile(path.join(dir, '.env'), 'ENVTEST_WINS=from-file\n');
    try {
      const loaded = loadEnv(dir);
      assert.equal(process.env.ENVTEST_WINS, 'from-shell');
      assert.ok(!('ENVTEST_WINS' in loaded), 'pre-set key is not reported as loaded');
    } finally {
      cleanup('ENVTEST_WINS');
    }
  });
});

test('loadEnv ignores comments, blank lines, and malformed lines', async () => {
  await withTemp(async (dir) => {
    await writeFile(path.join(dir, '.env'),
      '# a comment\n\nNOEQUALS\n=nokey\nENVTEST_GOOD=ok\n');
    const loaded = loadEnv(dir);
    try {
      assert.deepEqual(Object.keys(loaded), ['ENVTEST_GOOD']);
      assert.equal(process.env.ENVTEST_GOOD, 'ok');
      assert.ok(!('NOEQUALS' in process.env));
    } finally {
      cleanup('ENVTEST_GOOD');
    }
  });
});

test('loadEnv returns {} when no .env file exists', async () => {
  await withTemp(async (dir) => {
    assert.deepEqual(loadEnv(dir), {});
  });
});
