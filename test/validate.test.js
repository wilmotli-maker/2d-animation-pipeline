import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement, writeStyleLock } from '../src/element.js';
import { sheetPromptPath } from '../src/paths.js';
import { SLUG_RE, resolvePrompt, validateElementSheet, validateShotGenerate } from '../src/validate.js';
import { createShot, newDraft } from '../src/shot.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'val-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function writeSheetPrompt(root, type, name, sheet, id, text) {
  const p = sheetPromptPath(root, type, name, sheet, id);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, text);
}

test('SLUG_RE accepts kebab slugs and rejects unsafe ones', () => {
  for (const ok of ['winter-outfit', 'a', 'combat-stances', 'v2']) assert.ok(SLUG_RE.test(ok), ok);
  for (const bad of ['', 'Winter', 'a b', 'a/b', '-lead', '..']) assert.ok(!SLUG_RE.test(bad), bad);
});

test('resolvePrompt: inline wins, both is an error, empty is an error', async () => {
  assert.equal((await resolvePrompt({ prompt: 'hi' })).text, 'hi');
  assert.match((await resolvePrompt({ prompt: 'a', promptFile: '/x' })).error, /only one/i);
  assert.match((await resolvePrompt({ prompt: '   ' })).error, /empty/i);
  assert.match((await resolvePrompt({ canonicalPath: '/nope/prompt.md' })).error, /not found/i);
});

test('resolvePrompt reads a file when no inline prompt is given', async () => {
  await withTemp(async (dir) => {
    const f = path.join(dir, 'prompt.md');
    await writeFile(f, 'detailed prompt');
    assert.equal((await resolvePrompt({ canonicalPath: f })).text, 'detailed prompt');
    assert.equal((await resolvePrompt({ promptFile: f })).text, 'detailed prompt');
  });
});

test('validateElementSheet passes when element, slug, prompt, style-lock all present', async () => {
  await withTemp(async (root) => {
    await createElement(root, { type: 'characters', name: 'cecilia' });
    await writeStyleLock(root, 'characters', 'cecilia', { palette: ['#f00'] });
    await writeSheetPrompt(root, 'characters', 'cecilia', 'turnaround', 'winter', 'a prompt');
    const r = await validateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'turnaround', id: 'winter', images: [],
    });
    assert.equal(r.ok, true);
    assert.equal(r.promptText, 'a prompt');
    assert.ok(r.checks.every((c) => c.status !== 'fail'));
  });
});

test('validateElementSheet fails on missing element, bad slug, missing prompt', async () => {
  await withTemp(async (root) => {
    const r = await validateElementSheet(root, {
      type: 'characters', name: 'ghost', sheet: 'turnaround', id: 'Bad Slug', images: [],
    });
    assert.equal(r.ok, false);
    const failed = r.checks.filter((c) => c.status === 'fail').map((c) => c.label);
    assert.ok(failed.includes('element exists'));
    assert.ok(failed.includes('sheet id valid'));
    assert.ok(failed.includes('prompt present'));
  });
});

test('validateElementSheet warns (not fails) when style-lock is absent', async () => {
  await withTemp(async (root) => {
    await createElement(root, { type: 'characters', name: 'nolock' });
    await writeSheetPrompt(root, 'characters', 'nolock', 'turnaround', 'a', 'p');
    const r = await validateElementSheet(root, {
      type: 'characters', name: 'nolock', sheet: 'turnaround', id: 'a', images: [],
    });
    assert.equal(r.ok, true);
    const sl = r.checks.find((c) => c.label === 'style-lock present');
    assert.equal(sl.status, 'warn');
  });
});

test('validateElementSheet fails when a referenced image is missing', async () => {
  await withTemp(async (root) => {
    await createElement(root, { type: 'characters', name: 'cecilia' });
    await writeSheetPrompt(root, 'characters', 'cecilia', 'turnaround', 'a', 'p');
    const r = await validateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'turnaround', id: 'a',
      images: ['/does/not/exist.png'],
    });
    assert.equal(r.ok, false);
    assert.ok(r.checks.some((c) => c.label === 'reference image' && c.status === 'fail'));
  });
});

test('validateShotGenerate checks shot + draft existence and the draft prompt', async () => {
  await withTemp(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    const { dir } = await newDraft(root, 's1');
    await writeFile(path.join(dir, 'prompt.md'), 'shot prompt');
    const ok = await validateShotGenerate(root, { shotId: 's1', version: 1, images: [] });
    assert.equal(ok.ok, true);
    assert.equal(ok.promptText, 'shot prompt');

    const noShot = await validateShotGenerate(root, { shotId: 'nope', version: 1, images: [] });
    assert.equal(noShot.ok, false);
    assert.ok(noShot.checks.some((c) => c.label === 'shot exists' && c.status === 'fail'));

    const noDraft = await validateShotGenerate(root, { shotId: 's1', version: 9, images: [] });
    assert.ok(noDraft.checks.some((c) => c.label === 'draft exists' && c.status === 'fail'));
  });
});

async function seedDraft(root, promptText = 'shot prompt') {
  await createShot(root, { shotId: 's1', elements: [] });
  const { dir } = await newDraft(root, 's1');
  await writeFile(path.join(dir, 'prompt.md'), promptText);
  return dir;
}

