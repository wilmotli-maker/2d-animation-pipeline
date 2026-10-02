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
  return `<a class="node${cls ? ` ${cls}` : ''}${href === current ? ' on' : ''}" href="${esc(href)}"><span>${esc(label)}</span>`
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
// null for an empty box.
function makeMatcher(text) {
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

// Same tree shape, narrowed to what the rail boxes match. Episodes with no
// matching shot/folder are dropped and carry `totalShots` for a matched/total meta;
// `filter` holds per-box state for the count line and the invalid-regex flag.
export function filterTree(tree, { shots: shotText = '', elements: elText = '' } = {}) {
  const sm = makeMatcher(shotText), em = makeMatcher(elText);
  const out = { ...tree, folders: tree.folders || [], shotsHeading: shotsHeading(tree) };
  const nShots = allShots(tree).length;
  if (sm) {
    out.episodes = tree.episodes.map((ep) => ({ ...ep,
      shots: ep.shots.filter((s) => sm.test(s.shotId)),
      folders: (ep.folders || []).filter((f) => sm.test(f.path)),
      totalShots: ep.shots.length,
    })).filter((ep) => ep.shots.length || ep.folders.length);
    out.shots = tree.shots.filter((s) => sm.test(s.shotId));
    out.folders = out.folders.filter((f) => sm.test(f.path));
    out.totalShots = tree.shots.length;
  }
  if (em) out.elements = tree.elements.filter((e) => em.test(e.name));
  out.filter = {
    shots: { active: !!sm, invalid: !!sm?.invalid, matched: allShots(out).length, total: nShots },
    elements: { active: !!em, invalid: !!em?.invalid, matched: out.elements.length, total: tree.elements.length },
  };
  return out;
}

export function filterSuggestions(tree) {
  const chars = new Map();
  for (const s of allShots(tree)) {
    const c = shotCharacter(s.shotId);
    if (c) chars.set(c, (chars.get(c) || 0) + 1);
  }
  const names = new Map();
  for (const e of tree.elements) names.set(e.name, [...(names.get(e.name) || []), e.type]);
  const ci = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  return {
    shots: [...chars.keys()].sort(ci).map((c) => ({ value: `^${escapeRegex(c)}-`, label: `${c} (${chars.get(c)} shots)` })),
    elements: [...names.keys()].sort(ci)
      .map((n) => ({ value: `^${escapeRegex(n)}$`, label: `${n} (${[...new Set(names.get(n))].join(', ')})` })),
  };
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
    h += node(`#/episode/${enc(ep.id)}`, `Episode ${ep.id}`, count(ep.shots.length, ep.totalShots), current);
    h += shotNodes(ep.id, ep.shots, ep.folders || [], current);
  }
  if (tree.shots.length || flatFolders.length) {
    if (heading === 'Episodes') h += '<h3>Shots</h3>';
    if (tree.shots.length) h += node('#/episode/_', 'All shots', count(tree.shots.length, tree.totalShots), current);
    h += shotNodes('_', tree.shots, flatFolders, current);
  }
  return h || (tree.filter?.shots.active ? '<div class="empty">no matches</div>' : '');
}

function filterBox(kind, suggestions, value) {
  return `<div class="fbox"><input type="search" class="filter" data-filter="${kind}" list="sug-${kind}"`
    + ` placeholder="filter — character or regex" value="${esc(value || '')}" autocomplete="off" spellcheck="false">`
    + `<datalist id="sug-${kind}">${suggestions.map((s) => `<option value="${esc(s.value)}" label="${esc(s.label)}">`).join('')}</datalist>`
    + `<div class="fcount" data-count="${kind}"></div></div>`;
}

// Static rail skeleton, rendered once per boot/rescan so the filter inputs (and
// their focus/caret) survive route changes; app.js fills the list containers.
export function railShellHTML(tree, suggestions, values = {}) {
  const heading = shotsHeading(tree);
  return '<div id="rail-proj"></div><h3>Elements</h3>' + filterBox('elements', suggestions.elements, values.elements)
    + '<div class="rlist" id="rail-elements"></div>'
    + (heading ? `<h3>${heading}</h3>` + filterBox('shots', suggestions.shots, values.shots)
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
// Folder-view keys (`folder:<ep>/<path>/<shotId>`) match `pipeline review --folder`
// pages, which key by shotId alone.
function staticKey(key) {
  const parts = key.split('/');
  if (key.startsWith('folder:')) return parts[parts.length - 1];
  return parts.length >= 4 ? parts.slice(1).join('/') : parts[parts.length - 1];
}

// { studioKey: versions } -> { staticKey: versions }, so a studio export imports
// into already-generated static pages. Keys that collide (same shotId in two
// episodes) get the union of their versions.
export function toStaticSelection(selected) {
  // A Map, not `{}`: keys like `constructor` or `__proto__` must not hit Object.prototype.
  const out = new Map();
  for (const [key, vs] of Object.entries(selected)) {
    const k = staticKey(key);
    out.set(k, [...new Set([...(out.get(k) || []), ...vs])].sort(byVersion));
  }
  return Object.fromEntries(out);
}

// The "Export selection" file. `selected` (a Set of `key::version`) is written
// twice: static-page-compatible keys under `selected` (what the static page's
// importer reads) and the full studio keys under `studioSelected` (lossless).
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
    selected: toStaticSelection(sorted), studioSelected: sorted };
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
