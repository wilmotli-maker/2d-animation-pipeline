import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MATTE_FORMATS, MATTE_QUALITIES, resolveSourceClip, parseMatteReport,
  matteEngine, plateMatteEngine, matteShot, streamingExec,
  MATTE_METHODS, MATTE_DEFAULT_METHOD,
  MATTE_KEY_ENGINES, MATTE_CORES, MATTE_REFINES,
  MATTE_DEFAULT_CORE, MATTE_DEFAULT_REFINE,
  MATTE_REFINE_TRIMAPS, MATTE_DEFAULT_REFINE_TRIMAP, keyEngineToComposition,
} from '../src/matte.js';
import { matteModelPath, matteModelUrl, matteThreads, MATTE_DEFAULT_QUALITY } from '../src/config.js';

// Read a flag's value out of an argv array. Position-independent on purpose:
// asserting with slice(-2) breaks the moment a new flag is appended.
function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

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
      '--quality', 'fast', '--threads', '4',
    ]);
  });
});

test('matteEngine despills by default and can be turned off', async () => {
  await withTemp(async (dir) => {
    const model = await seedModel(dir);
    const { calls, exec } = fakeExec();
    const engine = matteEngine({ runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', model, exec });

    await engine.run({ input: '/in.mp4', output: '/out.mov' });
    assert.equal(flagValue(calls[0].args, '--despill'), 'true');

    await engine.run({ input: '/in.mp4', output: '/out.mov', despill: false });
    assert.equal(flagValue(calls[1].args, '--despill'), 'false');
  });
});

// --- plateMatteEngine (--method plate) -----------------------------------

test('plateMatteEngine passes input/output/format/despill and needs no model', async () => {
  const { calls, exec } = fakeExec();
  const engine = plateMatteEngine({
    runner: { bin: 'uv', prefixArgs: ['run', 'python'] },
    script: '/repo/python/plate_matte.py', exec,
  });
  const report = await engine.run({ input: '/in.mp4', output: '/out.mov', format: 'prores4444' });

  assert.deepEqual(report, OK_REPORT);
  assert.deepEqual(calls[0].args, [
    'run', 'python', '/repo/python/plate_matte.py',
    '--input', '/in.mp4', '--output', '/out.mov', '--format', 'prores4444', '--despill', 'true',
    // Default composition: chroma core + closed-form refine (== the old trimap).
    '--matte', 'chroma', '--refine', 'closed-form',
  ]);
  // No ML-only flags leak into the plate sidecar.
  for (const flag of ['--model', '--quality', '--threads']) {
    assert.equal(calls[0].args.includes(flag), false, `${flag} should not be passed`);
  }
});

test('plateMatteEngine omits --feather unless set, and forwards it when set', async () => {
  const { calls, exec } = fakeExec();
  const base = { runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', exec };

  await plateMatteEngine(base).run({ input: '/in.mp4', output: '/out.mov' });
  assert.equal(calls[0].args.includes('--feather'), false);

  await plateMatteEngine({ ...base, feather: 1.4 }).run({ input: '/in.mp4', output: '/out.mov' });
  assert.equal(flagValue(calls[1].args, '--feather'), '1.4');
});

test('plateMatteEngine despills by default and can be turned off', async () => {
  const { calls, exec } = fakeExec();
  const engine = plateMatteEngine({ runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', exec });

  await engine.run({ input: '/in.mp4', output: '/out.mov' });
  assert.equal(flagValue(calls[0].args, '--despill'), 'true');

  await engine.run({ input: '/in.mp4', output: '/out.mov', despill: false });
  assert.equal(flagValue(calls[1].args, '--despill'), 'false');
});

test('plateMatteEngine surfaces a matchable error on a missing runner', async () => {
  const { exec } = fakeExec({ code: 127, stdout: '', stderr: 'spawn uv ENOENT' });
  const engine = plateMatteEngine({ runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', exec });
  await assert.rejects(
    engine.run({ input: '/in.mp4', output: '/out.mov' }),
    /uv.*not found|install uv/);
});

test('matte methods expose ml as the default', () => {
  assert.deepEqual(MATTE_METHODS, ['ml', 'plate']);
  assert.equal(MATTE_DEFAULT_METHOD, 'ml');
});

// --- plate composition: --matte core x --refine stage --------------------

test('plate cores/refines expose the composed defaults and the deprecated alias', () => {
  assert.deepEqual(MATTE_CORES, ['chroma', 'keylight']);
  assert.deepEqual(MATTE_REFINES, ['none', 'closed-form']);
  assert.equal(MATTE_DEFAULT_CORE, 'chroma');
  assert.equal(MATTE_DEFAULT_REFINE, 'closed-form');
  // Alias mapping retained for back-compat.
  assert.deepEqual(MATTE_KEY_ENGINES, ['trimap', 'keylight']);
  assert.deepEqual(keyEngineToComposition('trimap'), { core: 'chroma', refine: 'closed-form' });
  assert.deepEqual(keyEngineToComposition('keylight'), { core: 'keylight', refine: 'none' });
});

test('plateMatteEngine defaults to chroma+closed-form and passes no keylight flags', async () => {
  const { calls, exec } = fakeExec();
  await plateMatteEngine({ runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', exec })
    .run({ input: '/in.mp4', output: '/out.mov' });
  assert.equal(flagValue(calls[0].args, '--matte'), 'chroma');
  assert.equal(flagValue(calls[0].args, '--refine'), 'closed-form');
  for (const flag of ['--screen-colour', '--screen-balance', '--clip-black', '--inside-mask']) {
    assert.equal(calls[0].args.includes(flag), false, `${flag} should not leak into chroma`);
  }
});

test('plateMatteEngine forwards a keylight core and its options', async () => {
  const { calls, exec } = fakeExec();
  await plateMatteEngine({
    runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', exec,
    core: 'keylight', refine: 'none',
    keylight: {
      screenColour: '#3ba35f', screenBalance: 0.5, clipBlack: 0.1, clipWhite: 0.6,
      screenGain: 1.2, screenPreBlur: 1, despillBias: 'auto',
      insideMask: '/in.png', outsideMask: '/out',
    },
  }).run({ input: '/in.mp4', output: '/out.mov' });

  const a = calls[0].args;
  assert.equal(flagValue(a, '--matte'), 'keylight');
  assert.equal(flagValue(a, '--refine'), 'none');
  assert.equal(flagValue(a, '--screen-colour'), '#3ba35f');
  assert.equal(flagValue(a, '--screen-balance'), '0.5');
  assert.equal(flagValue(a, '--clip-black'), '0.1');
  assert.equal(flagValue(a, '--clip-white'), '0.6');
  assert.equal(flagValue(a, '--screen-gain'), '1.2');
  assert.equal(flagValue(a, '--screen-pre-blur'), '1');
  assert.equal(flagValue(a, '--despill-bias'), 'auto');
  assert.equal(flagValue(a, '--inside-mask'), '/in.png');
  assert.equal(flagValue(a, '--outside-mask'), '/out');
});

test('plateMatteEngine forwards --refine closed-form on a keylight core', async () => {
  const { calls, exec } = fakeExec();
  await plateMatteEngine({
    runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', exec,
    core: 'keylight', refine: 'closed-form', keylight: { screenBalance: 0.9 },
  }).run({ input: '/in.mp4', output: '/out.mov' });
  assert.equal(flagValue(calls[0].args, '--matte'), 'keylight');
  assert.equal(flagValue(calls[0].args, '--refine'), 'closed-form');
  assert.equal(flagValue(calls[0].args, '--screen-balance'), '0.9');
});

test('plateMatteEngine forwards --refine-trimap plate + --plate-spread', async () => {
  const { calls, exec } = fakeExec();
  await plateMatteEngine({
    runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', exec,
    core: 'keylight', refine: 'closed-form', refineTrimap: 'plate', plateSpread: 0.012,
  }).run({ input: '/in.mp4', output: '/out.mov' });
  assert.equal(flagValue(calls[0].args, '--refine-trimap'), 'plate');
  assert.equal(flagValue(calls[0].args, '--plate-spread'), '0.012');
});

test('plateMatteEngine omits --refine-trimap at the default (alpha)', () => {
  assert.deepEqual(MATTE_REFINE_TRIMAPS, ['alpha', 'plate']);
  assert.equal(MATTE_DEFAULT_REFINE_TRIMAP, 'alpha');
});

test('plateMatteEngine does not forward --refine-trimap on a chroma core', async () => {
  const { calls, exec } = fakeExec();
  // refineTrimap has no meaning without a keylight closed-form solve.
  await plateMatteEngine({
    runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', exec,
    core: 'chroma', refine: 'closed-form', refineTrimap: 'plate',
  }).run({ input: '/in.mp4', output: '/out.mov' });
  assert.equal(calls[0].args.includes('--refine-trimap'), false);
});

test('plateMatteEngine drops keylight options when the core is chroma', async () => {
  const { calls, exec } = fakeExec();
  await plateMatteEngine({
    runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', exec,
    core: 'chroma', keylight: { screenBalance: 0.9 },
  }).run({ input: '/in.mp4', output: '/out.mov' });
  assert.equal(calls[0].args.includes('--screen-balance'), false);
});

test('plateMatteEngine only forwards the keylight options that are set', async () => {
  const { calls, exec } = fakeExec();
  await plateMatteEngine({
    runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', exec,
    core: 'keylight', refine: 'none', keylight: { screenBalance: 0.5 },
  }).run({ input: '/in.mp4', output: '/out.mov' });
  assert.equal(flagValue(calls[0].args, '--screen-balance'), '0.5');
  assert.equal(calls[0].args.includes('--clip-black'), false);
});

// The Node default and the sidecar's resolved default must agree: the CLI always
// passes --matte/--refine explicitly, but a direct sidecar call with neither flag
// nor the alias falls back to this line, and a silent disagreement would mean the
// two paths produce different mattes.
test('the plate sidecar default composition matches the Node defaults', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../python/plate_matte.py', import.meta.url), 'utf8');
  const m = /core,\s*refine\s*=\s*'([a-z]+)',\s*'([a-z-]+)'\s*#\s*historical default/.exec(src);
  assert.ok(m, 'could not find the default composition in python/plate_matte.py');
  assert.equal(m[1], MATTE_DEFAULT_CORE);
  assert.equal(m[2], MATTE_DEFAULT_REFINE);
});

// The trimap method is split into a chroma-key core and a reusable closed-form
// edge refinement (matte consolidation PR2). The refinement takes an arbitrary
// core alpha, so it can run on keylight too. Guard the API + the wrapper so the
// split is not silently collapsed back.
test('plate_matte.py exposes the split core/refine API', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../python/plate_matte.py', import.meta.url), 'utf8');
  for (const fn of ['def chroma_alpha(', 'def trimap_from_alpha(', 'def refine_edges(']) {
    assert.ok(src.includes(fn), `expected ${fn} in plate_matte.py`);
  }
  // matte() must stay a thin wrapper composing the two, not a re-fused copy.
  assert.match(src, /def matte\([\s\S]*?chroma_alpha\([\s\S]*?refine_edges\(/);
  // refine_edges must accept a plain alpha (the method-agnostic path).
  assert.match(src, /def refine_edges\([^)]*alpha=None/);
});

// --- quality + threads ---------------------------------------------------

test('matteEngine defaults to quality=fast and 4 threads', async () => {
  await withTemp(async (dir) => {
    const model = await seedModel(dir);
    const { calls, exec } = fakeExec();
    const engine = matteEngine({ runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', model, exec });
    await engine.run({ input: '/in.mp4', output: '/out.mov' });
    assert.equal(flagValue(calls[0].args, '--quality'), MATTE_DEFAULT_QUALITY);
    assert.equal(flagValue(calls[0].args, '--quality'), 'fast');
    assert.equal(flagValue(calls[0].args, '--threads'), '4');
  });
});

// The Node default and the sidecar's own argparse default must agree: the CLI
// always passes --quality explicitly, but anything invoking matte.py directly
// gets the argparse default, and a silent disagreement would mean the two paths
// produce different mattes.
test('the sidecar argparse default matches MATTE_DEFAULT_QUALITY', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../python/matte.py', import.meta.url), 'utf8');
  const m = /--quality',\s*default='([a-z]+)'/.exec(src);
  assert.ok(m, 'could not find the --quality default in python/matte.py');
  assert.equal(m[1], MATTE_DEFAULT_QUALITY);
});

test('matteEngine forwards quality and threads to the sidecar', async () => {
  await withTemp(async (dir) => {
    const model = await seedModel(dir);
    const { calls, exec } = fakeExec();
    const engine = matteEngine({
      runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', model, exec,
      quality: 'fast', threads: 6,
    });
    await engine.run({ input: '/in.mp4', output: '/out.mov' });
    assert.equal(flagValue(calls[0].args, '--quality'), 'fast');
    assert.equal(flagValue(calls[0].args, '--threads'), '6');
  });
});

test('matteEngine names the right weights and URL for the requested quality', async () => {
  await withTemp(async (dir) => {
    const { exec } = fakeExec();
    // No model file on disk, so the download hint fires and we can read it.
    const engine = matteEngine({
      runner: { bin: 'uv', prefixArgs: [] }, script: '/s.py', exec,
      quality: 'fast', model: path.join(dir, 'isnet-general-use.onnx'),
    });
    await assert.rejects(
      () => engine.run({ input: '/in.mp4', output: '/out.mov' }),
      /quality fast.*isnet-general-use\.onnx/s,
    );
  });
});

test('matteModelPath resolves a distinct file per quality', () => {
  const best = matteModelPath(null, 'best', '/repo');
  const fast = matteModelPath(null, 'fast', '/repo');
  assert.match(best, /birefnet-dis\.onnx$/);
  assert.match(fast, /isnet-general-use\.onnx$/);
  assert.notEqual(best, fast);
  assert.notEqual(matteModelUrl('best'), matteModelUrl('fast'));
});

test('matteModelPath rejects an unknown quality rather than guessing', () => {
  assert.throws(() => matteModelPath(null, 'turbo', '/repo'), /unknown matte quality "turbo"/);
});

test('matteThreads defaults to the measured optimum and takes an override', () => {
  assert.equal(matteThreads(), 4);
  assert.equal(matteThreads(6), 6);
  assert.equal(matteThreads('nonsense'), 4);
  assert.equal(matteThreads(0), 4);
  assert.deepEqual(MATTE_QUALITIES.sort(), ['best', 'fast']);
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
