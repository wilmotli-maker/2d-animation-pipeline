import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, HiggsfieldError, buildGenerateArgs, inheritStderrExec } from '../src/cli.js';

// A fake executor records the args it was called with and returns a scripted result.
function fakeExec(result) {
  const calls = [];
  const exec = async (bin, args) => {
    calls.push({ bin, args });
    return result;
  };
  return { exec, calls };
}

test('buildGenerateArgs maps options to CLI flags', () => {
  const args = buildGenerateArgs('soul-model', {
    prompt: 'a red apple',
    startImage: '/tmp/a.png',
    wait: true,
  });
  assert.deepEqual(args, [
    'generate', 'create', 'soul-model',
    '--prompt', 'a red apple',
    '--start-image', '/tmp/a.png',
    '--wait',
  ]);
});

test('buildGenerateArgs omits --wait when wait is false', () => {
  const args = buildGenerateArgs('m', { prompt: 'x', wait: false });
  assert.deepEqual(args, ['generate', 'create', 'm', '--prompt', 'x']);
});

test('buildGenerateArgs expands imageReferences to repeated --image-references', () => {
  const args = buildGenerateArgs('nano_banana', {
    prompt: 'x', imageReferences: ['/a.png', '/b.png'], wait: false,
  });
  assert.deepEqual(args, [
    'generate', 'create', 'nano_banana',
    '--prompt', 'x',
    '--image-references', '/a.png',
    '--image-references', '/b.png',
  ]);
});

test('buildGenerateArgs expands videoReferences and audioReferences to repeated flags', () => {
  const args = buildGenerateArgs('seedance_2_0', {
    prompt: 'x',
    videoReferences: ['/speech.mp4'],
    audioReferences: ['/a.wav', '/b.wav'],
    wait: false,
  });
  assert.deepEqual(args, [
    'generate', 'create', 'seedance_2_0',
    '--prompt', 'x',
    '--video-references', '/speech.mp4',
    '--audio-references', '/a.wav',
    '--audio-references', '/b.wav',
  ]);
});

test('buildGenerateArgs emits scalar model params and stringifies booleans', () => {
  const args = buildGenerateArgs('seedance_2_0', {
    prompt: 'talking head',
    imageReferences: ['/pose.png'],
    videoReferences: ['/speech.mp4'],
    resolution: '720p',
    duration: 5,
    generateAudio: true,
    aspectRatio: '3:4',
    mode: 'fast',
    wait: false,
  });
  assert.deepEqual(args, [
    'generate', 'create', 'seedance_2_0',
    '--prompt', 'talking head',
    '--image-references', '/pose.png',
    '--video-references', '/speech.mp4',
    '--resolution', '720p',
    '--duration', '5',
    '--generate-audio', 'true',
    '--aspect-ratio', '3:4',
    '--mode', 'fast',
  ]);
});

test('buildGenerateArgs stringifies generateAudio:false rather than dropping it', () => {
  const args = buildGenerateArgs('seedance_2_0', { prompt: 'x', generateAudio: false, wait: false });
  assert.deepEqual(args, [
    'generate', 'create', 'seedance_2_0',
    '--prompt', 'x',
    '--generate-audio', 'false',
  ]);
});

test('generate returns parsed job id on success and requests JSON output', async () => {
  const { exec, calls } = fakeExec({ code: 0, stdout: '{"id":"job_1","status":"queued"}', stderr: '' });
  const runner = createRunner({ exec, bin: 'higgsfield' });
  const res = await runner.generate('m', { prompt: 'x' });
  assert.equal(res.id, 'job_1');
  assert.equal(calls[0].bin, 'higgsfield');
  assert.equal(calls[0].args.at(-1), '--json');
});

test('generate throws HiggsfieldError on non-zero exit', async () => {
  const { exec } = fakeExec({ code: 2, stdout: '', stderr: 'bad model' });
  const runner = createRunner({ exec });
  await assert.rejects(
    () => runner.generate('m', { prompt: 'x' }),
    (err) => err instanceof HiggsfieldError && err.code === 2 && /bad model/.test(err.message),
  );
});

