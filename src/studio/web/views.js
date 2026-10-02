// src/studio/web/views.js
// Pure HTML builders for the studio. No DOM access, so node:test can import
// them. Markup mirrors src/review-render.js so the shared /review.css applies.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function mediaUrl(rel) {
  return rel ? '/media/' + rel.split('/').map(encodeURIComponent).join('/') : null;
}

const enc = encodeURIComponent;

// Must match PREVIEW_BGS keys in src/studio/matte-preview.js (the server 400s otherwise).
export const MATTE_BGS = ['checker', 'white', 'black', 'gray', 'green'];

export function parseRoute(hash) {
  let parts;
  try { parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent); }
  catch { return { view: 'home' }; }   // malformed %-escape, e.g. #/shot/%E0
  if (parts[0] === 'element' && parts.length === 3) return { view: 'element', type: parts[1], name: parts[2] };
  if (parts[0] === 'episode' && parts.length === 2) return { view: 'episode', episode: parts[1] };
  if (parts[0] === 'shot' && parts.length === 3) return { view: 'shot', episode: parts[1], shotId: parts[2] };
  if (parts[0] === 'folder' && parts.length >= 3) return { view: 'folder', episode: parts[1], path: parts.slice(2).join('/') };
  return { view: 'home' };
}

export function folderHref(epToken, relPath) {
  return `#/folder/${enc(epToken)}/${relPath.split('/').map(enc).join('/')}`;
}

function node(href, label, meta, current, cls = '') {
  return `<a class="node${cls ? ` ${cls}` : ''}${href === current ? ' on' : ''}" href="${esc(href)}"><span title="${esc(label)}">${esc(label)}</span>`
    + (meta ? `<span class="meta">${esc(meta)}</span>` : '') + '</a>';
}

function shotNodes(epToken, shots, folders, current) {
  if (!shots.length && !folders.length) return '<div class="empty">no shots yet</div>';
  return '<div class="nested">' + shots.map((s) =>
    node(`#/shot/${enc(epToken)}/${enc(s.shotId)}`, s.shotId,
      `${s.versions}v${s.promotedVersion ? ' ★' : ''}`, current)).join('')
    + folders.map((f) => node(folderHref(epToken, f.path), f.path, `${f.clips} clips`, current, 'folder')).join('')
    + '</div>';
}

// ---- rail filtering -------------------------------------------------------

// A shot's "character" is its name prefix: leading '-' tokens up to the first
// number-ish token (03, 02b) or kind word (talk, idle, …). null when there is no
// such prefix (starts with a stop token) or the prefix would be the whole name.
const KIND_WORDS = new Set(['talk', 'idle', 'walk', 'run', 'react', 'reaction', 'listen', 'wave',
  'intro', 'outro', 'scene', 'sc', 'shot', 'cut', 'take']);
export function shotCharacter(shotId) {
  const tokens = String(shotId ?? '').split('-');
  const i = tokens.findIndex((t) => /^\d+[a-z]?$/i.test(t) || KIND_WORDS.has(t.toLowerCase()));
  if (i <= 0) return null;   // -1: no stop token (prefix = whole name); 0: nothing before it
  return tokens.slice(0, i).join('-');
}

export function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Case-insensitive regex; an invalid one falls back to substring match (flagged).
// null for an empty box. Shared by the rail (filterTree) and the review grid.
export function makeMatcher(text) {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  try {
    const re = new RegExp(t, 'i');
    return { invalid: false, test: (s) => re.test(s) };
  } catch {
    const lower = t.toLowerCase();
    return { invalid: true, test: (s) => String(s).toLowerCase().includes(lower) };
  }
}

const allShots = (tree) => [...tree.episodes.flatMap((e) => e.shots), ...tree.shots];

const allFolders = (tree) => [...(tree.folders || []), ...tree.episodes.flatMap((e) => e.folders || [])];
const nFolders = (tree) => (tree.folders || []).length + tree.episodes.reduce((a, e) => a + (e.folders || []).length, 0);
const nItems = (tree) => allShots(tree).length + nFolders(tree);

