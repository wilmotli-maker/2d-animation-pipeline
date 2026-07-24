import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, HiggsfieldError, buildGenerateArgs } from '../src/cli.js';

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
