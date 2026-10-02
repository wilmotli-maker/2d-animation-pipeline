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

test('shotCharacter: name prefix up to the first number/kind token', async () => {
  const { shotCharacter } = await import('../src/studio/web/views.js');
  const cases = {
    'art-talk-03': 'art', 'ai-alt2-idle': 'ai-alt2', 'ai-alt1-talk-02b': 'ai-alt1', 'ai-talk-01': 'ai',
    'ai-1': 'ai', 'monster-4': 'monster', 'art-idle': 'art', TEST2: null, '01-art-talk': null, art: null,
    'Mira-TALK-1': 'Mira', 'ai-alt-2': 'ai-alt', 'x-y': null,
  };
  for (const [id, want] of Object.entries(cases)) assert.equal(shotCharacter(id), want, id);
});

const FT = {
  project: 'demo',
  elements: [
    { type: 'characters', name: 'Mira', sheets: 1, versions: 1 }, { type: 'characters', name: 'a.b', sheets: 0, versions: 0 },
    { type: 'props', name: 'lamp', sheets: 0, versions: 0 },
  ],
  episodes: [
    { id: '1', shots: [{ shotId: 'art-talk-01', versions: 1 }, { shotId: 'art-idle', versions: 1 }, { shotId: 'ai-1', versions: 2 }],
      folders: [{ path: 'candidates', clips: 4 }] },
    { id: '2', shots: [{ shotId: 'monster-4', versions: 1 }, { shotId: 'a.b-1', versions: 1 }], folders: [] },
  ],
  shots: [{ shotId: 'ai-9', versions: 1 }], folders: [],
};

test('filterTree: regex over shot ids/folder paths; hides empty episodes; matched/total counts', async () => {
  const { filterTree, treeHTML: th } = await import('../src/studio/web/views.js');
  const f = filterTree(FT, { shots: '^ART-' });
  assert.deepEqual(f.episodes.map((e) => e.id), ['1']);
  assert.deepEqual(f.episodes[0].shots.map((s) => s.shotId), ['art-talk-01', 'art-idle']);
  assert.deepEqual(f.episodes[0].folders, []);
  assert.equal(f.episodes[0].totalShots, 3);
  assert.deepEqual(f.shots, []);
  assert.deepEqual(f.filter.shots, { active: true, invalid: false, matched: 2, total: 6 });
  assert.equal(f.elements.length, 3);                               // other box untouched
  assert.equal(f.filter.elements.active, false);
  const h = th(f, '#/');
  assert.match(h, /Episode 1<\/span><span class="meta">2\/3</);
  assert.doesNotMatch(h, /Episode 2/);
  // A folder match alone keeps its episode visible.
  const g = filterTree(FT, { shots: 'cand' });
  assert.deepEqual(g.episodes.map((e) => [e.id, e.shots.length, e.folders.length]), [['1', 0, 1]]);
  // Empty box = no filtering, no counts in meta.
  const n = filterTree(FT, { shots: '', elements: '' });
  assert.equal(n.episodes.length, 2);
  assert.equal(n.episodes[0].totalShots, undefined);
  assert.equal(n.filter.shots.active, false);
  assert.match(th(n, '#/'), /Episode 1<\/span><span class="meta">3</);
});

test('filterTree: invalid regex falls back to case-insensitive substring and flags it', async () => {
  const { filterTree } = await import('../src/studio/web/views.js');
  const f = filterTree(FT, { shots: 'A.B-(', elements: '[' });
  assert.equal(f.filter.shots.invalid, true);
  assert.deepEqual(f.episodes.flatMap((e) => e.shots.map((s) => s.shotId)), []);   // literal "a.b-(" matches nothing
  const g = filterTree(FT, { shots: 'A.B-1(' });
  assert.equal(g.filter.shots.invalid, true);
  const h = filterTree(FT, { shots: 'A.B-1[' });
  assert.equal(h.filter.shots.invalid, true);
  assert.equal(filterTree(FT, { shots: 'a.b-1' }).filter.shots.invalid, false);
  const sub = filterTree({ ...FT, episodes: [{ id: '1', shots: [{ shotId: 'x(1', versions: 1 }], folders: [] }] }, { shots: 'X(' });
  assert.deepEqual(sub.episodes[0].shots.map((s) => s.shotId), ['x(1']);
  assert.equal(f.filter.elements.invalid, true);
  assert.equal(f.elements.length, 0);
});

test('filterTree: elements by name; type groups with no matches disappear', async () => {
  const { filterTree, treeHTML: th } = await import('../src/studio/web/views.js');
  const f = filterTree(FT, { elements: 'mira' });
  assert.deepEqual(f.elements.map((e) => e.name), ['Mira']);
  assert.deepEqual(f.filter.elements, { active: true, invalid: false, matched: 1, total: 3 });
  const h = th(f, '#/');
  assert.match(h, /<div class="grp">characters<\/div>/);
  assert.doesNotMatch(h, /<div class="grp">props<\/div>/);
  assert.match(th(filterTree(FT, { elements: 'zzz' }), '#/'), /no matches/);
  assert.match(th(filterTree(FT, { shots: 'zzz' }), '#/'), /no matches/);
});

test('filterSuggestions: characters with escaped regex values; elements sorted case-insensitively', async () => {
  const { filterSuggestions, filterTree } = await import('../src/studio/web/views.js');
  const s = filterSuggestions(FT);
  assert.deepEqual(s.shots, [
    { value: '^a\\.b-', label: 'a.b (1 shots)' },
    { value: '^ai-', label: 'ai (2 shots)' },
    { value: '^art-', label: 'art (2 shots)' },
    { value: '^monster-', label: 'monster (1 shots)' },
  ]);
  assert.deepEqual(s.elements, [
    { value: '^a\\.b$', label: 'a.b (characters)' },
    { value: '^lamp$', label: 'lamp (props)' },
    { value: '^Mira$', label: 'Mira (characters)' },
  ]);
  // A suggestion, used as the filter, selects exactly that character.
  const f = filterTree(FT, { shots: s.shots[0].value });
  assert.deepEqual(f.episodes.flatMap((e) => e.shots.map((x) => x.shotId)), ['a.b-1']);
});

test('railShellHTML: stable filter inputs + datalists, persisted values escaped', async () => {
  const { railShellHTML, filterSuggestions } = await import('../src/studio/web/views.js');
  const h = railShellHTML(FT, filterSuggestions(FT), { shots: '^a"<', elements: '' });
  assert.match(h, /<input type="search" class="filter" data-filter="shots" list="sug-shots" placeholder="filter — character or regex" value="\^a&quot;&lt;"/);
  assert.match(h, /<datalist id="sug-shots"><option value="\^a\\\.b-" label="a\.b \(1 shots\)">/);
  assert.match(h, /data-filter="elements" list="sug-elements"/);
  assert.match(h, /<h3>Episodes<\/h3>/);
  assert.match(h, /id="rail-proj"/);
  assert.match(h, /id="rail-elements"/);
  assert.match(h, /id="rail-shots"/);
  // No episodes/flat shots at all -> no shots filter.
  const bare = railShellHTML({ ...FT, episodes: [], shots: [], folders: [] }, filterSuggestions(FT), {});
  assert.doesNotMatch(bare, /data-filter="shots"/);
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