// Same tree shape, narrowed to what the rail boxes match. Episodes with no
// matching shot/folder are dropped; while filtering, episodes and the flat section
// carry `totalItems` (shots + folders) for a matched/total meta. `filter` holds
// per-box state for the count line and the invalid-regex flag.
export function filterTree(tree, { shots: shotText = '', elements: elText = '' } = {}) {
  const sm = makeMatcher(shotText), em = makeMatcher(elText);
  const out = { ...tree, folders: tree.folders || [], shotsHeading: shotsHeading(tree) };
  if (sm) {
    out.episodes = tree.episodes.map((ep) => ({ ...ep,
      shots: ep.shots.filter((s) => sm.test(s.shotId)),
      folders: (ep.folders || []).filter((f) => sm.test(f.path)),
      totalItems: ep.shots.length + (ep.folders || []).length,
    })).filter((ep) => ep.shots.length || ep.folders.length);
    out.shots = tree.shots.filter((s) => sm.test(s.shotId));
    out.folders = out.folders.filter((f) => sm.test(f.path));
    out.totalItems = tree.shots.length + (tree.folders || []).length;
  }
  if (em) out.elements = tree.elements.filter((e) => em.test(e.name));
  out.filter = {
    shots: { active: !!sm, invalid: !!sm?.invalid, matched: nItems(out), total: nItems(tree),
      unit: nFolders(tree) ? 'shots & folders' : 'shots' },
    elements: { active: !!em, invalid: !!em?.invalid, matched: out.elements.length, total: tree.elements.length,
      unit: 'elements' },
  };
  return out;
}

// The review grid's rows under the shots filter (multi-shot views only; app.js decides
// which views). A folder whose own path matches keeps all its rows, as in the rail;
// otherwise rows match by shot id (the inferred one, in a folder). null matcher = all.
export function filterRowItems(items, matcher, { folderPath = null } = {}) {
  if (!matcher || (folderPath != null && matcher.test(folderPath))) return items;
  return items.filter((it) => matcher.test(it.title));
}

// One line above a filtered grid; '' when nothing is hidden.
// `unit` is what the rows are: 'shots', or 'clip groups' in folder views.
export function gridFilterBannerHTML({ label, shown, total, unit = 'shots' }) {
  if (shown === total) return '';
  const clear = '<button class="clearf">clear filter</button>';
  return shown
    ? `<p class="fbanner">Filtered by “${esc(label)}”: ${shown} of ${total} ${unit} · ${clear}</p>`
    : `<p class="fbanner">No ${unit} match “${esc(label)}” in this view · ${clear}</p>`;
}

// The line under a filter box ("3 of 25 shots & folders"); '' when the box is empty.
export function filterCountText(f) {
  return f && f.active ? `${f.matched} of ${f.total} ${f.unit}` : '';
}

// Regex selecting exactly character `c`: other characters that extend it with '-'
// (ai -> ai-alt1, ai-alt2) are excluded by a negative lookahead on their remainders.
function characterRegex(c, all) {
  const rest = [...new Set(all.filter((d) => d.startsWith(`${c}-`)).map((d) => d.slice(c.length + 1)))].sort();
  const ahead = rest.length ? `(?!${rest.map((r) => `${escapeRegex(r)}(?:-|$)`).join('|')})` : '';
  return `^${escapeRegex(c)}-${ahead}`;
}

// Each suggestion: `label` (character/element name, shown and used as the chip),
// `meta` (dim count/type, shown) and `value` (the regex applied; never shown in the list).
export function filterSuggestions(tree) {
  const shots = allShots(tree);
  // Lowercased: filters match case-insensitively, so AI-03 and ai-03 are one character.
  const chars = [...new Set(shots.map((s) => shotCharacter(s.shotId)).filter(Boolean).map((c) => c.toLowerCase()))];
  const names = new Map();
  for (const e of tree.elements) names.set(e.name, [...(names.get(e.name) || []), e.type]);
  const ci = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  return {
    // The meta counts are what the value actually matches (shots and folders, same 'i' flag as filterTree).
    shots: chars.sort(ci).map((c) => {
      const value = characterRegex(c, chars);
      const re = new RegExp(value, 'i');
      const nS = shots.filter((s) => re.test(s.shotId)).length;
      const nF = allFolders(tree).filter((f) => re.test(f.path)).length;
      const part = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
      return { value, label: c, meta: `${part(nS, 'shot')}${nF ? `, ${part(nF, 'folder')}` : ''}` };
    }),
    elements: [...names.keys()].sort(ci)
      .map((n) => ({ value: `^${escapeRegex(n)}$`, label: n, meta: [...new Set(names.get(n))].join(', ') })),
  };
}