test('validateShotGenerate checks speech-audio / video / audio files exist', async () => {
  await withTemp(async (root) => {
    await seedDraft(root);
    const wav = path.join(root, 'ART1.wav');
    await writeFile(wav, 'RIFF');

    const good = await validateShotGenerate(root, { shotId: 's1', version: 1, speechAudio: wav });
    assert.equal(good.ok, true);

    const bad = await validateShotGenerate(root, {
      shotId: 's1', version: 1, speechAudio: '/no/ART1.wav', videos: ['/no/clip.mp4'],
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.checks.some((c) => c.label === 'speech audio' && c.status === 'fail'));
    assert.ok(bad.checks.some((c) => c.label === 'reference video' && c.status === 'fail'));
  });
});

test('validateShotGenerate enforces Seedance 2.0 reference-count caps', async () => {
  await withTemp(async (root) => {
    await seedDraft(root);
    const many = (n, ext) => Array.from({ length: n }, (_, i) => `/x/${i}.${ext}`);

    const tooManyVideos = await validateShotGenerate(root, {
      shotId: 's1', version: 1, model: 'seedance_2_0', videos: many(3, 'mp4'), speechAudio: '/x/s.wav',
    });
    assert.ok(tooManyVideos.checks.some((c) => c.label === 'video ref count' && c.status === 'fail'),
      'speech-audio counts toward the 3-video cap');

    const tooManyImages = await validateShotGenerate(root, {
      shotId: 's1', version: 1, model: 'seedance_2_0', images: many(10, 'png'),
    });
    assert.ok(tooManyImages.checks.some((c) => c.label === 'image ref count' && c.status === 'fail'));

    const orphanAudio = await validateShotGenerate(root, {
      shotId: 's1', version: 1, model: 'seedance_2_0', audios: ['/x/a.wav'],
    });
    assert.ok(orphanAudio.checks.some((c) => c.label === 'audio ref anchor' && c.status === 'fail'));
  });
});

test('an omitted model falls back to the 2.0 caps and says so', async () => {
  await withTemp(async (root) => {
    await seedDraft(root);
    const many = (n, ext) => Array.from({ length: n }, (_, i) => `/x/${i}.${ext}`);
    const r = await validateShotGenerate(root, { shotId: 's1', version: 1, images: many(10, 'png') });
    const c = r.checks.find((c) => c.label === 'image ref count');
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /default/);
  });
});

test('Seedance 2.5 allows counts that 2.0 rejects', async () => {
  await withTemp(async (root) => {
    await seedDraft(root);
    const many = (n, ext) => Array.from({ length: n }, (_, i) => `/x/${i}.${ext}`);

    // 10 images: fails on 2.0 (cap 9), passes on 2.5 (cap 30).
    const on25 = await validateShotGenerate(root, {
      shotId: 's1', version: 1, model: 'seedance_2_5', images: many(10, 'png'),
    });
    assert.ok(!on25.checks.some((c) => c.label === 'image ref count' && c.status === 'fail'),
      '2.5 permits 10 images');

    // 2.5 states no video sub-cap: 5 videos must not fail the video-count check.
    const manyVideos25 = await validateShotGenerate(root, {
      shotId: 's1', version: 1, model: 'seedance_2_5', videos: many(5, 'mp4'),
    });
    assert.ok(!manyVideos25.checks.some((c) => c.label === 'video ref count' && c.status === 'fail'),
      '2.5 has no video sub-cap');

    // But the 50-total cap still bites.
    const overTotal = await validateShotGenerate(root, {
      shotId: 's1', version: 1, model: 'seedance_2_5', images: many(30, 'png'), videos: many(21, 'mp4'),
    });
    assert.ok(overTotal.checks.some((c) => c.label === 'total ref count' && c.status === 'fail'),
      '2.5 still enforces the 50-total cap');
  });
});

test('resolution enum is model-aware: 1080p ok on 2.0, warned on 2.5', async () => {
  await withTemp(async (root) => {
    await seedDraft(root);
    const on20 = await validateShotGenerate(root, {
      shotId: 's1', version: 1, model: 'seedance_2_0', resolution: '1080p',
    });
    assert.ok(!on20.checks.some((c) => c.label === 'resolution'), '2.0 supports 1080p');

    const on25 = await validateShotGenerate(root, {
      shotId: 's1', version: 1, model: 'seedance_2_5', resolution: '1080p',
    });
    assert.ok(on25.checks.some((c) => c.label === 'resolution' && c.status === 'warn'),
      '2.5 caps at 720p, so 1080p warns');
  });
});

test('validateShotGenerate warns on unknown enums but fails on bad boolean/duration', async () => {
  await withTemp(async (root) => {
    await seedDraft(root);

    const warned = await validateShotGenerate(root, {
      shotId: 's1', version: 1, resolution: '999p', aspectRatio: '5:7',
    });
    assert.equal(warned.ok, true, 'unknown enums warn, not fail (model-dependent)');
    assert.ok(warned.checks.some((c) => c.label === 'resolution' && c.status === 'warn'));
    assert.ok(warned.checks.some((c) => c.label === 'aspect ratio' && c.status === 'warn'));

    const failed = await validateShotGenerate(root, {
      shotId: 's1', version: 1, generateAudio: 'yes', duration: '0',
    });
    assert.equal(failed.ok, false);
    assert.ok(failed.checks.some((c) => c.label === 'generate-audio' && c.status === 'fail'));
    assert.ok(failed.checks.some((c) => c.label === 'duration' && c.status === 'fail'));
  });
});
