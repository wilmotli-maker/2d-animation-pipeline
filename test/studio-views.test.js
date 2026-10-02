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
  assert.match(h, /class="node folder on" href="#\/folder\/2\/candidates\/blue%20matte"><span title="candidates\/blue matte">candidates\/blue matte<\/span><span class="meta">3 clips<\/span>/);
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
  assert.equal(f.episodes[0].totalItems, 4);                        // 3 shots + 1 folder
  assert.deepEqual(f.shots, []);
  // Counts are shots + folders (FT: 6 shots + 1 folder).
  assert.deepEqual(f.filter.shots, { active: true, invalid: false, matched: 2, total: 7, unit: 'shots & folders' });
  assert.equal(f.elements.length, 3);                               // other box untouched
  assert.equal(f.filter.elements.active, false);
  const h = th(f, '#/');
  assert.match(h, /Episode 1<\/span><span class="meta">2\/4</);
  assert.doesNotMatch(h, /Episode 2/);
  // A folder match alone keeps its episode visible, and counts it.
  const g = filterTree(FT, { shots: 'cand' });
  assert.deepEqual(g.episodes.map((e) => [e.id, e.shots.length, e.folders.length]), [['1', 0, 1]]);
  assert.match(th(g, '#/'), /Episode 1<\/span><span class="meta">1\/4</);
  assert.equal(g.filter.shots.matched, 1);
  // Without folders anywhere, the unit is just shots.
  const nf = filterTree({ ...FT, episodes: FT.episodes.map((e) => ({ ...e, folders: [] })) }, { shots: 'art' });
  assert.deepEqual(nf.filter.shots, { active: true, invalid: false, matched: 2, total: 6, unit: 'shots' });
  // Empty box = no filtering, no counts in meta.
  const n = filterTree(FT, { shots: '', elements: '' });
  assert.equal(n.episodes.length, 2);
  assert.equal(n.episodes[0].totalItems, undefined);
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
  assert.deepEqual(f.filter.elements, { active: true, invalid: false, matched: 1, total: 3, unit: 'elements' });
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
    { value: '^a\\.b-', label: 'a.b', meta: '1 shot' },
    { value: '^ai-', label: 'ai', meta: '2 shots' },
    { value: '^art-', label: 'art', meta: '2 shots' },
    { value: '^monster-', label: 'monster', meta: '1 shot' },
  ]);
  assert.deepEqual(s.elements, [
    { value: '^a\\.b$', label: 'a.b', meta: 'characters' },
    { value: '^lamp$', label: 'lamp', meta: 'props' },
    { value: '^Mira$', label: 'Mira', meta: 'characters' },
  ]);
  // A suggestion, used as the filter, selects exactly that character.
  const f = filterTree(FT, { shots: s.shots[0].value });
  assert.deepEqual(f.episodes.flatMap((e) => e.shots.map((x) => x.shotId)), ['a.b-1']);
});

// Shaped like ArtAI: "ai" is extended by "ai-alt1"/"ai-alt2".
const AI = {
  project: 'artai', elements: [], folders: [],
  episodes: [
    { id: '1', folders: [], shots: ['ai-1', 'ai-talk-01', 'ai-talk-02', 'ai-alt1-talk-01', 'ai-alt1-talk-02b', 'ai-alt2-idle',
      'ai-alt2-talk-01', 'art-talk-03', 'art-idle'].map((shotId) => ({ shotId, versions: 1 })) },
    { id: '2', folders: [{ path: 'candidates', clips: 5 }, { path: 'ai-candidates', clips: 2 }], shots: ['ai-2', 'ai-3', 'ai-alt2-talk-02', 'monster-4']
      .map((shotId) => ({ shotId, versions: 1 })) },
  ],
  shots: [{ shotId: 'ai-react-1', versions: 1 }],
};
const matchedIds = (filterTree, tree, re) => {
  const f = filterTree(tree, { shots: re });
  return [...f.episodes.flatMap((e) => e.shots), ...f.shots].map((s) => s.shotId);
};

test('filterSuggestions: a character extended by longer ones excludes them via negative lookahead', async () => {
  const { filterSuggestions, filterTree } = await import('../src/studio/web/views.js');
  const s = filterSuggestions(AI).shots;
  const ai = s.find((x) => x.label === 'ai');
  assert.equal(ai.value, '^ai-(?!alt1(?:-|$)|alt2(?:-|$))');
  assert.equal(ai.meta, '6 shots, 1 folder');   // ^ai- also matches the ai-candidates folder
  assert.deepEqual(matchedIds(filterTree, AI, ai.value), ['ai-1', 'ai-talk-01', 'ai-talk-02', 'ai-2', 'ai-3', 'ai-react-1']);
  assert.equal(s.find((x) => x.label === 'ai-alt1').value, '^ai-alt1-');
  assert.equal(s.find((x) => x.label === 'art').value, '^art-');
  // Every meta count equals what its value actually matches across the tree.
  for (const sug of s) {
    const [, n, m = 0] = /^(\d+) shots?(?:, (\d+) folders?)?$/.exec(sug.meta);
    const f = filterTree(AI, { shots: sug.value });
    assert.equal(matchedIds(filterTree, AI, sug.value).length, Number(n), sug.label);
    assert.equal(f.episodes.reduce((a, e) => a + e.folders.length, 0) + f.folders.length, Number(m), sug.label);
  }
});

