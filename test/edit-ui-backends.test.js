// test/edit-ui-backends.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { hfBackend, muapiBackend, muapiScriptPath } from '../src/edit-ui/backends.js';

const win = (wDir) => ({
  wName: 'w01', wDir, promptFile: path.join(wDir, 'prompt.md'), prompt: 'do a thing',
  first: path.join(wDir, 'first.png'), last: path.join(wDir, 'last.png'),
  poses: [path.join(wDir, 'pose1.png')], speechRefPath: path.join(wDir, 'speech.mp4'),
  resolution: '480p', aspectRatio: '3:4', duration: 4, generateAudio: true,
});

test('hfBackend.submit builds omni_reference opts, uploads the speech-ref, downloads the result', async () => {
  const b = hfBackend();
  assert.equal(b.name, 'hf');
  const subs = [];
  const runner = { upload: async () => ({ id: 'vid-9' }) };
  const runBatch = async (_r, items) => { subs.push(...items); return [{ status: 'completed', outputUrl: 'http://x/o.mp4' }]; };
  let downloaded = null;
  const download = async (url, abs) => { downloaded = { url, abs }; };
  const res = await b.submit(win('/tmp/w'), { runner, runBatch, download });
  const { opts, model, ref } = subs[0];
  assert.equal(model, 'seedance_2_5'); assert.equal(ref, 'w01');
  assert.equal(opts.mode, 'omni_reference');
  assert.equal(opts.startImage, '/tmp/w/first.png');
  assert.equal(opts.endImage, '/tmp/w/last.png');
  assert.deepEqual(opts.imageReferences, ['/tmp/w/pose1.png']);
  assert.deepEqual(opts.videoReferences, ['vid-9']);        // speech-ref uploaded
  assert.equal(opts.draft, undefined);                      // full quality
  assert.equal(opts.duration, 4);
  assert.equal(res.output, '/tmp/w/out.mp4');
  assert.equal(downloaded.url, 'http://x/o.mp4');
});

test('hfBackend.submit throws on a non-completed result (e.g. nsfw)', async () => {
  const b = hfBackend();
  const runBatch = async () => [{ status: 'error', error: 'generation nsfw' }];
  await assert.rejects(() => b.submit(win('/tmp/w'), { runner: { upload: async () => ({ id: 'v' }) }, runBatch, download: async () => {} }), /nsfw/);
});

test('muapiBackend.buildArgs passes prompt, first/last + pose images, speech video, and params', () => {
  const b = muapiBackend();
  assert.equal(b.name, 'muapi');
  const a = b.buildArgs(win('/tmp/w')).join(' ');
  assert.match(a, /--prompt-file \/tmp\/w\/prompt\.md/);
  assert.match(a, /--image \/tmp\/w\/first\.png --image \/tmp\/w\/last\.png --image \/tmp\/w\/pose1\.png/);
  assert.match(a, /--video \/tmp\/w\/speech\.mp4/);
  assert.match(a, /--resolution 480p --aspect-ratio 3:4 --duration 4 --generate-audio true/);
  assert.match(a, /--out \/tmp\/w\/muapi/);
});

test('muapiBackend.submit runs the script and returns out.mp4 on success; throws on failure', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'muapi-'));
  try {
    const wDir = path.join(ws, 'w01'); await mkdir(path.join(wDir, 'muapi'), { recursive: true });
    // success: fake spawn that "produces" output.mp4 then exits 0
    const okSpawn = (bin, args) => {
      const ee = new EventEmitter(); ee.stdout = new EventEmitter(); ee.stderr = new EventEmitter();
      writeFile(path.join(wDir, 'muapi', 'output.mp4'), 'clip').then(() => setImmediate(() => ee.emit('close', 0)));
      return ee;
    };
    const res = await muapiBackend({ spawn: okSpawn, script: 'x.js' }).submit({ ...win(wDir) });
    assert.equal(res.output, path.join(wDir, 'out.mp4'));
    await access(res.output);                                // copied

    // failure: exit 1, no output
    const failSpawn = () => { const ee = new EventEmitter(); ee.stdout = new EventEmitter(); ee.stderr = new EventEmitter(); setImmediate(() => { ee.stderr.emit('data', 'boom'); ee.emit('close', 1); }); return ee; };
    const wDir2 = path.join(ws, 'w02'); await mkdir(wDir2, { recursive: true });
    await assert.rejects(() => muapiBackend({ spawn: failSpawn, script: 'x.js' }).submit({ ...win(wDir2) }), /muapi generation failed \(exit 1\)/);
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('muapiScriptPath points at the muapi-seedance.js client', () => {
  assert.match(muapiScriptPath('/repo'), /\/repo\/scripts\/eval\/video-editing\/keyframe-edit-eval\/muapi-seedance\.js$/);
});
