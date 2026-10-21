// test/edit-ui-colour-conform.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colourConformArgs, colourConform } from '../src/edit-ui/colour-conform.js';

test('colourConformArgs passes input, reference, out, strength and min-drift', () => {
  const a = colourConformArgs({ input: '/w/gen.mp4', reference: '/w/src-span.mp4', out: '/w/conformed.mp4', strength: 0.8, minDrift: 1.5 });
  assert.deepEqual(a, ['--input', '/w/gen.mp4', '--reference', '/w/src-span.mp4', '--out', '/w/conformed.mp4', '--strength', '0.8', '--min-drift', '1.5']);
});

test('colourConformArgs defaults strength to 1 and min-drift to 1', () => {
  const a = colourConformArgs({ input: 'g', reference: 'r', out: 'o' });
  assert.equal(a[a.indexOf('--strength') + 1], '1');
  assert.equal(a[a.indexOf('--min-drift') + 1], '1');
});

test('colourConform reports a pass-through skip (drift below the floor)', async () => {
  const exec = async () => ({ code: 0, stdout: '{"skipped":true,"driftBefore":0.32,"minDrift":1}\n', stderr: '' });
  const res = await colourConform({ input: 'g', reference: 'r', out: 'o', exec, runner: { bin: 'python', prefixArgs: [] }, script: 'x.py' });
  assert.equal(res.skipped, true);
  assert.equal(res.driftBefore, 0.32);
});

test('colourConform returns the report and out path on success', async () => {
  const exec = async () => ({ code: 0, stdout: '{"frames":96,"driftBefore":0.42,"driftAfter":0.05}\n', stderr: '' });
  const res = await colourConform({ input: 'g', reference: 'r', out: '/w/conformed.mp4', exec, runner: { bin: 'python', prefixArgs: [] }, script: 'x.py' });
  assert.equal(res.out, '/w/conformed.mp4');
  assert.equal(res.frames, 96);
  assert.equal(res.driftAfter, 0.05);
});

test('colourConform gives a helpful message when the runtime is missing', async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: 'spawn uv ENOENT' });
  await assert.rejects(
    () => colourConform({ input: 'g', reference: 'r', out: 'o', exec, runner: { bin: 'uv', prefixArgs: [] }, script: 'x.py' }),
    /uv|FLOW_MORPH_PYTHON|opencv/i,
  );
});

test('colourConform surfaces a non-zero exit', async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  await assert.rejects(
    () => colourConform({ input: 'g', reference: 'r', out: 'o', exec, runner: { bin: 'python', prefixArgs: [] }, script: 'x.py' }),
    /colour-conform failed \(exit 1\): boom/,
  );
});