// Suggestions whose name contains `query` (case-insensitive substring); all of them for an empty query.
export function matchSuggestions(items, query = '') {
  const q = String(query ?? '').toLowerCase();
  return q ? items.filter((s) => s.label.toLowerCase().includes(q)) : items;
}

// The dropdown's options: name + dim meta only (never the regex). data-i indexes into
// matchSuggestions(items, query) — the same list app.js picks from; ids are `${idPrefix}-${i}`.
export function suggestionListHTML(items, { query = '', activeIndex = -1, idPrefix = 'sug' } = {}) {
  return matchSuggestions(items, query).map((s, i) => `<li role="option" id="${esc(idPrefix)}-${i}" data-i="${i}"`
    + (i === activeIndex ? ' class="on" aria-selected="true"' : ' aria-selected="false"')
    + `><span class="sl">${esc(s.label)}</span>${s.meta ? `<span class="sm">${esc(s.meta)}</span>` : ''}</li>`).join('');
}

// A filter box's persisted state, from localStorage: JSON `{ text, chip }`, or an
// older plain-string value (the text alone). Anything unparseable is plain text.
export function parseStoredFilter(raw) {
  if (raw == null || raw === '') return { text: '', chip: null };
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && typeof o.text === 'string') {
      const c = o.chip;
      const chip = c && typeof c.label === 'string' && typeof c.value === 'string' ? { label: c.label, value: c.value } : null;
      return { text: o.text, chip };
    }
  } catch {}
  return { text: String(raw), chip: null };
}

// Drop a chip that no longer labels its text: its name is gone from the current
// suggestions, its value differs from the current suggestion's (a Rescan changed the
// regex), or the text is no longer exactly its value. The text is kept.
export function reconcileChip(f, suggestions) {
  const ok = f.chip && f.chip.value === f.text
    && suggestions.some((s) => s.label === f.chip.label && s.value === f.chip.value);
  return ok ? f : { text: f.text, chip: null };
}

export function chipHTML(chip) {
  return chip ? `<span class="chip" title="${esc(chip.label)}">${esc(chip.label)}</span>` : '';
}

// The rail's first shots heading: Episodes when any exist, else the flat Shots section.
export function shotsHeading(tree) {
  if (tree.episodes.length) return 'Episodes';
  return tree.shots.length || (tree.folders || []).length ? 'Shots' : null;
}

export function projectNodeHTML(tree, current) {
  return node('#/', tree.project, '', current).replace('class="node', 'class="node proj');
}

export function elementsListHTML(tree, current) {
  if (!tree.elements.length) return `<div class="empty">${tree.filter?.elements.active ? 'no matches' : 'none yet'}</div>`;
  let h = '', lastType = null;
  for (const e of tree.elements) {
    if (e.type !== lastType) { h += `<div class="grp">${esc(e.type)}</div>`; lastType = e.type; }
    h += node(`#/element/${enc(e.type)}/${enc(e.name)}`, e.name, e.sheets ? `${e.sheets} sh` : '—', current);
  }
  return h;
}

// Everything under the shots heading: episodes, then the flat section (with its
// own "Shots" heading only when it follows episodes).
export function shotsListHTML(tree, current) {
  const heading = tree.shotsHeading !== undefined ? tree.shotsHeading : shotsHeading(tree);
  const flatFolders = tree.folders || [];
  const count = (shown, total) => (total != null ? `${shown}/${total}` : `${shown}`);
  let h = '';
  for (const ep of tree.episodes) {
    h += node(`#/episode/${enc(ep.id)}`, `Episode ${ep.id}`,
      ep.totalItems != null ? count(ep.shots.length + ep.folders.length, ep.totalItems) : count(ep.shots.length), current);
    h += shotNodes(ep.id, ep.shots, ep.folders || [], current);
  }
  if (tree.shots.length || flatFolders.length) {
    if (heading === 'Episodes') h += '<h3>Shots</h3>';
    if (tree.shots.length) {
      h += node('#/episode/_', 'All shots', tree.totalItems != null
        ? count(tree.shots.length + flatFolders.length, tree.totalItems) : count(tree.shots.length), current);
    }
    h += shotNodes('_', tree.shots, flatFolders, current);
  }
  return h || (tree.filter?.shots.active ? '<div class="empty">no matches</div>' : '');
}

