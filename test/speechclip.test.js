import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { aspectDims, makeBlankSpeechVideo, extractAudio } from '../src/speechclip.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'speech-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// A fake ffmpeg executor records its args instead of spawning anything.
function fakeRun() {
  const calls = [];
  const run = async (bin, args) => { calls.push({ bin, args }); return { stdout: '', stderr: '' }; };
  return { run, calls };
}

test('aspectDims maps known aspects and rejects unknown ones', () => {
  assert.deepEqual(aspectDims('3:4'), [720, 960]);
  assert.deepEqual(aspectDims('16:9'), [1280, 720]);
  assert.deepEqual(aspectDims('9:16'), [720, 1280]);
  assert.equal(aspectDims('7:5'), null);
});

test('makeBlankSpeechVideo builds a mid-gray ffmpeg call sized for the aspect', async () => {
  await withTemp(async (dir) => {
    const { run, calls } = fakeRun();
    const out = path.join(dir, 'nested', 'speech-ref.mp4');
    const returned = await makeBlankSpeechVideo('/tmp/ART1.wav', out, { aspect: '3:4', run });

    assert.equal(returned, out);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, 'ffmpeg');
    const args = calls[0].args;
    // mid-gray, NOT black (black trips a false-positive nsfw flag), 3:4 -> 720x960.
    assert.ok(args.includes('color=c=0x7f7f7f:s=720x960:r=24'), args.join(' '));
    assert.ok(args.includes('-shortest'));
    assert.ok(args.includes('/tmp/ART1.wav'));
    assert.equal(args.at(-1), out);
    // Parent directory was created for the output.
    assert.ok((await stat(path.dirname(out))).isDirectory());
  });
});

test('makeBlankSpeechVideo honours a 16:9 aspect and custom fps', async () => {
  await withTemp(async (dir) => {
    const { run, calls } = fakeRun();
    await makeBlankSpeechVideo('/tmp/a.wav', path.join(dir, 'o.mp4'), { aspect: '16:9', fps: 30, run });
    assert.ok(calls[0].args.includes('color=c=0x7f7f7f:s=1280x720:r=30'));
  });
});

test('makeBlankSpeechVideo rejects an unsupported aspect before spawning', async () => {
  const { run, calls } = fakeRun();
  await assert.rejects(
    () => makeBlankSpeechVideo('/tmp/a.wav', '/tmp/o.mp4', { aspect: '7:5', run }),
    /unsupported aspect/i,
  );
  assert.equal(calls.length, 0);
});

test('extractAudio writes 16 kHz mono PCM from the first audio track, optionally trimmed', async () => {
  await withTemp(async (dir) => {
    const { run, calls } = fakeRun();
    const out = path.join(dir, 'nested', 'audio.wav');
    assert.equal(await extractAudio('/tmp/clip.mp4', out, { run }), out);
    const args = calls[0].args.join(' ');
    assert.match(args, /-i \/tmp\/clip\.mp4 -map 0:a:0 -vn -ac 1 -ar 16000 -c:a pcm_s16le/);
    assert.ok((await stat(path.dirname(out))).isDirectory());
    await extractAudio('/tmp/clip.mp4', out, { start: 1.5, end: 3, run });
    assert.match(calls[1].args.join(' '), /-ss 1\.5 -to 3 /);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('extractAudio really decodes with ffmpeg', { skip: !hasFfmpeg && 'ffmpeg not on PATH' }, async () => {
  await withTemp(async (dir) => {
    const src = path.join(dir, 's.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-f', 'lavfi', '-i', 'color=s=64x64:d=1', '-shortest', '-c:a', 'aac', src]);
    const out = await extractAudio(src, path.join(dir, 'a.wav'));
    assert.ok((await stat(out)).size > 16000 * 2 * 0.9);
  });
});
