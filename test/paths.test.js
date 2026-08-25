import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../src/paths.js';
import { elementUpscalePath, imageGenerationsLogPath } from '../src/paths.js';

const ROOT = '/tmp/root';

test('formatVersion zero-pads to v###', () => {
  assert.equal(p.formatVersion(1), 'v001');
  assert.equal(p.formatVersion(23), 'v023');
  assert.equal(p.formatVersion(100), 'v100');
});

test('element paths follow elements/<type>/<name>/...', () => {
  assert.equal(p.elementDir(ROOT, 'characters', 'cecilia'),
    '/tmp/root/elements/characters/cecilia');
  assert.equal(p.styleLockPath(ROOT, 'characters', 'cecilia'),
    '/tmp/root/elements/characters/cecilia/style-lock.yaml');
  assert.equal(p.generationsLogPath(ROOT, 'characters', 'cecilia'),
    '/tmp/root/elements/characters/cecilia/generations.jsonl');
  assert.equal(p.sheetDir(ROOT, 'characters', 'cecilia', 'turnaround'),
    '/tmp/root/elements/characters/cecilia/sheets/turnaround');
});

test('sheetInstanceDir nests a slug under the sheet type', () => {
  assert.equal(p.sheetInstanceDir(ROOT, 'characters', 'cecilia', 'turnaround', 'winter-outfit'),
    '/tmp/root/elements/characters/cecilia/sheets/turnaround/winter-outfit');
});

test('sheetPromptPath is the canonical prompt.md inside the instance', () => {
  assert.equal(p.sheetPromptPath(ROOT, 'characters', 'cecilia', 'turnaround', 'winter-outfit'),
    '/tmp/root/elements/characters/cecilia/sheets/turnaround/winter-outfit/prompt.md');
});

test('shot paths follow shots/<shotId>/...', () => {
  assert.equal(p.shotDir(ROOT, 's010_kitchen'),
    '/tmp/root/shots/s010_kitchen');
  assert.equal(p.shotYamlPath(ROOT, 's010_kitchen'),
    '/tmp/root/shots/s010_kitchen/shot.yaml');
  assert.equal(p.shotDraftDir(ROOT, 's010_kitchen', 2),
    '/tmp/root/shots/s010_kitchen/drafts/v002');
  assert.equal(p.shotFinalDir(ROOT, 's010_kitchen'),
    '/tmp/root/shots/s010_kitchen/final');
});

test('elementUpscalePath sits beside the sheet instance, prefixed by source stem', () => {
  const p = elementUpscalePath('/r', 'characters', 'ndiva', 'turnaround', 'front', 'v003', '2x-topaz_image');
  assert.equal(p, '/r/elements/characters/ndiva/sheets/turnaround/front/v003.upscaled-2x-topaz_image.png');
});

test('imageGenerationsLogPath is project-root images/generations.jsonl', () => {
  assert.equal(imageGenerationsLogPath('/r'), '/r/images/generations.jsonl');
});
