// test/edit-ui-flow-morph.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowMorphArgs, flowMorphJoin, FLOW_MORPH_MODES } from '../src/edit-ui/flow-morph.js';
import { flowMorphRunner, FLOW_MORPH_DEPS } from '../src/config.js';

test('flowMorphArgs builds the sidecar argv and validates the mode', () => {
  const a = flowMorphArgs({ left: 'l.mp4', right: 'r.mp4', out: 'o.mp4', frames: 6, fps: 24, mode: 'one-sided-left' });
  assert.deepEqual(a, ['--left', 'l.mp4', '--right', 'r.mp4', '--out', 'o.mp4', '--frames', '6', '--fps', '24', '--mode', 'one-sided-left', '--flow', 'farneback']);
  assert.ok(FLOW_MORPH_MODES.includes('one-sided-right') && FLOW_MORPH_MODES.includes('balanced'));
  assert.throws(() => flowMorphArgs({ left: 'l', right: 'r', out: 'o', frames: 6, fps: 24, mode: 'bogus' }), /unknown flow-morph mode/);
});

test('flowMorphJoin spawns the runner with the script + args and returns the reported frame count', async () => {
  let got;
  const exec = async (bin, args) => { got = { bin, args }; return { code: 0, stdout: '{"frames": 61, "mode": "one-sided-left"}\n', stderr: '' }; };
  const res = await flowMorphJoin('l.mp4', 'r.mp4', {
    out: 'o.mp4', frames: 6, fps: 24, mode: 'one-sided-right',
    runner: { bin: 'uv', prefixArgs: ['run', 'python'] }, script: '/repo/python/flow_morph.py', exec,
  });
  assert.equal(res.frames, 61);
  assert.equal(got.bin, 'uv');
  assert.deepEqual(got.args.slice(0, 3), ['run', 'python', '/repo/python/flow_morph.py']);
  assert.ok(got.args.includes('one-sided-right'));
});

test('flowMorphJoin surfaces a helpful message when the runtime is missing', async () => {
  const exec = async () => ({ code: 127, stdout: '', stderr: 'spawn uv ENOENT' });
  await assert.rejects(
    () => flowMorphJoin('l', 'r', { out: 'o', frames: 6, fps: 24, runner: { bin: 'uv', prefixArgs: [] }, script: 's', exec }),
    (e) => /FLOW_MORPH_PYTHON/.test(e.message) && /EDIT_UI_MORPH=minterpolate/.test(e.message));
});

test('flowMorphJoin reports a non-zero exit with stderr', async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: 'cv2 boom' });
  await assert.rejects(
    () => flowMorphJoin('l', 'r', { out: 'o', frames: 6, fps: 24, runner: { bin: 'uv', prefixArgs: [] }, script: 's', exec }),
    /flow-morph failed \(exit 1\): cv2 boom/);
});

test('flowMorphRunner uses uv --with the flow deps by default, FLOW_MORPH_PYTHON overrides', () => {
  const saved = process.env.FLOW_MORPH_PYTHON; delete process.env.FLOW_MORPH_PYTHON;
  try {
    const r = flowMorphRunner();
    assert.equal(r.bin, 'uv');
    for (const d of FLOW_MORPH_DEPS) assert.ok(r.prefixArgs.includes(d), `--with ${d}`);
    assert.equal(r.prefixArgs.at(-1), 'python');
    process.env.FLOW_MORPH_PYTHON = '/usr/bin/python3';
    assert.deepEqual(flowMorphRunner(), { bin: '/usr/bin/python3', prefixArgs: [] });
  } finally { if (saved === undefined) delete process.env.FLOW_MORPH_PYTHON; else process.env.FLOW_MORPH_PYTHON = saved; }
});
