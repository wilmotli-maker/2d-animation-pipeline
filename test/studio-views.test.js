// test/studio-views.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esc, mediaUrl, parseRoute, treeHTML, homeHTML, shotRowsHTML, sheetRowsHTML,
} from '../src/studio/web/views.js';

const TREE = {
  project: 'demo',
  elements: [{ type: 'characters', name: 'mira', sheets: 2, versions: 5 }, { type: 'props', name: 'lamp', sheets: 0, versions: 0 }],
  episodes: [{ id: '1', shots: [{ shotId: 'ai-1', versions: 3, promotedVersion: 'v002', mattes: 1 }] }],
  shots: [],
};
const SHOT = {
  shotId: 'ai-1', episode: '1', description: 'hello <b>', characters: ['mira'], promotedVersion: 'v002',
  versions: [
    { version: 'v001', promoted: false, video: 'episodes/1/shots/ai-1/drafts/v001/output.mp4', variants: { alpha: null, upscaled: [], qc: [] }, meta: { model: 'seedance' } },
    { version: 'v002', promoted: true, video: 'episodes/1/shots/ai-1/drafts/v002/output.mp4', variants: { alpha: 'episodes/1/shots/ai-1/drafts/v002/alpha.webm', upscaled: [], qc: ['episodes/1/shots/ai-1/drafts/v002/qc/f0.png'] }, meta: {} },
  ],
};
const empty = () => ({ selected: new Set(), hidden: new Set(), mode: 'clips', bg: 'checker', onlySelected: false });

test('esc + mediaUrl', () => {
  assert.equal(esc('<a "b">'), '&lt;a &quot;b&quot;&gt;');
  assert.equal(mediaUrl('shots/a b/v#1.mp4'), '/media/shots/a%20b/v%231.mp4');
  assert.equal(mediaUrl('a/b\\c.mp4'), '/media/a/b%5Cc.mp4');   // backslash is a filename char on POSIX
  assert.equal(mediaUrl(null), null);
});

test('parseRoute', () => {
  assert.deepEqual(parseRoute(''), { view: 'home' });
  assert.deepEqual(parseRoute('#/element/characters/mira'), { view: 'element', type: 'characters', name: 'mira' });
  assert.deepEqual(parseRoute('#/episode/_'), { view: 'episode', episode: '_' });
  assert.deepEqual(parseRoute('#/shot/1/ai-1'), { view: 'shot', episode: '1', shotId: 'ai-1' });
  assert.deepEqual(parseRoute('#/bogus/x'), { view: 'home' });
  assert.deepEqual(parseRoute('#/shot/%E0'), { view: 'home' });   // malformed escape must not throw
});

test('parseRoute: folder routes (nested path, encoded segments)', () => {
  assert.deepEqual(parseRoute('#/folder/2/candidates'), { view: 'folder', episode: '2', path: 'candidates' });
  assert.deepEqual(parseRoute('#/folder/2/candidates/blue-matte-final'),
    { view: 'folder', episode: '2', path: 'candidates/blue-matte-final' });
  assert.deepEqual(parseRoute('#/folder/_/my%20clips/a%23b'), { view: 'folder', episode: '_', path: 'my clips/a#b' });
  assert.deepEqual(parseRoute('#/folder/2'), { view: 'home' });   // needs at least one path segment
});

test('treeHTML: folder nodes under episodes and the flat Shots section', () => {
  const t = { ...TREE,
    episodes: [{ id: '2', shots: [], folders: [{ path: 'candidates/blue matte', clips: 3 }] }],
    shots: [], folders: [{ path: 'assembled', clips: 1 }] };
  const h = treeHTML(t, '#/folder/2/candidates/blue%20matte');
  assert.match(h, /class="node folder on" href="#\/folder\/2\/candidates\/blue%20matte"><span>candidates\/blue matte<\/span><span class="meta">3 clips<\/span>/);
  assert.match(h, /<h3>Shots<\/h3>/);                     // flat folders alone still show the section
  assert.match(h, /class="node folder" href="#\/folder\/_\/assembled"/);
  assert.doesNotMatch(treeHTML({ ...t, folders: [] }, '#/'), /<h3>Shots<\/h3>/);
  // Trees without the folders keys (older shape) still render.
  assert.match(treeHTML(TREE, '#/'), /Episode 1/);
});

test('shotRowItems: keyPrefix namespaces folder rows', async () => {
  const { shotRowItems } = await import('../src/studio/web/views.js');
  const s = { ...SHOT, episode: null, shotId: 'x' };
  assert.equal(shotRowItems([s])[0].key, 'x');
  assert.equal(shotRowItems([s], { keyPrefix: 'folder:2/candidates/' })[0].key, 'folder:2/candidates/x');
});

