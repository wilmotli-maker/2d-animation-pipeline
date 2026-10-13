// test/wavespeed.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWavespeedKey, vaceJoin, WavespeedError } from '../src/wavespeed.js';

test('resolveWavespeedKey prefers WAVESPEED_API_KEY from the env (loaded from .env)', () => {
  assert.equal(resolveWavespeedKey({ env: { WAVESPEED_API_KEY: 'k-123' }, keyFile: '/nope' }), 'k-123');
});

function fakeFetch(script) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    const step = script(url, opts);
    return { json: async () => step };
  };
  impl.calls = calls;
  return impl;
}

test('vaceJoin uploads each clip, submits the join, polls to completion, and returns the output URL', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.includes('/media/upload/binary')) return { code: 200, data: { download_url: `https://ws/${Math.random()}` } };
    if (url.includes('/vace-video-joiner')) return { code: 200, data: { id: 'job-1' } };
    if (url.includes('/predictions/job-1/result')) return { code: 200, data: { status: 'completed', outputs: ['https://ws/out.mp4'] } };
    throw new Error(`unexpected ${url}`);
  });
  const res = await vaceJoin(['a.mp4', 'b.mp4', 'c.mp4'], {
    apiKey: 'k', fetchImpl, readFile: async () => Buffer.from('v'), sleep: async () => {},
  });
  assert.equal(res.outputUrl, 'https://ws/out.mp4');
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes('/media/upload/binary')).length, 3);
  assert.ok(fetchImpl.calls.some((c) => c.url.includes('/vace-video-joiner') && c.method === 'POST'));
});

test('vaceJoin surfaces an API error (e.g. insufficient credits) as a WavespeedError', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.includes('/media/upload/binary')) return { code: 200, data: { download_url: 'u' } };
    if (url.includes('/vace-video-joiner')) return { code: 400, message: 'Insufficient credits. Please top up your account.' };
    throw new Error('unexpected');
  });
  await assert.rejects(
    () => vaceJoin(['a.mp4', 'b.mp4'], { apiKey: 'k', fetchImpl, readFile: async () => Buffer.from('v'), sleep: async () => {} }),
    (e) => { assert.ok(e instanceof WavespeedError); assert.match(e.message, /Insufficient credits/i); return true; },
  );
});

test('vaceJoin throws without a key', async () => {
  await assert.rejects(() => vaceJoin(['a.mp4', 'b.mp4'], { apiKey: null }), /no WaveSpeed key/i);
});

test('vaceJoin requires 2 to 4 clips', async () => {
  await assert.rejects(() => vaceJoin(['a.mp4'], { apiKey: 'k' }), /2 to 4/);
});
