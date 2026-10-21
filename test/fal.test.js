import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFalRunner, FalError } from '../src/fal.js';

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    for (const [frag, res] of routes) {
      if (String(url).includes(frag)) {
        const r = typeof res === 'function' ? res(String(url), init) : res;
        return { ok: r.ok !== false, status: r.status ?? 200, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  impl.calls = calls;
  return impl;
}

const runner = (fetchImpl, over = {}) => createFalRunner({
  falKey: 'FK', resolution: '480p', fetchImpl,
  uploadFile: async (p) => `https://cdn/${p.split('/').pop()}`,
  ...over,
});

test('generate: builds reference body, uploads local refs, returns request_id', async () => {
  const fetchImpl = fakeFetch([['reference-to-video', { body: { request_id: 'req_1' } }]]);
  const r = runner(fetchImpl);
  const res = await r.generate('seedance_2_5', {
    prompt: '@Video1 .. @Image1', mode: 'video_edit', resolution: '480p',
    aspectRatio: '3:4', duration: 7, generateAudio: false,
    imageReferences: ['/a/first.png', '/a/last.png'], videoReferences: ['/a/guide.mp4'],
  });
  assert.equal(res.id, 'req_1');
  const body = fetchImpl.calls[0].body;
  assert.equal(body.task, 'reference');
  assert.equal(body.resolution, '480p');
  assert.equal(body.duration, '7');                 // fal duration is a STRING
  assert.equal(body.generate_audio, false);
  assert.deepEqual(body.image_urls, ['https://cdn/first.png', 'https://cdn/last.png']);
  assert.deepEqual(body.video_urls, ['https://cdn/guide.mp4']);
});

test('get: processing then completed, extracts the output video url', async () => {
  let status = 'IN_PROGRESS';
  const fetchImpl = fakeFetch([
    ['/status', () => ({ body: { status } })],
    ['/requests/', { body: { video: { url: 'https://out/final.mp4' } } }],
    ['reference-to-video', { body: { request_id: 'req_9' } }],
  ]);
  const r = runner(fetchImpl);
  await r.generate('seedance_2_5', { prompt: 'x', duration: 5 });
  assert.equal((await r.get('req_9')).status, 'processing');
  status = 'COMPLETED';
  const done = await r.get('req_9');
  assert.equal(done.status, 'completed');
  assert.equal(done.outputUrl, 'https://out/final.mp4');
});

test('estimateCost: USD by resolution x duration', async () => {
  const r = runner(fakeFetch([]));
  assert.equal(await r.estimateCost('seedance_2_5', { resolution: '480p', duration: 10 }), 1.7);
  assert.equal(await r.estimateCost('seedance_2_5', { duration: 0 }), null);
});

test('upload returns the fal storage url', async () => {
  const r = runner(fakeFetch([]));
  assert.deepEqual(await r.upload('/x/clip.mp4'), { id: 'https://cdn/clip.mp4', type: null, url: 'https://cdn/clip.mp4' });
});

test('generate without FAL_KEY throws', async () => {
  const r = createFalRunner({ falKey: '', fetchImpl: fakeFetch([]), uploadFile: async () => 'u' });
  await assert.rejects(r.generate('seedance_2_5', { prompt: 'x' }), FalError);
});

test('a submit HTTP error surfaces as FalError', async () => {
  const fetchImpl = fakeFetch([['reference-to-video', { ok: false, status: 402, body: 'not_enough_credits' }]]);
  await assert.rejects(runner(fetchImpl).generate('seedance_2_5', { prompt: 'x' }), /fal submit failed \(HTTP 402\)/);
});
