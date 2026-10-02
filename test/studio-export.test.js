// test/studio-export.test.js
// Studio "Export selection" must import into the static review page
// (src/review-render.js), whose importer only accepts keys in its VALID set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderShotPage, renderImagePage } from '../src/review-render.js';
import { defaultShotSelection, defaultImageSelection } from '../src/review-filter.js';
import { shotKey, sheetKey, toStaticSelection, selectionExportDoc } from '../src/studio/web/views.js';

const ver = (version) => ({ version, kind: 'draft', promoted: false, video: `assets/${version}.mp4`,
  images: [`assets/${version}.png`], variants: { alpha: null, upscaled: [], qc: [] }, upscaled: [], meta: {} });

const shotModel = { type: 'shots', generatedAt: 'T', shots: [
  { shotId: 'ai-1', episode: '1', characters: [], description: '', promotedVersion: null, versions: [ver('v001'), ver('v002')] },
  { shotId: 'flat-1', episode: null, characters: [], description: '', promotedVersion: null, versions: [ver('v003')] },
] };
const imageModel = { type: 'images', generatedAt: 'T', characters: [
  { type: 'characters', name: 'mira', sheets: [{ sheetType: 'pose', slug: 'wave', versions: [ver('v001'), ver('v004')] }] },
] };

// The page's import whitelist, computed exactly as COMMON_SCRIPT does from the embedded data.
function validKeys(html) {
  const m = html.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  const data = JSON.parse(m[1]);   // < escapes are valid JSON
  const VALID = new Set();
  for (const key in data.selection.versions) for (const v of data.selection.versions[key]) VALID.add(key + '::' + v);
  return VALID;
}
// What importSelected would add from an exported doc.
function imported(doc, VALID) {
  const out = [];
  for (const key in doc.selected) {
    const arr = doc.selected[key]; if (!Array.isArray(arr)) continue;
    for (const v of arr) if (VALID.has(key + '::' + v)) out.push(key + '::' + v);
  }
  return out;
}

test('toStaticSelection: shots drop the episode, sheets drop the element type', () => {
  assert.deepEqual(toStaticSelection({
    '1/ai-1': ['v001'], 'flat-1': ['v003'], 'characters/mira/pose/wave': ['v004'],
  }), { 'ai-1': ['v001'], 'flat-1': ['v003'], 'mira/pose/wave': ['v004'] });
});

test('toStaticSelection: studio keys colliding on one static key are unioned and sorted', () => {
  assert.deepEqual(toStaticSelection({ '1/ai-1': ['v010', 'v002'], '2/ai-1': ['v002', 'v001'] }),
    { 'ai-1': ['v001', 'v002', 'v010'] });
});

test('selectionExportDoc: static-compatible `selected` plus lossless `studioSelected`', () => {
  const doc = selectionExportDoc({ project: 'demo', exportedAt: 'T',
    selected: new Set(['1/ai-1::v002', '1/ai-1::v001', 'characters/mira/pose/wave::v004']) });
  assert.deepEqual(doc, {
    format: 'studio-selection/1', project: 'demo', exportedAt: 'T',
    selected: { 'ai-1': ['v001', 'v002'], 'mira/pose/wave': ['v004'] },
    studioSelected: { '1/ai-1': ['v001', 'v002'], 'characters/mira/pose/wave': ['v004'] },
  });
});

test('round trip: every studio-exported selection is accepted by the static shot and image pages', () => {
  const studio = new Set();
  for (const s of shotModel.shots) for (const v of s.versions) studio.add(`${shotKey(s)}::${v.version}`);
  for (const c of imageModel.characters) {
    for (const sh of c.sheets) for (const v of sh.versions) studio.add(`${sheetKey(c.type, c.name, sh)}::${v.version}`);
  }
  const doc = JSON.parse(JSON.stringify(selectionExportDoc({ project: 'demo', exportedAt: 'T', selected: studio })));

  const shotVALID = validKeys(renderShotPage({ model: shotModel, selection: defaultShotSelection(shotModel) }));
  const imageVALID = validKeys(renderImagePage({ model: imageModel, selection: defaultImageSelection(imageModel) }));
  assert.deepEqual(imported(doc, shotVALID).sort(), ['ai-1::v001', 'ai-1::v002', 'flat-1::v003']);
  assert.deepEqual(imported(doc, imageVALID).sort(), ['mira/pose/wave::v001', 'mira/pose/wave::v004']);
  // Every exported entry lands on one page or the other: nothing is silently unimportable.
  const all = Object.entries(doc.selected).flatMap(([k, vs]) => vs.map((v) => `${k}::${v}`));
  for (const k of all) assert.ok(shotVALID.has(k) || imageVALID.has(k), k);
  // The raw studio keys would not have imported (the original bug).
  assert.deepEqual(imported({ selected: doc.studioSelected }, shotVALID), ['flat-1::v003']);
});

test('export tolerates keys named like Object.prototype members', () => {
  const keys = ['1/constructor', 'toString', '__defineGetter__'];
  const sel = new Set(keys.flatMap((k) => [`${k}::v002`, `${k}::v001`]));
  const doc = selectionExportDoc({ project: 'p', selected: sel, exportedAt: 'now' });
  assert.deepEqual(doc.studioSelected, {
    '1/constructor': ['v001', 'v002'], __defineGetter__: ['v001', 'v002'], toString: ['v001', 'v002'],
  });
  assert.deepEqual(doc.selected, { constructor: ['v001', 'v002'], toString: ['v001', 'v002'], __defineGetter__: ['v001', 'v002'] });
  assert.deepEqual(toStaticSelection({ toString: ['v001'], '2/toString': ['v002'] }), { toString: ['v001', 'v002'] });
});
