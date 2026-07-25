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
