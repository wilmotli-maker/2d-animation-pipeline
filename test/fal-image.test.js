import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFalImageRunner, FalError, FAL_IMAGE_ENDPOINTS, FAL_IMAGE_DEFAULT_MODEL } from '../src/fal.js';

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

const runner = (fetchImpl, over = {}) => createFalImageRunner({
  falKey: 'FK', fetchImpl,
  uploadFile: async (p) => `https://cdn/${p.split('/').pop()}`,
  ...over,
});

test('generate with reference images uses the /edit endpoint, uploads refs, returns request_id', async () => {
  const fetchImpl = fakeFetch([['nano-banana-2/edit', { body: { request_id: 'img_1', status_url: 'https://q/s', response_url: 'https://q/r' } }]]);
  const r = runner(fetchImpl);
  const res = await r.generate('nano_banana_2_lite', { prompt: 'a turnaround sheet', imageReferences: ['/tmp/ref.png'] });
  assert.equal(res.id, 'img_1');
  const sub = fetchImpl.calls[0];
  assert.match(sub.url, /fal-ai\/nano-banana-2\/edit$/);   // edit endpoint because refs are present
  assert.equal(sub.body.prompt, 'a turnaround sheet');
  assert.deepEqual(sub.body.image_urls, ['https://cdn/ref.png']);
  assert.equal(sub.body.num_images, 1);
});

test('generate without reference images uses the text-to-image endpoint (no /edit, no image_urls)', async () => {
  const fetchImpl = fakeFetch([['fal-ai/nano-banana-2', { body: { request_id: 'img_2' } }]]);
  const r = runner(fetchImpl);
  await r.generate('nano_banana_2_lite', { prompt: 'a prop' });
  const sub = fetchImpl.calls[0];
  assert.match(sub.url, /fal-ai\/nano-banana-2$/);
  assert.doesNotMatch(sub.url, /\/edit/);
  assert.equal(sub.body.image_urls, undefined);
});

test('the default HF image model maps to the fal Nano Banana 2 endpoint', () => {
  assert.equal(FAL_IMAGE_DEFAULT_MODEL, 'nano_banana_2_lite');
  assert.equal(FAL_IMAGE_ENDPOINTS[FAL_IMAGE_DEFAULT_MODEL], 'fal-ai/nano-banana-2');
});

test('model slug selects the endpoint family (pro -> nano-banana-pro)', async () => {
  const fetchImpl = fakeFetch([['nano-banana-pro/edit', { body: { request_id: 'img_3' } }]]);
  const r = runner(fetchImpl);
  await r.generate('nano_banana_pro', { prompt: 'hi', imageReferences: ['/tmp/a.png'] });
  assert.match(fetchImpl.calls[0].url, /fal-ai\/nano-banana-pro\/edit$/);
});

test('an unknown model falls back to the default endpoint', async () => {
  const fetchImpl = fakeFetch([['fal-ai/nano-banana-2', { body: { request_id: 'img_4' } }]]);
  const r = runner(fetchImpl);
  await r.generate('something_else', { prompt: 'hi' });
  assert.match(fetchImpl.calls[0].url, /fal-ai\/nano-banana-2$/);
});

test('get: completed returns the image output url; processing returns null', async () => {
  const fetchImpl = fakeFetch([
    ['nano-banana-2/edit', { body: { request_id: 'img_5', status_url: 'https://q/img_5/status', response_url: 'https://q/img_5' } }],
    ['img_5/status', { body: { status: 'COMPLETED' } }],
    ['https://q/img_5', { body: { images: [{ url: 'https://cdn/out.png' }] } }],
  ]);
  const r = runner(fetchImpl);
  const { id } = await r.generate('nano_banana_2', { prompt: 'x', imageReferences: ['/tmp/r.png'] });
  const got = await r.get(id);
  assert.equal(got.status, 'completed');
  assert.equal(got.outputUrl, 'https://cdn/out.png');
});

test('get: processing status yields no output url yet', async () => {
  const fetchImpl = fakeFetch([
    ['fal-ai/nano-banana-2', { body: { request_id: 'img_6', status_url: 'https://q/img_6/status', response_url: 'https://q/img_6' } }],
    ['img_6/status', { body: { status: 'IN_PROGRESS' } }],
  ]);
  const r = runner(fetchImpl);
  const { id } = await r.generate('nano_banana_2', { prompt: 'x' });
  const got = await r.get(id);
  assert.equal(got.status, 'processing');
  assert.equal(got.outputUrl, null);
});

test('estimateCost returns a per-model USD figure', async () => {
  const r = runner(fakeFetch([]));
  assert.equal(await r.estimateCost('nano_banana_2_lite'), 0.04);
  assert.equal(await r.estimateCost('nano_banana_pro'), 0.10);
});

test('generate without FAL_KEY throws', async () => {
  const r = createFalImageRunner({ falKey: '', fetchImpl: fakeFetch([]) });
  await assert.rejects(() => r.generate('nano_banana_2', { prompt: 'x' }), FalError);
});
