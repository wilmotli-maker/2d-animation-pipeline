import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MATTE_FORMATS, resolveSourceClip, parseMatteReport, matteEngine, matteShot, streamingExec,
} from '../src/matte.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'matte-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function seedModel(dir) {
  const model = path.join(dir, 'birefnet-dis.onnx');
  await writeFile(model, 'ONNX');
  return model;
}

// A shot with a promoted final clip and one draft.
async function seedShot(root, shotId, { promoted = null, plainOutput = false, draft = null } = {}) {
  const finalDir = path.join(root, 'shots', shotId, 'final');
  await mkdir(finalDir, { recursive: true });
  if (promoted) await writeFile(path.join(finalDir, promoted), 'MP4');
  if (plainOutput) await writeFile(path.join(finalDir, 'output.mp4'), 'MP4');
  if (draft) {
    const d = path.join(root, 'shots', shotId, 'drafts', draft);
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, 'output.mp4'), 'MP4');
  }
  return finalDir;
}

const OK_REPORT = { frames: 121, width: 834, height: 1112, meanCoverage: 0.27 };
function fakeExec(result = { code: 0, stdout: JSON.stringify(OK_REPORT), stderr: '' }) {
  const calls = [];
  return {
    calls,
    exec: async (bin, args) => { calls.push({ bin, args }); return result; },
  };
}

// --- parseMatteReport ----------------------------------------------------

test('parseMatteReport reads the JSON report line', () => {
  assert.deepEqual(parseMatteReport('{"frames":3}'), { frames: 3 });
});

test('parseMatteReport ignores progress noise before the report', () => {
  const stdout = 'loading model\nwarming up\n{"frames":121,"seconds":42}\n';
  assert.deepEqual(parseMatteReport(stdout), { frames: 121, seconds: 42 });
});

test('parseMatteReport skips a non-JSON line that merely starts with a brace', () => {
  assert.deepEqual(parseMatteReport('{not json\n{"frames":1}\n'), { frames: 1 });
});

test('parseMatteReport throws when no report was printed', () => {
  assert.throws(() => parseMatteReport('nothing here\n'), /no JSON report/);
});

// --- streamingExec -------------------------------------------------------

test('streamingExec captures stdout and the exit code', async () => {
  const r = await streamingExec(process.execPath, ['-e', 'process.stdout.write("{\\"frames\\":2}")']);
  assert.equal(r.code, 0);
  assert.equal(parseMatteReport(r.stdout).frames, 2);
});

test('streamingExec reports a non-zero exit without throwing', async () => {
  const r = await streamingExec(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(r.code, 3);
});

test('streamingExec turns a missing binary into a matchable ENOENT result', async () => {
  const r = await streamingExec('definitely-not-a-real-binary-xyz', []);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /ENOENT/);
});

// --- resolveSourceClip ---------------------------------------------------

test('resolveSourceClip prefers the promoted <shotId>-vNNN clip', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'art-talk-01', { promoted: 'art-talk-01-v006.mp4', plainOutput: true });
    const found = await resolveSourceClip(root, 'art-talk-01');
    assert.equal(path.basename(found), 'art-talk-01-v006.mp4');
  });
});

test('resolveSourceClip picks the highest promoted version', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'art-talk-04', { promoted: 'art-talk-04-v013.mp4' });
    await writeFile(path.join(root, 'shots', 'art-talk-04', 'final', 'art-talk-04-v015.mp4'), 'MP4');
    const found = await resolveSourceClip(root, 'art-talk-04');
    assert.equal(path.basename(found), 'art-talk-04-v015.mp4');
  });
});

test('resolveSourceClip falls back to a plain output.mp4', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'ai-alt2-talk-04', { plainOutput: true });
    const found = await resolveSourceClip(root, 'ai-alt2-talk-04');
    assert.equal(path.basename(found), 'output.mp4');
  });
});

test('resolveSourceClip reads a specific draft when given a version', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'art-talk-01', { plainOutput: true, draft: 'v007' });
    const found = await resolveSourceClip(root, 'art-talk-01', 7);
    assert.match(found, /drafts[/\\]v007[/\\]output\.mp4$/);
  });
});

test('resolveSourceClip errors helpfully when the final dir has no clip', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'art-talk-09', {});
    await assert.rejects(() => resolveSourceClip(root, 'art-talk-09'), /no clip to matte|shot promote/);
  });
});

test('resolveSourceClip errors when the version does not exist', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'art-talk-01', { plainOutput: true });
    await assert.rejects(() => resolveSourceClip(root, 'art-talk-01', 42), /no such shot version/);
  });
});

// --- matteEngine ---------------------------------------------------------

test('matteEngine passes input, output, model and format to the sidecar', async () => {
  await withTemp(async (dir) => {
    const model = await seedModel(dir);
    const { calls, exec } = fakeExec();
    const engine = matteEngine({
      runner: { bin: 'uv', prefixArgs: ['run', 'python'] },
      script: '/repo/python/matte.py', model, exec,
    });
    const report = await engine.run({ input: '/in.mp4', output: '/out.mov', format: 'prores4444' });

    assert.deepEqual(report, OK_REPORT);
    assert.equal(calls[0].bin, 'uv');
    assert.deepEqual(calls[0].args, [
      'run', 'python', '/repo/python/matte.py',
      '--input', '/in.mp4', '--output', '/out.mov',
      '--model', model, '--format', 'prores4444', '--despill', 'true',
    ]);
  });
});