// One filter box: [chip] input [×] in a bordered field, with a combobox dropdown
// (app.js fills and shows the <ul>). `f` is `{ text, chip }`.
const FILTER_LABEL = { elements: 'Filter elements', shots: 'Filter shots and folders' };
function filterBox(kind, f) {
  const text = f?.text || '', chip = f?.chip || null;
  return `<div class="fbox"><div class="ffield" data-field="${kind}">${chipHTML(chip)}`
    + `<input type="text" class="filter" data-filter="${kind}" role="combobox" aria-expanded="false"`
    + ` aria-controls="sug-${kind}" aria-autocomplete="list" aria-label="${FILTER_LABEL[kind]}" placeholder="filter — character or regex"`
    + ` value="${esc(text)}" autocomplete="off" spellcheck="false">`
    + `<button type="button" class="fclear" data-clear="${kind}" title="Clear filter" aria-label="Clear filter"`
    + `${text || chip ? '' : ' hidden'}>×</button>`
    + `<ul class="sug" id="sug-${kind}" role="listbox" hidden></ul></div>`
    + `<div class="fcount" data-count="${kind}"></div></div>`;
}

// Static rail skeleton, rendered once per boot/rescan so the filter inputs (and
// their focus/caret) survive route changes; app.js fills the list containers.
// `values[kind]` is the box state `{ text, chip }`; suggestions are kept by app.js.
export function railShellHTML(tree, values = {}) {
  const heading = shotsHeading(tree);
  return '<div id="rail-proj"></div><h3>Elements</h3>' + filterBox('elements', values.elements)
    + '<div class="rlist" id="rail-elements"></div>'
    + (heading ? `<h3>${heading}</h3>` + filterBox('shots', values.shots)
      + '<div class="rlist" id="rail-shots"></div>' : '');
}

export function treeHTML(tree, current) {
  const heading = tree.shotsHeading !== undefined ? tree.shotsHeading : shotsHeading(tree);
  return projectNodeHTML(tree, current) + '<h3>Elements</h3>' + elementsListHTML(tree, current)
    + (heading ? `<h3>${heading}</h3>` + shotsListHTML(tree, current) : '');
}

