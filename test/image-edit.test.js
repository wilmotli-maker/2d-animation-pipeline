import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { editImage, IMAGE_EDIT_DEFAULT_MODEL } from '../src/image-edit.js';

async function tmp() { return mkdtemp(path.join(tmpdir(), 'imgedit-')); }

// A fake runBatch that records the request and returns a canned result; a fake downloadTo that
// records (and creates) the written file so version scanning sees it.
function deps(result = { id: 'job1', status: 'completed', outputUrl: 'https://cdn/out.png' }) {
  const d = { requests: [], writes: [] };
  d.runBatch = async (_runner, requests) => { d.requests.push(...requests); return [result]; };
  d.downloadTo = async (url, p) => { d.writes.push({ url, path: p }); await writeFile(p, 'img'); };
  return d;
}
const RUNNER = {}; // never called directly — editImage goes through runBatch

test('passes prompt + image refs through runBatch and downloads the result', async () => {
  const out = await tmp();
  const d = deps();
  const res = await editImage('/root', { images: ['/a/ref1.png', '/b/ref2.png'], prompt: 'raise a fist', out }, { runner: RUNNER, runBatch: d.runBatch, downloadTo: d.downloadTo });
  assert.equal(d.requests[0].opts.prompt, 'raise a fist');
  assert.deepEqual(d.requests[0].opts.imageReferences, ['/a/ref1.png', '/b/ref2.png']);
  assert.equal(d.requests[0].model, IMAGE_EDIT_DEFAULT_MODEL);
  assert.equal(d.writes[0].url, 'https://cdn/out.png');
  assert.equal(res.outputPath, d.writes[0].path);
  assert.match(res.outputPath, /ref1-edit-v01\.png$/);
});

test('reads promptFile when prompt is absent', async () => {
  const out = await tmp();
  const pf = path.join(out, 'p.md');
  await writeFile(pf, '  a composed pose prompt\n');
  const d = deps();
  await editImage('/root', { images: ['/a/ref.png'], promptFile: pf, out }, { runner: RUNNER, runBatch: d.runBatch, downloadTo: d.downloadTo });
  assert.equal(d.requests[0].opts.prompt, 'a composed pose prompt');
});

test('throws when no images are given', async () => {
  const d = deps();
  await assert.rejects(() => editImage('/root', { images: [], prompt: 'x', out: '/tmp' }, { runner: RUNNER, runBatch: d.runBatch, downloadTo: d.downloadTo }), /image/i);
});

test('throws when neither prompt nor promptFile is given', async () => {
  const d = deps();
  await assert.rejects(() => editImage('/root', { images: ['/a/ref.png'], out: '/tmp' }, { runner: RUNNER, runBatch: d.runBatch, downloadTo: d.downloadTo }), /prompt/i);
});

test('throws when the runner result is not completed, and does not download', async () => {
  const out = await tmp();
  const d = deps({ id: 'job2', status: 'error', outputUrl: null, error: 'boom' });
  await assert.rejects(() => editImage('/root', { images: ['/a/ref.png'], prompt: 'x', out }, { runner: RUNNER, runBatch: d.runBatch, downloadTo: d.downloadTo }), /boom|error|did not complete/i);
  assert.equal(d.writes.length, 0);
});

test('versions the output so a second edit does not overwrite the first', async () => {
  const out = await tmp();
  await writeFile(path.join(out, 'ref-edit-v01.png'), 'existing');
  const d = deps();
  const res = await editImage('/root', { images: ['/a/ref.png'], prompt: 'x', out }, { runner: RUNNER, runBatch: d.runBatch, downloadTo: d.downloadTo });
  assert.match(res.outputPath, /ref-edit-v02\.png$/);
  const files = await readdir(out);
  assert.ok(files.includes('ref-edit-v01.png') && files.includes('ref-edit-v02.png'));
});
