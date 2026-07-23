import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadTo } from '../src/download.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dl-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// Fake fetch returning bytes with a content-type; records the URL requested.
function fakeFetch(bytes, { ok = true, contentType = 'image/png' } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return {
      ok,
      status: ok ? 200 : 500,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  return { fn, calls };
}

test('downloadTo writes the response body to the given path and returns it', async () => {
  await withTemp(async (dir) => {
    const { fn, calls } = fakeFetch(Buffer.from('PNGDATA'));
    const dest = path.join(dir, 'out.png');
    const res = await downloadTo('https://cdn/x.png', dest, { fetchImpl: fn });
    assert.equal(res, dest);
    assert.equal(await readFile(dest, 'utf8'), 'PNGDATA');
    assert.deepEqual(calls, ['https://cdn/x.png']);
  });
});

test('downloadTo infers the extension from the URL when the dest has none', async () => {
  await withTemp(async (dir) => {
    const { fn } = fakeFetch(Buffer.from('MP4DATA'));
    const dest = await downloadTo('https://cdn/clip.mp4', path.join(dir, 'output'), { fetchImpl: fn });
    assert.ok(dest.endsWith('output.mp4'));
    assert.ok((await stat(dest)).isFile());
  });
});

test('downloadTo throws on a non-ok response', async () => {
  await withTemp(async (dir) => {
    const { fn } = fakeFetch(Buffer.from(''), { ok: false });
    await assert.rejects(
      () => downloadTo('https://cdn/x.png', path.join(dir, 'o.png'), { fetchImpl: fn }),
      /download failed.*500/i,
    );
  });
});
