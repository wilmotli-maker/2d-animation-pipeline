import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyShotFilters, applyImageFilters, defaultShotSelection, defaultImageSelection } from '../src/review-filter.js';

const shotModel = {
  type: 'shots', shots: [
    { shotId: 'art-talk-01', episode: '1', characters: ['mira'], versions: [] },
    { shotId: 'art-walk-02', episode: '1', characters: ['joh'], versions: [] },
    { shotId: 'bg-plate-01', episode: '2', characters: [], versions: [] },
  ],
};

test('applyShotFilters: regex, characters, episode intersect', () => {
  assert.deepEqual(
    applyShotFilters(shotModel, { match: '^art-' }).shots.map((s) => s.shotId),
    ['art-talk-01', 'art-walk-02']);
  assert.deepEqual(
    applyShotFilters(shotModel, { characters: ['mira'] }).shots.map((s) => s.shotId),
    ['art-talk-01']);
  assert.deepEqual(
    applyShotFilters(shotModel, { match: '^art-', episodes: ['1'], characters: ['joh'] })
      .shots.map((s) => s.shotId),
    ['art-walk-02']);
  assert.equal(applyShotFilters(shotModel, {}).shots.length, 3);
});

const imageModel = {
  type: 'images', characters: [
    { type: 'characters', name: 'mira', sheets: [
      { sheetType: 'turnaround', slug: 'a', versions: [] },
      { sheetType: 'pose', slug: 'b', versions: [] }] },
    { type: 'characters', name: 'joh', sheets: [
      { sheetType: 'pose', slug: 'c', versions: [] }] },
  ],
};

test('applyImageFilters: characters + sheets intersect, prune empties', () => {
  const r = applyImageFilters(imageModel, { characters: ['mira'], sheets: ['pose'] });
  assert.equal(r.characters.length, 1);
  assert.equal(r.characters[0].name, 'mira');
  assert.deepEqual(r.characters[0].sheets.map((s) => s.sheetType), ['pose']);
  assert.equal(applyImageFilters(imageModel, { sheets: ['pose'] }).characters.length, 2);
});

test('defaultShotSelection: up to 2 most recent, final newest', () => {
  const m = { type: 'shots', shots: [
    { shotId: 's', versions: [
      { version: 'v001' }, { version: 'v002' }, { version: 'final' }] }] };
  const sel = defaultShotSelection(m);
  assert.deepEqual(sel.versions.s, ['v002', 'final']);
  assert.equal(sel.layout, 'side-by-side');
});

test('defaultImageSelection: up to 2 most recent per sheet', () => {
  const m = { type: 'images', characters: [
    { name: 'mira', sheets: [
      { sheetType: 'pose', slug: 'a', versions: [
        { version: 'v001' }, { version: 'v002' }, { version: 'v003' }] }] }] };
  const sel = defaultImageSelection(m);
  assert.deepEqual(sel.versions['mira/pose/a'], ['v002', 'v003']);
});
