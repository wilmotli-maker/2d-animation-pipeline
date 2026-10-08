import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMuapiRunner } from '../src/muapi.js';

// Fake fetch that records requests and returns scripted responses keyed by URL substring.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
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

function runner(fetchImpl, over = {}) {
  return createMuapiRunner({
    apiKey: 'MK', falKey: 'FK', resolution: '480p', fetchImpl,
    uploadFile: async (p) => `https://cdn/${p.split('/').pop()}`, // deterministic fake upload
    ...over,
  });
}

test('omni-reference: builds images_list/videos_list, uploads local refs, hits 480p route', async () => {
  const fetchImpl = fakeFetch([
    ['seedance-2.5-omni-reference-480p', { body: { request_id: 'req_1' } }],
  ]);
  const r = runner(fetchImpl);
  const res = await r.generate('seedance_2_5', {
    prompt: '@Image1 .. @Video1', mode: 'omni_reference', resolution: '480p',
    aspectRatio: '3:4', duration: 4, generateAudio: true,
    imageReferences: ['/a/00.png', '/a/01.png'], videoReferences: ['/a/speech.mp4'],
  });
  assert.equal(res.id, 'req_1');
  assert.equal(res.status, 'submitted');
  const post = fetchImpl.calls.find((c) => c.url.includes('/seedance-2.5-omni-reference-480p'));
  assert.ok(post, 'posted to the 480p omni-reference route');
  assert.equal(post.init.headers['x-api-key'], 'MK');
  assert.deepEqual(post.body.images_list, ['https://cdn/00.png', 'https://cdn/01.png']);
  assert.deepEqual(post.body.videos_list, ['https://cdn/speech.mp4']);
  assert.equal(post.body.aspect_ratio, '3:4');
  assert.equal(post.body.duration, 4);
  assert.equal(post.body.generate_audio, true);
});

test('spicy + 720p picks the unsuffixed spicy route', async () => {
  const fetchImpl = fakeFetch([['seedance-2.5-spicy-omni-reference', { body: { request_id: 'r2' } }]]);
  const r = runner(fetchImpl, { spicy: true, resolution: '720p' });
  await r.generate('seedance_2_5', { prompt: 'x', mode: 'omni_reference', imageReferences: ['https://x/y.png'] });
  const post = fetchImpl.calls.find((c) => c.url.includes('/seedance-2.5-spicy-omni-reference'));
  assert.ok(post && !post.url.includes('-720p'), '720p is the unsuffixed route');
  assert.deepEqual(post.body.images_list, ['https://x/y.png'], 'http URLs pass through without upload');
});

test('video_edit maps to video + reference_images', async () => {
  const fetchImpl = fakeFetch([['seedance-2.5-video-edit-480p', { body: { request_id: 'r3' } }]]);
  const r = runner(fetchImpl);
  await r.generate('seedance_2_5', { prompt: 'edit', mode: 'video_edit', resolution: '480p', videoReferences: ['/v/src.mp4'], imageReferences: ['/v/ref.png'] });
  const post = fetchImpl.calls.find((c) => c.url.includes('video-edit'));
  assert.equal(post.body.video, 'https://cdn/src.mp4');
  assert.deepEqual(post.body.reference_images, ['https://cdn/ref.png']);
  assert.equal(post.body.images_list, undefined);
});

test('first_last_frame maps to the first-last-frame route with images_list [first, last]', async () => {
  const fetchImpl = fakeFetch([['seedance-2.5-first-last-frame-480p', { body: { request_id: 'r4' } }]]);
  const r = runner(fetchImpl);
  await r.generate('seedance_2_5', {
    prompt: 'one continuous shot, camera continues its push', mode: 'first_last_frame',
    resolution: '480p', duration: 4, imageReferences: ['/s/A_out.png', '/s/B_in.png'],
  });
  const post = fetchImpl.calls.find((c) => c.url.includes('first-last-frame'));
  assert.ok(post, 'posted to the first-last-frame route');
  assert.deepEqual(post.body.images_list, ['https://cdn/A_out.png', 'https://cdn/B_in.png'], 'first then last, order preserved');
  assert.equal(post.body.video, undefined, 'not treated as a video-edit route');
  assert.equal(post.body.duration, 4);
});

test('get maps statuses and extracts output url', async () => {
  const seq = [{ status: 'processing' }, { status: 'completed', outputs: ['https://cdn/out.mp4'] }];
  let i = 0;
  const fetchImpl = fakeFetch([['/predictions/req_1/result', () => ({ body: seq[Math.min(i++, seq.length - 1)] })]]);
  const r = runner(fetchImpl);
  assert.deepEqual(await r.get('req_1'), { id: 'req_1', status: 'processing', outputUrl: null, error: null });
  const done = await r.get('req_1');
  assert.equal(done.status, 'completed');
  assert.equal(done.outputUrl, 'https://cdn/out.mp4');
});

test('get surfaces failure/moderation as a terminal status', async () => {
  const fetchImpl = fakeFetch([['/predictions/bad/result', { body: { status: 'failed', error: 'nsfw' } }]]);
  const r = runner(fetchImpl);
  const res = await r.get('bad');
  assert.equal(res.status, 'failed');       // terminal per batch FAILURE_RE
  assert.equal(res.outputUrl, null);
  assert.equal(res.error, 'nsfw');
});

test('submit HTTP error throws MuapiError', async () => {
  const fetchImpl = fakeFetch([['omni-reference', { ok: false, status: 400, body: 'bad request' }]]);
  const r = runner(fetchImpl);
  await assert.rejects(() => r.generate('seedance_2_5', { prompt: 'x', mode: 'omni_reference', imageReferences: ['https://x/y.png'] }), /submit failed \(HTTP 400\)/);
});

test('estimateCost = duration x per-second rate by resolution', async () => {
  const r = runner(fakeFetch([]));
  assert.equal(await r.estimateCost('seedance_2_5', { resolution: '480p', duration: 4 }), 0.68);
  assert.equal(await r.estimateCost('seedance_2_5', { resolution: '720p', duration: 5 }), 1.70);
  assert.equal(await r.estimateCost('seedance_2_5', { duration: 0 }), null);
});

test('generate throws without MUAPI_KEY', async () => {
  const r = createMuapiRunner({ apiKey: '', falKey: 'FK', fetchImpl: fakeFetch([]), uploadFile: async (p) => p });
  await assert.rejects(() => r.generate('seedance_2_5', { prompt: 'x', imageReferences: ['https://x/y.png'] }), /MUAPI_KEY is not set/);
});