test('matteEngine despills by default and can be turned off', async () => {
  await withTemp(async (dir) => {
    const model = await seedModel(dir);
    const { calls, exec } = fakeExec();
    const engine = matteEngine({ runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', model, exec });

    await engine.run({ input: '/in.mp4', output: '/out.mov' });
    assert.deepEqual(calls[0].args.slice(-2), ['--despill', 'true']);

    await engine.run({ input: '/in.mp4', output: '/out.mov', despill: false });
    assert.deepEqual(calls[1].args.slice(-2), ['--despill', 'false']);
  });
});

test('matteEngine errors with a download hint when the model is missing', async () => {
  await withTemp(async (dir) => {
    const { exec } = fakeExec();
    const engine = matteEngine({
      runner: { bin: 'uv', prefixArgs: [] },
      script: '/s.py', model: path.join(dir, 'absent.onnx'), exec,
    });
    await assert.rejects(
      () => engine.run({ input: '/in.mp4', output: '/out.mov' }),
      /model not found|curl -L|MATTE_MODEL/,
    );
  });
});

test('matteEngine errors with an install hint when the runtime is missing', async () => {
  await withTemp(async (dir) => {
    const model = await seedModel(dir);
    const { exec } = fakeExec({ code: 127, stdout: '', stderr: 'spawn uv ENOENT' });
    const engine = matteEngine({
      runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', model, exec,
    });
    await assert.rejects(
      () => engine.run({ input: '/in.mp4', output: '/out.mov' }),
      /brew install uv|MATTE_PYTHON/,
    );
  });
});

test('matteEngine surfaces a non-zero exit as a clear error', async () => {
  await withTemp(async (dir) => {
    const model = await seedModel(dir);
    const { exec } = fakeExec({ code: 3, stdout: '', stderr: 'decoded no frames from /in.mp4' });
    const engine = matteEngine({
      runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', model, exec,
    });
    await assert.rejects(
      () => engine.run({ input: '/in.mp4', output: '/out.mov' }),
      /matte failed \(exit 3\).*decoded no frames/s,
    );
  });
});

// --- matteShot -----------------------------------------------------------

function fakeEngine() {
  const seen = [];
  return { seen, run: async (spec) => { seen.push(spec); return OK_REPORT; } };
}

test('matteShot writes alpha.mov beside the promoted clip', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'art-talk-01', { promoted: 'art-talk-01-v006.mp4' });
    const engine = fakeEngine();
    const res = await matteShot(root, { shotId: 'art-talk-01' }, { engine });

    assert.equal(path.basename(res.source), 'art-talk-01-v006.mp4');
    assert.match(res.output, /final[/\\]alpha\.mov$/);
    assert.equal(res.frames, 121);
    assert.equal(engine.seen[0].format, 'prores4444');
  });
});

test('matteShot writes into the draft folder when given a version', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'art-talk-01', { plainOutput: true, draft: 'v007' });
    const res = await matteShot(root, { shotId: 'art-talk-01', version: 7 }, { engine: fakeEngine() });
    assert.match(res.output, /drafts[/\\]v007[/\\]alpha\.mov$/);
  });
});

test('matteShot creates a folder, not a file, for a png sequence', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'art-talk-01', { plainOutput: true });
    const res = await matteShot(root, { shotId: 'art-talk-01', format: 'png' }, { engine: fakeEngine() });
    assert.match(res.output, /final[/\\]alpha$/);
    assert.ok((await stat(res.output)).isDirectory());
  });
});

test('matteShot honours an explicit --input over version resolution', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'art-talk-01', { plainOutput: true });
    const custom = path.join(root, 'elsewhere.mp4');
    await writeFile(custom, 'MP4');
    const res = await matteShot(root, { shotId: 'art-talk-01', input: custom }, { engine: fakeEngine() });
    assert.equal(res.source, custom);
  });
});

test('matteShot rejects a missing --input rather than silently resolving', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'art-talk-01', { plainOutput: true });
    await assert.rejects(
      () => matteShot(root, { shotId: 'art-talk-01', input: '/nope.mp4' }, { engine: fakeEngine() }),
      /--input not found/,
    );
  });
});

test('matteShot rejects an unknown format and names the valid ones', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'art-talk-01', { plainOutput: true });
    await assert.rejects(
      () => matteShot(root, { shotId: 'art-talk-01', format: 'gif' }, { engine: fakeEngine() }),
      /unknown --format "gif".*prores4444/s,
    );
    assert.ok(Object.keys(MATTE_FORMATS).includes('prores4444'));
  });
});

test('matteShot passes despill through to the engine, defaulting on', async () => {
  await withTemp(async (root) => {
    await seedShot(root, 'art-talk-01', { plainOutput: true });
    const on = fakeEngine();
    await matteShot(root, { shotId: 'art-talk-01' }, { engine: on });
    assert.equal(on.seen[0].despill, true);

    const off = fakeEngine();
    await matteShot(root, { shotId: 'art-talk-01', despill: false }, { engine: off });
    assert.equal(off.seen[0].despill, false);
  });
});

test('matteShot requires a shotId', async () => {
  await assert.rejects(() => matteShot('/root', {}, { engine: fakeEngine() }), /shotId is required/);
});