test('filterSuggestions: label pluralizes and counts matching folders', async () => {
  const { filterSuggestions } = await import('../src/studio/web/views.js');
  const t = { project: 'p', elements: [], episodes: [], folders: [{ path: 'zed-stuff', clips: 1 }, { path: 'zed-more', clips: 1 }],
    shots: ['zed-1', 'solo-1', 'solo-2'].map((shotId) => ({ shotId, versions: 1 })) };
  const s = filterSuggestions(t).shots;
  assert.equal(s.find((x) => x.value === '^zed-').meta, '1 shot, 2 folders');
  assert.equal(s.find((x) => x.value === '^solo-').meta, '2 shots');
  const one = { ...t, folders: [{ path: 'solo-x', clips: 1 }] };
  assert.equal(filterSuggestions(one).shots.find((x) => x.value === '^solo-').meta, '2 shots, 1 folder');
});

test('filterSuggestions: characters are case-insensitive (one suggestion, lowercase, lookahead covers other cases)', async () => {
  const { filterSuggestions, filterTree } = await import('../src/studio/web/views.js');
  const t = { project: 'p', elements: [], folders: [], episodes: [{ id: '1', folders: [], shots:
    ['AI-03', 'ai-03', 'ai-1', 'AI-ALT1-talk-01', 'Ai-Alt1-idle'].map((shotId) => ({ shotId, versions: 1 })) }], shots: [] };
  const s = filterSuggestions(t).shots;
  assert.deepEqual(s.map((x) => [x.label, x.meta]), [['ai', '3 shots'], ['ai-alt1', '2 shots']]);
  assert.equal(s[0].value, '^ai-(?!alt1(?:-|$))');
  assert.deepEqual(matchedIds(filterTree, t, s[0].value), ['AI-03', 'ai-03', 'ai-1']);
  assert.deepEqual(matchedIds(filterTree, t, s[1].value), ['AI-ALT1-talk-01', 'Ai-Alt1-idle']);
});

test('filterSuggestions: regex metachars in characters and their extensions are escaped', async () => {
  const { filterSuggestions, filterTree } = await import('../src/studio/web/views.js');
  const t = { project: 'p', elements: [], folders: [], episodes: [{ id: '1', folders: [], shots:
    ['a.b-1', 'a.b-c+d-2', 'axb-1', 'a.b-c+d-talk'].map((shotId) => ({ shotId, versions: 1 })) }], shots: [] };
  const s = filterSuggestions(t).shots;
  const ab = s.find((x) => x.label === 'a.b');
  assert.equal(ab.value, '^a\\.b-(?!c\\+d(?:-|$))');
  assert.deepEqual(matchedIds(filterTree, t, ab.value), ['a.b-1']);
  assert.equal(ab.meta, '1 shot');
  const abcd = s.find((x) => x.label === 'a.b-c+d');
  assert.equal(abcd.value, '^a\\.b-c\\+d-');
  assert.deepEqual(matchedIds(filterTree, t, abcd.value), ['a.b-c+d-2', 'a.b-c+d-talk']);
  for (const sug of s) assert.equal(matchedIds(filterTree, t, sug.value).length, Number(/^(\d+) shots?$/.exec(sug.meta)[1]));
});

test('matchSuggestions: case-insensitive substring on the name only (never the regex)', async () => {
  const { matchSuggestions, filterSuggestions } = await import('../src/studio/web/views.js');
  const s = filterSuggestions(AI).shots;
  assert.deepEqual(matchSuggestions(s, 'ALT').map((x) => x.label), ['ai-alt1', 'ai-alt2']);
  assert.deepEqual(matchSuggestions(s, 'R').map((x) => x.label), ['art', 'monster']);
  assert.equal(matchSuggestions(s, '').length, s.length);
  assert.equal(matchSuggestions(s, undefined).length, s.length);
  assert.deepEqual(matchSuggestions(s, '^ai-'), []);   // a regex typed in the box matches no name
  assert.deepEqual(matchSuggestions(s, 'shots'), []);  // meta text is not searched
});

