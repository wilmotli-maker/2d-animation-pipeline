import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWavespeedKey, wavespeedKeyStatus } from '../src/wavespeed.js';

function tmpKeyFile(contents) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const file = path.join(dir, 'key');
  if (contents != null) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); }
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('env WAVESPEED_API_KEY wins over the key file', () => {
  const { file, cleanup } = tmpKeyFile('from-file\n');
  try {
    assert.equal(resolveWavespeedKey({ env: { WAVESPEED_API_KEY: 'from-env' }, keyFile: file }), 'from-env');
    assert.deepEqual(wavespeedKeyStatus({ env: { WAVESPEED_API_KEY: 'from-env' }, keyFile: file }).source, 'env');
  } finally { cleanup(); }
});

test('falls back to ~/.wavespeed/key, trimmed', () => {
  const { file, cleanup } = tmpKeyFile('  from-file \n');
  try {
    assert.equal(resolveWavespeedKey({ env: {}, keyFile: file }), 'from-file');
    assert.equal(wavespeedKeyStatus({ env: {}, keyFile: file }).source, 'file');
  } finally { cleanup(); }
});

test('null when neither is set; status reports not configured', () => {
  const { file, cleanup } = tmpKeyFile(null); // file not written
  try {
    assert.equal(resolveWavespeedKey({ env: {}, keyFile: file }), null);
    assert.deepEqual(wavespeedKeyStatus({ env: {}, keyFile: file }), { configured: false, source: null, keyFile: file });
  } finally { cleanup(); }
});

test('empty env var is ignored, falls through to file', () => {
  const { file, cleanup } = tmpKeyFile('k\n');
  try {
    assert.equal(resolveWavespeedKey({ env: { WAVESPEED_API_KEY: '   ' }, keyFile: file }), 'k');
  } finally { cleanup(); }
});