test('homeHTML: folders card only when folders exist; shots count excludes folders', () => {
  assert.doesNotMatch(homeHTML(TREE), /folders/);
  const t = { ...TREE, episodes: [{ ...TREE.episodes[0], folders: [{ path: 'c', clips: 9 }] }], folders: [{ path: 'a', clips: 1 }] };
  const h = homeHTML(t);
  assert.match(h, />1<\/div><div class="l">shots/);
  assert.match(h, />2<\/div><div class="l">folders/);
});

test('treeHTML: lists elements by type, episodes with nested shots, marks current', () => {
  const h = treeHTML(TREE, '#/shot/1/ai-1');
  assert.match(h, /href="#\/element\/characters\/mira"/);
  assert.match(h, /href="#\/element\/props\/lamp"/);
  assert.match(h, /href="#\/episode\/1"/);
  assert.match(h, /class="node on" href="#\/shot\/1\/ai-1"/);
  assert.doesNotMatch(h, /All shots/);                  // no flat shots in this tree
});

test('homeHTML: counts', () => {
  const h = homeHTML(TREE);
  assert.match(h, />2<\/div><div class="l">elements/);
  assert.match(h, />1<\/div><div class="l">episodes/);
});

test('shotRowsHTML clips mode: videos, final badge, selection state, escaping', () => {
  const st = empty(); st.selected.add('1/ai-1::v001');
  const h = shotRowsHTML([SHOT], st);
  assert.match(h, /data-row="1\/ai-1"/);
  assert.match(h, /<video src="\/media\/episodes\/1\/shots\/ai-1\/drafts\/v001\/output.mp4"/);
  assert.match(h, /<span class="badge">final<\/span>/);
  assert.match(h, /class="col selected"/);
  assert.match(h, /hello &lt;b&gt;/);
});

test('shotRowsHTML mattes mode: composite placeholder (never the raw alpha), qc thumbs, "no matte"', () => {
  const st = empty(); st.mode = 'mattes'; st.bg = 'green';
  const h = shotRowsHTML([SHOT], st);
  assert.match(h, /<div class="mpv" data-src="episodes\/1\/shots\/ai-1\/drafts\/v002\/alpha.webm" data-bg="green">/);
  assert.doesNotMatch(h, /<video src="[^"]*alpha\./);
  assert.match(h, /<a href="\/media\/[^"]*alpha.webm" download>alpha<\/a>/);
  assert.match(h, /<div class="qc"><img src="\/media\/episodes\/1\/shots\/ai-1\/drafts\/v002\/qc\/f0.png"/);
  assert.match(h, /no matte/);
});

test('shotRowsHTML hidden + onlySelected', () => {
  const st = empty(); st.hidden.add('1/ai-1::v001');
  let h = shotRowsHTML([SHOT], st);
  assert.match(h, /class="hmark" data-key="1\/ai-1" data-v="v001"/);
  assert.match(h, /show 1 hidden/);
  const st2 = empty(); st2.onlySelected = true;
  h = shotRowsHTML([SHOT], st2);
  assert.match(h, /no selected versions/);
});

test('sheetRowsHTML: one row per sheet, images, keyed by type/name/sheet/slug', () => {
  const el = { type: 'characters', name: 'mira', sheets: [
    { sheetType: 'pose', slug: 'wave', versions: [{ version: 'v001', images: ['elements/characters/mira/sheets/pose/wave/v001.png'], upscaled: [], meta: {} }] },
  ] };
  const h = sheetRowsHTML(el, empty());
  assert.match(h, /data-row="characters\/mira\/pose\/wave"/);
  assert.match(h, /<img src="\/media\/elements\/characters\/mira\/sheets\/pose\/wave\/v001.png"/);
  assert.equal(sheetRowsHTML({ ...el, sheets: [] }, empty()).includes('No sheets yet'), true);
});

test('shotRowsHTML escapes quotes/angle brackets in data-key/data-row/data-v attributes', () => {
  const evil = { ...SHOT, shotId: 'a"b<c', episode: '', versions: [{ ...SHOT.versions[0], version: 'v"1<x' }] };
  const html = shotRowsHTML([evil], empty());
  for (const m of html.matchAll(/data-(?:key|row|v)="([^"]*)"/g)) assert.ok(!/[<>]/.test(m[1]), m[0]);
  assert.ok(html.includes('data-row="a&quot;b&lt;c"'));
  assert.ok(html.includes('data-v="v&quot;1&lt;x"'));
  assert.ok(!html.includes('a"b<c'));
});
