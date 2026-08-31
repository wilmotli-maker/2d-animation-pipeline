import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MODELS, fetchModel, fetchModels } from '../scripts/fetch-models.js';
import { WHISPER_MODEL, MATTE_MODELS } from '../src/config.js';

// A fake fetch: HEAD returns the size, GET returns a body stream. `bytes` is the
// payload; `headSize` lets a test simulate a server whose advertised size differs.
function fakeFetch(bytes, { headSize = bytes.length } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    const headers = new Map([['content-length', String(opts.method === 'HEAD' ? headSize : bytes.length)]]);
    return {
      ok: true,
      headers: { get: (k) => headers.get(k) ?? null },
      body: opts.method === 'HEAD' ? null : (await import('node:stream')).Readable.toWeb((await import('node:stream')).Readable.from([bytes])),
    };
  };
  impl.calls = calls;
  return impl;
}

const quiet = () => {};

test('MODELS is derived from config (single source of truth)', () => {
  const byKey = Object.fromEntries(MODELS.map((m) => [m.key, m]));
  assert.equal(byKey.whisper.url, WHISPER_MODEL.url);
  assert.equal(byKey.fast.file, MATTE_MODELS.fast.file);
  assert.equal(byKey.best.url, MATTE_MODELS.best.url);
  assert.equal(MODELS.length, 3);
});

test('fetchModel downloads to the destination and verifies size', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fm-'));
  const payload = Buffer.from('a'.repeat(2048));
  const model = { key: 'whisper', file: 'ggml.bin', url: 'https://x/ggml.bin' };
  const res = await fetchModel(model, { dir, fetchImpl: fakeFetch(payload), log: quiet });
  assert.equal(res, 'downloaded');
  assert.deepEqual(await readFile(path.join(dir, 'ggml.bin')), payload);
});

test('fetchModel skips a present file whose size matches', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fm-'));
  const payload = Buffer.from('b'.repeat(1000));
  await writeFile(path.join(dir, 'm.onnx'), payload);
  const fetchImpl = fakeFetch(payload);
  const model = { key: 'fast', file: 'm.onnx', url: 'https://x/m.onnx' };
  const res = await fetchModel(model, { dir, fetchImpl, log: quiet });
  assert.equal(res, 'skipped');
  // Only the HEAD probe ran — no GET body was requested.
  assert.ok(fetchImpl.calls.every((c) => c.method === 'HEAD'));
});

test('fetchModel re-downloads a truncated partial (size mismatch)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fm-'));
  await writeFile(path.join(dir, 'm.onnx'), Buffer.from('short')); // 5 bytes on disk
  const full = Buffer.from('c'.repeat(4096));                      // server has 4096
  const model = { key: 'best', file: 'm.onnx', url: 'https://x/m.onnx' };
  const res = await fetchModel(model, { dir, fetchImpl: fakeFetch(full), log: quiet });
  assert.equal(res, 'downloaded');
  assert.equal((await stat(path.join(dir, 'm.onnx'))).size, 4096);
});

test('fetchModels --only limits the set to matching keys', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fm-'));
  const payload = Buffer.from('d'.repeat(512));
  const results = await fetchModels({ only: ['whisper'], dir, fetchImpl: fakeFetch(payload), log: quiet });
  assert.deepEqual(results, [['whisper', 'downloaded']]);
});

test('fetchModels rejects an --only that matches nothing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fm-'));
  await assert.rejects(fetchModels({ only: ['nope'], dir, fetchImpl: fakeFetch(Buffer.from('x')), log: quiet }),
    /matched nothing/);
});