export function homeHTML(tree) {
  const nShots = tree.shots.length + tree.episodes.reduce((a, e) => a + e.shots.length, 0);
  const nMattes = [...tree.shots, ...tree.episodes.flatMap((e) => e.shots)].reduce((a, s) => a + s.mattes, 0);
  const nFolders = (tree.folders || []).length + tree.episodes.reduce((a, e) => a + (e.folders || []).length, 0);
  const card = (n, l) => `<div class="card"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;
  return '<div class="cards">' + card(tree.elements.length, 'elements') + card(tree.episodes.length, 'episodes')
    + card(nShots, 'shots') + card(nMattes, 'mattes') + (nFolders ? card(nFolders, 'folders') : '') + '</div>';
}

function selectbox(key, v, state) {
  const on = state.selected.has(`${key}::${v}`) ? ' checked' : '';
  return `<label class="select"><input type="checkbox" class="selectbox" data-key="${esc(key)}" data-v="${esc(v)}"${on}>select</label>`;
}

function hmark(key, v) {
  return `<button class="hmark" data-key="${esc(key)}" data-v="${esc(v)}" title="Show ${esc(v)}">`
    + `<span class="lbl">${esc(v)}</span><span class="bar"></span></button>`;
}

function colShell(key, v, state, { badge = '', body, meta = '', links = '' }) {
  const on = state.selected.has(`${key}::${v}`) ? ' selected' : '';
  const hide = `<button class="hide" data-key="${esc(key)}" data-v="${esc(v)}">hide</button>`;
  return `<div class="col${on}"><div class="vrow"><span class="v">${esc(v)}${badge}</span>`
    + `<span class="ctl">${selectbox(key, v, state)}${hide}</span></div>${body}`
    + `<div class="m">${esc(meta)}</div><div class="links">${links}</div></div>`;
}

function shotCol(v, key, state) {
  const badge = v.promoted ? '<span class="badge">final</span>' : '';
  const meta = [v.meta.model, v.meta.resolution, v.meta.ts].filter(Boolean).join(' · ');
  let body;
  if (state.mode === 'mattes') {
    // Placeholder only: app.js asks /api/matte-preview for the composite of this
    // matte over state.bg and swaps in a <video> once it is ready.
    body = v.variants.alpha
      ? `<div class="mpv" data-src="${esc(v.variants.alpha)}" data-bg="${esc(state.bg)}">rendering ${esc(state.bg)} preview…</div>`
      : '<div class="missing">no matte</div>';
    if (v.variants.qc.length) {
      body += '<div class="qc">' + v.variants.qc.filter((q) => /\.(png|jpe?g|webp)$/i.test(q))
        .map((q) => `<img src="${esc(mediaUrl(q))}" loading="lazy">`).join('') + '</div>';
    }
  } else {
    body = v.video
      ? `<video src="${esc(mediaUrl(v.video))}" controls preload="metadata"></video>`
      : '<div class="missing">missing artifact</div>';
  }
  // The raw alpha file is linked for download only — never played inline.
  const links = (v.variants.upscaled || []).map((u) => `<a href="${esc(mediaUrl(u))}" target="_blank">upscaled</a>`).join('')
    + (v.variants.alpha ? `<a href="${esc(mediaUrl(v.variants.alpha))}" download>alpha</a>` : '');
  return colShell(key, v.version, state, { badge, body, meta, links });
}

function sheetCol(v, key, state) {
  const body = (v.images || []).map((s) => `<img src="${esc(mediaUrl(s))}" loading="lazy">`).join('')
    || '<div class="missing">missing artifact</div>';
  const meta = [v.meta.model, v.meta.ts].filter(Boolean).join(' · ');
  const links = (v.upscaled || []).map((u) => `<a href="${esc(mediaUrl(u))}" target="_blank">upscaled</a>`).join('');
  return colShell(key, v.version, state, { body, meta, links });
}

// One review row. `cols(v)` renders a visible column; hidden versions collapse
// to an hmark; onlySelected drops everything unselected. Same rules as the
// static review page's rowHTML.
export function rowHTML({ key, title, tags = '', versions, col }, state) {
  if (state.onlySelected) {
    const cols = versions.filter((v) => state.selected.has(`${key}::${v.version}`)).map(col).join('');
    return `<section class="row"><div class="rowhead"><h2>${esc(title)}</h2></div><div class="tags">${tags}</div>`
      + `<div class="cols selected-only" data-row="${esc(key)}">${cols || '<span class="m">no selected versions</span>'}</div></section>`;
  }
  const hiddenN = versions.filter((v) => state.hidden.has(`${key}::${v.version}`)).length;
  const cols = versions.map((v) => (state.hidden.has(`${key}::${v.version}`) ? hmark(key, v.version) : col(v))).join('');
  const reset = hiddenN ? `<button class="reset" data-key="${esc(key)}">show ${hiddenN} hidden</button>` : '';
  return `<section class="row"><div class="rowhead"><h2>${esc(title)}</h2>${reset}</div><div class="tags">${tags}</div>`
    + `<div class="cols" data-row="${esc(key)}">${cols || '<span class="m">no versions</span>'}</div></section>`;
}

export function shotKey(s) { return s.episode ? `${s.episode}/${s.shotId}` : s.shotId; }
export function sheetKey(type, name, sh) { return `${type}/${name}/${sh.sheetType}/${sh.slug}`; }

const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// Studio key -> the static review page's key (src/review-render.js): shots are
// keyed by shotId alone, sheets by name/sheetType/slug (no element type).
// Studio shot keys have 1-2 segments (`[episode/]shotId`), sheet keys 4.
// Folder-view keys (`folder:<ep>/<path>/<shotId>`) are not handled here: they are
// not real shots and never enter `selected` (see selectionExportDoc / folderSelection).
function staticKey(key) {
  const parts = key.split('/');
  return parts.length >= 4 ? parts.slice(1).join('/') : parts[parts.length - 1];
}

// { studioKey: versions } -> { staticKey: versions }, so a studio export imports
// into already-generated static pages. Keys that collide (same shotId in two
// episodes) get the union of their versions.
export function toStaticSelection(selected) {
  // A Map, not `{}`: keys like `constructor` or `__proto__` must not hit Object.prototype.
  const out = new Map();
  for (const [key, vs] of Object.entries(selected)) {
    if (key.startsWith('folder:')) continue;
    const k = staticKey(key);
    out.set(k, [...new Set([...(out.get(k) || []), ...vs])].sort(byVersion));
  }
  return Object.fromEntries(out);
}

// { 'folder:<ep>/<path>/<shotId>': versions } -> { '<ep>/<path>': { shotId: versions } }.
// ep is the segment up to the first '/', shotId the last; path is everything between.
export function folderSelection(selected) {
  const out = new Map();
  for (const [key, vs] of Object.entries(selected)) {
    if (!key.startsWith('folder:')) continue;
    const parts = key.slice('folder:'.length).split('/');
    if (parts.length < 3) continue;
    const dir = parts.slice(0, -1).join('/'), shotId = parts[parts.length - 1];
    if (!out.has(dir)) out.set(dir, new Map());
    const m = out.get(dir);
    m.set(shotId, [...new Set([...(m.get(shotId) || []), ...vs])].sort(byVersion));
  }
  return Object.fromEntries([...out].map(([d, m]) => [d, Object.fromEntries(m)]));
}

// The "Export selection" file. `selected` (a Set of `key::version`) is written
// twice: real shot/sheet keys in static-page form under `selected` (what the static
// page's importer reads), folder-view candidates under `folderSelected`, and the
// full studio keys under `studioSelected` (lossless).
export function selectionExportDoc({ project, selected, exportedAt }) {
  const studioSelected = new Map();   // Map: see toStaticSelection
  for (const k of selected) {
    const i = k.lastIndexOf('::');
    const key = k.slice(0, i);
    if (!studioSelected.has(key)) studioSelected.set(key, []);
    studioSelected.get(key).push(k.slice(i + 2));
  }
  const sorted = Object.fromEntries([...studioSelected.keys()].sort()
    .map((key) => [key, [...new Set(studioSelected.get(key))].sort(byVersion)]));
  return { format: 'studio-selection/1', project, exportedAt,
    selected: toStaticSelection(sorted), folderSelected: folderSelection(sorted), studioSelected: sorted };
}

// Folder views pass keyPrefix `folder:<ep>/<path>/` so their selection keys never
// collide with real shots of the same id.
export function shotRowItems(shots, { keyPrefix = '' } = {}) {
  return shots.map((s) => {
    const key = keyPrefix + shotKey(s);
    const tags = [s.episode && `ep ${esc(s.episode)}`, s.promotedVersion && `final: ${esc(s.promotedVersion)}`,
      esc(s.characters.join(', ')), esc(s.description)].filter(Boolean).join(' — ');
    return { key, title: s.shotId, tags, versions: s.versions, kind: 'shot' };
  });
}

export function sheetRowItems(el) {
  return el.sheets.map((sh) => ({
    key: sheetKey(el.type, el.name, sh), title: [sh.sheetType, sh.slug].filter(Boolean).join(' / '),
    tags: '', versions: sh.versions, kind: 'sheet',
  }));
}

export function itemRowHTML(item, state) {
  const col = item.kind === 'shot' ? (v) => shotCol(v, item.key, state) : (v) => sheetCol(v, item.key, state);
  return rowHTML({ ...item, col }, state);
}

export function shotRowsHTML(shots, state) {
  return shotRowItems(shots).map((it) => itemRowHTML(it, state)).join('') || '<p class="missing">No shots here yet.</p>';
}

export function sheetRowsHTML(el, state) {
  return sheetRowItems(el).map((it) => itemRowHTML(it, state)).join('') || '<p class="missing">No sheets yet.</p>';
}