test('get returns a normalized job result', async () => {
  const { exec, calls } = fakeExec({
    code: 0,
    stdout: '{"id":"job_1","status":"completed","results":[{"url":"https://x/out.png"}]}',
    stderr: '',
  });
  const runner = createRunner({ exec });
  const res = await runner.get('job_1');
  assert.equal(res.status, 'completed');
  assert.equal(res.outputUrl, 'https://x/out.png');
  assert.deepEqual(calls[0].args, ['generate', 'get', 'job_1', '--json']);
});

test('waitFor polls and normalizes the result', async () => {
  const { exec, calls } = fakeExec({ code: 0, stdout: '{"id":"job_1","status":"completed"}', stderr: '' });
  const runner = createRunner({ exec });
  const res = await runner.waitFor('job_1');
  assert.equal(res.status, 'completed');
  assert.deepEqual(calls[0].args, ['generate', 'wait', 'job_1', '--json']);
});

test('listModels and getModel issue the right commands', async () => {
  const { exec, calls } = fakeExec({ code: 0, stdout: 'models...', stderr: '' });
  const runner = createRunner({ exec });
  await runner.listModels();
  await runner.getModel('soul-model');
  assert.deepEqual(calls[0].args, ['model', 'list', '--json']);
  assert.deepEqual(calls[1].args, ['model', 'get', 'soul-model', '--json']);
});

test('upload returns the media id and issues upload create', async () => {
  const { exec, calls } = fakeExec({
    code: 0,
    stdout: '{"id":"653374d0-c278-4f0e-9c1f-9691e792f375","type":"video","url":"https://x/v.mp4"}',
    stderr: '',
  });
  const runner = createRunner({ exec });
  const res = await runner.upload('/tmp/clip.mp4');
  assert.equal(res.id, '653374d0-c278-4f0e-9c1f-9691e792f375');
  assert.equal(res.type, 'video');
  assert.equal(res.url, 'https://x/v.mp4');
  assert.deepEqual(calls[0].args, ['upload', 'create', '/tmp/clip.mp4', '--json']);
});

test('upload accepts an array-wrapped response', async () => {
  const { exec } = fakeExec({ code: 0, stdout: '[{"id":"abc","type":"video"}]', stderr: '' });
  const runner = createRunner({ exec });
  assert.equal((await runner.upload('/tmp/a.mp4')).id, 'abc');
});

test('upload accepts a bare id string', async () => {
  const { exec } = fakeExec({ code: 0, stdout: '["abc"]', stderr: '' });
  const runner = createRunner({ exec });
  const res = await runner.upload('/tmp/a.mp4');
  assert.equal(res.id, 'abc');
  assert.equal(res.type, null);
});

test('upload throws when the response carries no id', async () => {
  const { exec } = fakeExec({ code: 0, stdout: '{"detail":"nope"}', stderr: '' });
  const runner = createRunner({ exec });
  await assert.rejects(() => runner.upload('/tmp/a.mp4'), /no media id/);
});

test('upload throws on non-JSON output', async () => {
  const { exec } = fakeExec({ code: 0, stdout: 'not json at all', stderr: '' });
  const runner = createRunner({ exec });
  await assert.rejects(() => runner.upload('/tmp/a.mp4'), /not JSON/);
});

test('upload surfaces a non-zero exit as HiggsfieldError', async () => {
  const { exec } = fakeExec({ code: 4, stdout: '', stderr: 'file not found' });
  const runner = createRunner({ exec });
  await assert.rejects(() => runner.upload('/tmp/missing.mp4'), HiggsfieldError);
});

test('inheritStderrExec captures stdout and reports the exit code', async () => {
  // node prints to stdout and exits 0 — stderr is inherited, not captured.
  const res = await inheritStderrExec(process.execPath, ['-e', 'process.stdout.write("hello")']);
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'hello');
  assert.equal(res.stderr, '');
});

test('inheritStderrExec reports a non-zero exit without throwing', async () => {
  const res = await inheritStderrExec(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(res.code, 3);
});

test('inheritStderrExec reports a spawn failure as code 127', async () => {
  const res = await inheritStderrExec('/no/such/binary-xyz', ['x']);
  assert.equal(res.code, 127);
  assert.match(res.stderr, /ENOENT|spawn/);
});