test('suggestionListHTML: options show name + dim meta, escaped; active option; never the regex', async () => {
  const { suggestionListHTML, filterSuggestions } = await import('../src/studio/web/views.js');
  const s = filterSuggestions(AI).shots;
  const h = suggestionListHTML(s, { activeIndex: 1, idPrefix: 'sug-shots' });
  assert.match(h, /^<li role="option" id="sug-shots-0" data-i="0" aria-selected="false"><span class="sl">ai<\/span><span class="sm">6 shots, 1 folder<\/span><\/li>/);
  assert.match(h, /<li role="option" id="sug-shots-1" data-i="1" class="on" aria-selected="true"><span class="sl">ai-alt1<\/span>/);
  for (const sug of s) assert.ok(!h.includes(sug.value), sug.value);
  assert.doesNotMatch(h, /\(\?!|\^/);
  // The query narrows the list; data-i indexes the narrowed list.
  const q = suggestionListHTML(s, { query: 'alt2', idPrefix: 'x' });
  assert.equal((q.match(/<li /g) || []).length, 1);
  assert.match(q, /id="x-0" data-i="0" aria-selected="false"><span class="sl">ai-alt2</);
  assert.equal(suggestionListHTML(s, { query: 'zzz' }), '');
  const evil = suggestionListHTML([{ label: '<b>"', meta: '&', value: 'v' }], { idPrefix: 'a"b' });
  assert.equal(evil, '<li role="option" id="a&quot;b-0" data-i="0" aria-selected="false"><span class="sl">&lt;b&gt;&quot;</span><span class="sm">&amp;</span></li>');
  assert.doesNotMatch(suggestionListHTML([{ label: 'x', value: 'v' }]), /class="sm"/);
});

test('parseStoredFilter: JSON state, legacy plain strings, junk', async () => {
  const { parseStoredFilter } = await import('../src/studio/web/views.js');
  assert.deepEqual(parseStoredFilter(null), { text: '', chip: null });
  assert.deepEqual(parseStoredFilter(''), { text: '', chip: null });
  assert.deepEqual(parseStoredFilter('^art-'), { text: '^art-', chip: null });   // legacy plain string
  assert.deepEqual(parseStoredFilter('123'), { text: '123', chip: null });       // valid JSON, but not a state
  assert.deepEqual(parseStoredFilter('"ai"'), { text: '"ai"', chip: null });
  assert.deepEqual(parseStoredFilter('null'), { text: 'null', chip: null });
  const st = { text: '^ai-', chip: { label: 'ai', value: '^ai-' } };
  assert.deepEqual(parseStoredFilter(JSON.stringify(st)), st);
  assert.deepEqual(parseStoredFilter(JSON.stringify({ text: 'x', chip: { label: 1 } })), { text: 'x', chip: null });
  assert.deepEqual(parseStoredFilter(JSON.stringify({ text: 'x' })), { text: 'x', chip: null });
});

test('reconcileChip: keeps a chip only while it still labels the text', async () => {
  const { reconcileChip } = await import('../src/studio/web/views.js');
  const sugs = [{ label: 'ai', value: '^ai-', meta: '' }];
  const f = { text: '^ai-', chip: { label: 'ai', value: '^ai-' } };
  assert.equal(reconcileChip(f, sugs), f);                                          // label exists, value == text
  assert.deepEqual(reconcileChip({ ...f, chip: { label: 'gone', value: '^ai-' } }, sugs), { text: '^ai-', chip: null });
  assert.deepEqual(reconcileChip({ ...f, text: '^ai-x' }, sugs), { text: '^ai-x', chip: null });
  assert.deepEqual(reconcileChip({ text: 'a', chip: null }, sugs), { text: 'a', chip: null });
  // Same label, but the suggestion's value changed (e.g. Rescan added ai-alt3): stale chip dropped, text kept.
  const changed = [{ label: 'ai', value: '^ai-(?!alt1(?:-|$))(?!alt3(?:-|$))', meta: '' }];
  assert.deepEqual(reconcileChip(f, changed), { text: '^ai-', chip: null });
});

test('filterCountText: count line unit follows the tree', async () => {
  const { filterTree, filterCountText } = await import('../src/studio/web/views.js');
  assert.equal(filterCountText(filterTree(FT, { shots: 'art' }).filter.shots), '2 of 7 shots & folders');
  assert.equal(filterCountText(filterTree(FT, { elements: 'mira' }).filter.elements), '1 of 3 elements');
  assert.equal(filterCountText(filterTree(FT, {}).filter.shots), '');
});

test('railShellHTML: stable combobox filter boxes (no datalist), chip on the left, persisted values escaped', async () => {
  const { railShellHTML } = await import('../src/studio/web/views.js');
  const h = railShellHTML(FT, { shots: { text: '^a"<', chip: { label: 'a<"', value: '^a"<' } }, elements: { text: '', chip: null } });
  assert.doesNotMatch(h, /datalist|list="/);
  assert.match(h, /<div class="ffield" data-field="shots"><span class="chip" title="a&lt;&quot;">a&lt;&quot;<\/span><input type="text" class="filter" data-filter="shots" role="combobox" aria-expanded="false" aria-controls="sug-shots" aria-autocomplete="list" placeholder="filter — character or regex" value="\^a&quot;&lt;"/);
  assert.match(h, /<button type="button" class="fclear" data-clear="shots" title="Clear filter" aria-label="Clear filter">×<\/button><ul class="sug" id="sug-shots" role="listbox" hidden><\/ul>/);
  // Empty box: no chip, clear button hidden.
  assert.match(h, /<div class="ffield" data-field="elements"><input [^>]*data-filter="elements"[^>]*value=""[^>]*>/);
  assert.match(h, /data-clear="elements" [^>]*hidden>×/);
  // Text without a chip still shows the clear button.
  assert.doesNotMatch(railShellHTML(FT, { elements: { text: 'x', chip: null } }), /data-clear="elements" [^>]*hidden/);
  assert.match(h, /<h3>Episodes<\/h3>/);
  assert.match(h, /id="rail-proj"/);
  assert.match(h, /id="rail-elements"/);
  assert.match(h, /id="rail-shots"/);
  // No episodes/flat shots at all -> no shots filter.
  const bare = railShellHTML({ ...FT, episodes: [], shots: [], folders: [] }, {});
  assert.doesNotMatch(bare, /data-filter="shots"/);
});

const ROWS = ['ai-1', 'ai-alt1-talk-01', 'AI-03', 'art-idle', 'x(1'].map((id) => ({ key: `1/${id}`, title: id, kind: 'shot' }));
const titles = (rows) => rows.map((r) => r.title);

test('filterRowItems: episode rows by shot id with the rail matcher; no filter = all rows', async () => {
  const { filterRowItems, makeMatcher, filterSuggestions } = await import('../src/studio/web/views.js');
  assert.equal(filterRowItems(ROWS, null), ROWS);
  assert.equal(filterRowItems(ROWS, makeMatcher('  ')), ROWS);              // blank box = no matcher
  assert.deepEqual(titles(filterRowItems(ROWS, makeMatcher('^art-'))), ['art-idle']);
  // A character suggestion's regex selects the same rows in the grid as in the rail (case-insensitive).
  const ai = filterSuggestions(AI).shots.find((s) => s.label === 'ai');
  assert.deepEqual(titles(filterRowItems(ROWS, makeMatcher(ai.value))), ['ai-1', 'AI-03']);
  assert.deepEqual(filterRowItems(ROWS, makeMatcher('zzz')), []);
});

test('filterRowItems: invalid regex falls back to case-insensitive substring', async () => {
  const { filterRowItems, makeMatcher } = await import('../src/studio/web/views.js');
  const m = makeMatcher('X(');
  assert.equal(m.invalid, true);
  assert.deepEqual(titles(filterRowItems(ROWS, m)), ['x(1']);
});

test('filterRowItems: folder view shows all rows when the folder path matches, else rows by inferred shot id', async () => {
  const { filterRowItems, makeMatcher } = await import('../src/studio/web/views.js');
  assert.equal(filterRowItems(ROWS, makeMatcher('^ai-'), { folderPath: 'ai-candidates' }), ROWS);
  assert.equal(filterRowItems(ROWS, makeMatcher('cand'), { folderPath: 'x/candidates' }), ROWS);
  assert.deepEqual(titles(filterRowItems(ROWS, makeMatcher('^art-'), { folderPath: 'candidates' })), ['art-idle']);
});

test('gridFilterBannerHTML: shown only when rows are hidden; label escaped; clear button', async () => {
  const { gridFilterBannerHTML } = await import('../src/studio/web/views.js');
  assert.equal(gridFilterBannerHTML({ label: 'ai', shown: 5, total: 5 }), '');
  assert.equal(gridFilterBannerHTML({ label: 'ai', shown: 0, total: 0 }), '');
  assert.equal(gridFilterBannerHTML({ label: 'ai', shown: 8, total: 25 }),
    '<p class="fbanner">Filtered by “ai”: 8 of 25 shots · <button class="clearf">clear filter</button></p>');
  assert.equal(gridFilterBannerHTML({ label: '<b>', shown: 0, total: 3 }),
    '<p class="fbanner">No shots match “&lt;b&gt;” in this view · <button class="clearf">clear filter</button></p>');
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
