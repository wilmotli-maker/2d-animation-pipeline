// src/review-render.js
// Pure HTML rendering. Asset paths in `model` must already be page-relative.

const STYLE = `
:root { --bg:#14151a; --panel:#1c1e25; --line:#2c2f39; --fg:#e8e9ee;
  --dim:#9aa0b0; --accent:#7cc4ff; --warn:#ffcc66; --good:#7ddba0; }
* { box-sizing:border-box; }
body { margin:0; padding:1.5rem 1.25rem 5rem; background:var(--bg); color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
.wrap { max-width:1400px; margin:0 auto; display:grid; grid-template-columns:220px minmax(0,1fr); gap:1.5rem; }
main { min-width:0; }
h1 { font-size:1.5rem; margin:0 0 .3rem; letter-spacing:-.01em; }
.sub { color:var(--dim); margin:0 0 1rem; }
.rail { position:sticky; top:1rem; align-self:start; }
.rail h3 { font-size:.8rem; text-transform:uppercase; letter-spacing:.05em; color:var(--dim); margin:1.2rem 0 .4rem; }
.rail label { display:block; font-size:.9rem; padding:.15rem 0; cursor:pointer; }
.rail input { margin-right:.5rem; }
.toolbar { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; margin:0 0 1.2rem; }
.toolbar button, .toolbar label.btn { color:var(--fg); background:var(--panel); border:1px solid var(--line); border-radius:6px; cursor:pointer; font-size:.8rem; padding:.3rem .6rem; }
.toolbar button:hover, .toolbar label.btn:hover { border-color:var(--accent); }
.toolbar button.on { background:var(--accent); color:#0b0d10; border-color:var(--accent); }
.toolbar .count { color:var(--dim); font-size:.8rem; }
.toolbar .err { color:var(--warn); font-size:.8rem; }
.row { border-top:1px solid var(--line); padding:1.2rem 0; }
.rowhead { display:flex; align-items:center; gap:.6rem; margin:0 0 .1rem; }
.row h2 { font-size:1rem; margin:0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent); }
.row .tags { color:var(--dim); font-size:.82rem; margin:0 0 .7rem; }
.cols { display:flex; gap:1rem; overflow-x:auto; padding-bottom:.6rem; align-items:flex-start; }
.cols.stacked { flex-direction:column; }
.cols.selected-only .hide { display:none; }
.col { flex:0 0 320px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.7rem; }
.cols.stacked .col { flex-basis:auto; width:100%; max-width:640px; }
.col.selected { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
.col .vrow { display:flex; align-items:center; justify-content:space-between; gap:.5rem; margin-bottom:.4rem; }
.col .ctl { display:flex; align-items:center; gap:.4rem; }
.col .v { font-family:ui-monospace,Menlo,monospace; color:var(--good); font-size:.85rem; }
.col .select { display:flex; align-items:center; gap:.25rem; font-size:.72rem; color:var(--dim); cursor:pointer; }
.col .select input { margin:0; }
.col .badge { background:var(--good); color:#0b0d10; font-size:.68rem; font-weight:600; padding:.05rem .35rem; border-radius:4px; margin-left:.4rem; text-transform:uppercase; letter-spacing:.03em; }
.col .hide { background:none; border:1px solid var(--line); color:var(--dim); border-radius:4px; cursor:pointer; font-size:.72rem; line-height:1; padding:.15rem .4rem; }
.col .hide:hover { color:var(--fg); border-color:var(--dim); }
.hmark { flex:0 0 auto; align-self:stretch; width:26px; background:none; border:none; padding:.2rem 0 0; margin:0; cursor:pointer; display:flex; flex-direction:column; align-items:center; }
.hmark .lbl { font:.6rem/1 ui-monospace,Menlo,monospace; color:var(--dim); margin-bottom:.3rem; white-space:nowrap; }
.hmark .bar { flex:1; width:2px; background:var(--line); border-radius:2px; }
.hmark:hover .bar { background:var(--accent); }
.hmark:hover .lbl { color:var(--accent); }
.col video, .col img { width:100%; border-radius:6px; display:block; background:#000; }
.col .m { color:var(--dim); font-size:.78rem; margin-top:.4rem; }
.missing { color:var(--warn); font-size:.85rem; padding:2rem 0; text-align:center; }
.links a { color:var(--accent); font-size:.78rem; margin-right:.6rem; }
.reset { color:var(--accent); background:none; border:1px solid var(--line); border-radius:6px; cursor:pointer; font-size:.72rem; padding:.15rem .45rem; }
.reset:hover { border-color:var(--accent); }
`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// JSON embedded in a <script type="application/json"> — neutralize all angle brackets
// so no tokenizer rule can let the JSON break out of the script element.
function embed(data) {
  return JSON.stringify(data, null, 2)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028|\u2029/g, '');
}

function page({ title, subtitle, data, script }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style></head>
<body>
<div class="wrap">
  <aside class="rail" id="rail"></aside>
  <main>
    <h1>${esc(title)}</h1>
    <p class="sub">${esc(subtitle)}</p>
    <div class="toolbar" id="toolbar"></div>
    <div id="grid"></div>
  </main>
</div>
<script type="application/json" id="review-data">${embed(data)}</script>
<script>${script}</script>
</body></html>`;
}

// Shared client-side JS. Concatenated AHEAD of a page-specific script that defines
// facets, visible(), col(), render(). Function declarations here are visible to the
// page script (single <script> scope); render()/updateCount() are called from here
// but defined in the page script — hoisting makes that safe.
const COMMON_SCRIPT = `
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
const DATA = JSON.parse(document.getElementById('review-data').textContent);
const rail = document.getElementById('rail'), grid = document.getElementById('grid');
const state = { text: '', hidden: new Set(), selected: new Set(), showSelectedOnly: false };
const VALID = new Set();
for (const key in DATA.selection.versions) for (const v of DATA.selection.versions[key]) VALID.add(key + '::' + v);
const LSKEY = 'review:selected:' + (DATA.slug || '');
function loadSelected(){ try { const raw = localStorage.getItem(LSKEY); if (raw) for (const k of JSON.parse(raw)) if (VALID.has(k)) state.selected.add(k); } catch (e) {} }
function saveSelected(){ try { localStorage.setItem(LSKEY, JSON.stringify([...state.selected])); } catch (e) {} }
function selectedObject(){
  const out = {};
  for (const k of state.selected){ const i = k.lastIndexOf('::'); const key = k.slice(0, i), v = k.slice(i + 2); (out[key] = out[key] || []).push(v); }
  for (const key in out) out[key].sort(function(a, b){ return (parseInt(a.slice(1), 10) || 0) - (parseInt(b.slice(1), 10) || 0); });
  return out;
}
function toggle(set, el){ el.checked ? set.add(el.value) : set.delete(el.value); }
function unhideRow(key){ const p = key + '::'; for (const k of [...state.hidden]) if (k.slice(0, p.length) === p) state.hidden.delete(k); }
function hmark(key, version){
  return '<button class="hmark" data-key="' + esc(key) + '" data-v="' + esc(version) + '" title="Show ' + esc(version) + '">'
    + '<span class="lbl">' + esc(version) + '</span><span class="bar"></span></button>';
}
function selectbox(key, version){
  const on = state.selected.has(key + '::' + version) ? ' checked' : '';
  return '<label class="select"><input type="checkbox" class="selectbox" data-key="' + esc(key) + '" data-v="' + esc(version) + '"' + on + '>select</label>';
}
function downloadSelected(){
  const obj = { page: DATA.slug || '', type: DATA.type || '', title: DATA.title || '', exportedAt: new Date().toISOString(), selected: selectedObject() };
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = (DATA.slug || 'review') + '-selection.json';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function importSelected(file){
  const errEl = document.getElementById('impErr'); errEl.textContent = '';
  const reader = new FileReader();
  reader.onerror = function(){ errEl.textContent = 'could not read selection file'; };
  reader.onload = function(){
    try {
      const obj = JSON.parse(reader.result);
      if (!obj || typeof obj !== 'object' || !obj.selected || typeof obj.selected !== 'object') throw new Error('bad');
      let n = 0;
      for (const key in obj.selected){ const arr = obj.selected[key]; if (!Array.isArray(arr)) continue;
        for (const v of arr){ const k = key + '::' + v; if (VALID.has(k) && !state.selected.has(k)){ state.selected.add(k); n++; } } }
      saveSelected(); render();
      errEl.textContent = 'imported ' + n + ' selection' + (n === 1 ? '' : 's');
    } catch (e) { errEl.textContent = 'could not read selection file'; }
  };
  reader.readAsText(file);
}
function updateCount(){ document.getElementById('selectCount').textContent = state.selected.size + ' selected'; }
document.getElementById('toolbar').innerHTML =
  '<button id="onlySelected">Show only selected</button><span class="count" id="selectCount"></span>'
  + '<button id="dl">Download selection</button>'
  + '<label class="btn" for="imp">Import selection</label>'
  + '<input id="imp" type="file" accept="application/json" style="display:none">'
  + '<span class="err" id="impErr"></span>';
document.getElementById('onlySelected').addEventListener('click', function(e){ state.showSelectedOnly = !state.showSelectedOnly; e.currentTarget.classList.toggle('on', state.showSelectedOnly); render(); });
document.getElementById('dl').addEventListener('click', downloadSelected);
document.getElementById('imp').addEventListener('change', function(e){ const f = e.target.files[0]; if (f) importSelected(f); e.target.value = ''; });
grid.addEventListener('click', function(e){
  const t = e.target, mk = t.closest ? t.closest('.hmark') : null;
  if (t.classList.contains('hide')) { state.hidden.add(t.dataset.key + '::' + t.dataset.v); render(); }
  else if (mk) { state.hidden.delete(mk.dataset.key + '::' + mk.dataset.v); render(); }
  else if (t.classList.contains('reset')) { unhideRow(t.dataset.key); render(); }
});
grid.addEventListener('change', function(e){
  if (e.target.classList.contains('selectbox')) {
    const k = e.target.dataset.key + '::' + e.target.dataset.v;
    e.target.checked ? state.selected.add(k) : state.selected.delete(k);
    saveSelected(); render();
  }
});
loadSelected();
`;

const SHOT_SCRIPT = `
state.characters = new Set(); state.episodes = new Set();
const allChars = [...new Set(DATA.model.shots.flatMap(s => s.characters))].sort();
const allEps = [...new Set(DATA.model.shots.map(s => s.episode).filter(Boolean))].sort();
function facet(title, values){
  if (!values.length) return '';
  return '<h3>' + title + '</h3>' + values.map(v =>
    '<label><input type="checkbox" data-set="' + title + '" value="' + esc(v) + '">' + esc(v) + '</label>').join('');
}
rail.innerHTML = '<h3>Filter</h3><label><input id="txt" placeholder="regex" style="width:100%"></label>'
  + facet('Characters', allChars) + facet('Episodes', allEps);
rail.addEventListener('input', function(e){
  if (e.target.id === 'txt') state.text = e.target.value;
  else if (e.target.dataset.set === 'Characters') toggle(state.characters, e.target);
  else if (e.target.dataset.set === 'Episodes') toggle(state.episodes, e.target);
  render();
});
function visible(s){
  if (state.text) { try { if (!new RegExp(state.text).test(s.shotId)) return false; } catch (e) {} }
  if (state.characters.size && !s.characters.some(c => state.characters.has(c))) return false;
  if (state.episodes.size && !state.episodes.has(s.episode)) return false;
  return true;
}
function col(v, key){
  const media = v.video
    ? '<video src="' + esc(v.video) + '" controls preload="metadata"></video>'
    : '<div class="missing">missing artifact</div>';
  const links = (v.variants.upscaled || []).map(u => '<a href="' + esc(u) + '">upscaled</a>').join('')
    + (v.variants.alpha ? '<a href="' + esc(v.variants.alpha) + '">alpha</a>' : '');
  const m = [v.meta.model, v.meta.resolution, v.meta.ts].filter(Boolean).join(' · ');
  const badge = v.promoted ? '<span class="badge">final</span>' : '';
  const hide = '<button class="hide" data-key="' + esc(key) + '" data-v="' + esc(v.version) + '">hide</button>';
  const on = state.selected.has(key + '::' + v.version) ? ' selected' : '';
  return '<div class="col' + on + '"><div class="vrow"><span class="v">' + esc(v.version) + badge + '</span>'
    + '<span class="ctl">' + selectbox(key, v.version) + hide + '</span></div>' + media
    + '<div class="m">' + esc(m) + '</div><div class="links">' + links + '</div></div>';
}
function tags(s){
  return [s.episode && 'ep ' + esc(s.episode), s.promotedVersion && 'final: ' + esc(s.promotedVersion), esc(s.characters.join(', ')), esc(s.description)].filter(Boolean).join(' — ');
}
function render(){
  updateCount();
  grid.innerHTML = DATA.model.shots.filter(visible).map(s => {
    const picks = new Set(DATA.selection.versions[s.shotId] || []);
    const sel = s.versions.filter(v => picks.has(v.version));
    if (state.showSelectedOnly) {
      const cols = sel.filter(v => state.selected.has(s.shotId + '::' + v.version)).map(v => col(v, s.shotId)).join('');
      return '<section class="row"><div class="rowhead"><h2>' + esc(s.shotId) + '</h2></div><div class="tags">' + tags(s)
        + '</div><div class="cols selected-only ' + DATA.selection.layout + '">' + (cols || '<span class="m">no selected versions</span>') + '</div></section>';
    }
    const hiddenN = sel.filter(v => state.hidden.has(s.shotId + '::' + v.version)).length;
    const cols = sel.map(v => state.hidden.has(s.shotId + '::' + v.version) ? hmark(s.shotId, v.version) : col(v, s.shotId)).join('');
    const reset = hiddenN ? '<button class="reset" data-key="' + esc(s.shotId) + '">show ' + hiddenN + ' hidden</button>' : '';
    return '<section class="row"><div class="rowhead"><h2>' + esc(s.shotId) + '</h2>' + reset + '</div><div class="tags">' + tags(s)
      + '</div><div class="cols ' + DATA.selection.layout + '">' + (cols || '<span class="m">no versions</span>') + '</div></section>';
  }).join('') || '<p class="missing">No shots match.</p>';
}
render();
`;

const IMAGE_SCRIPT = `
state.characters = new Set(); state.sheets = new Set();
const rows = DATA.model.characters.flatMap(c => c.sheets.map(sh => ({
  key: c.name + '/' + sh.sheetType + '/' + sh.slug, name: c.name,
  sheetType: sh.sheetType, slug: sh.slug, versions: sh.versions })));
const allChars = [...new Set(DATA.model.characters.map(c => c.name))].sort();
const allSheets = [...new Set(rows.map(r => r.sheetType))].sort();
function facet(title, values){
  if (!values.length) return '';
  return '<h3>' + title + '</h3>' + values.map(v =>
    '<label><input type="checkbox" data-set="' + title + '" value="' + esc(v) + '">' + esc(v) + '</label>').join('');
}
rail.innerHTML = '<h3>Filter</h3><label><input id="txt" placeholder="slug regex" style="width:100%"></label>'
  + facet('Characters', allChars) + facet('Sheets', allSheets);
rail.addEventListener('input', function(e){
  if (e.target.id === 'txt') state.text = e.target.value;
  else if (e.target.dataset.set === 'Characters') toggle(state.characters, e.target);
  else if (e.target.dataset.set === 'Sheets') toggle(state.sheets, e.target);
  render();
});
function visible(r){
  if (state.text) { try { if (!new RegExp(state.text).test(r.slug)) return false; } catch (e) {} }
  if (state.characters.size && !state.characters.has(r.name)) return false;
  if (state.sheets.size && !state.sheets.has(r.sheetType)) return false;
  return true;
}
function col(v, key){
  const imgs = (v.images || []).map(s => '<img src="' + esc(s) + '" loading="lazy">').join('')
    || '<div class="missing">missing artifact</div>';
  const m = [v.meta.model, v.meta.ts].filter(Boolean).join(' · ');
  const hide = '<button class="hide" data-key="' + esc(key) + '" data-v="' + esc(v.version) + '">hide</button>';
  const on = state.selected.has(key + '::' + v.version) ? ' selected' : '';
  return '<div class="col' + on + '"><div class="vrow"><span class="v">' + esc(v.version) + '</span>'
    + '<span class="ctl">' + selectbox(key, v.version) + hide + '</span></div>' + imgs
    + '<div class="m">' + esc(m) + '</div></div>';
}
function render(){
  updateCount();
  grid.innerHTML = rows.filter(visible).map(r => {
    const picks = new Set(DATA.selection.versions[r.key] || []);
    const sel = r.versions.filter(v => picks.has(v.version));
    if (state.showSelectedOnly) {
      const cols = sel.filter(v => state.selected.has(r.key + '::' + v.version)).map(v => col(v, r.key)).join('');
      return '<section class="row"><div class="rowhead"><h2>' + esc(r.key) + '</h2></div><div class="cols selected-only ' + DATA.selection.layout + '">' + (cols || '<span class="m">no selected versions</span>') + '</div></section>';
    }
    const hiddenN = sel.filter(v => state.hidden.has(r.key + '::' + v.version)).length;
    const cols = sel.map(v => state.hidden.has(r.key + '::' + v.version) ? hmark(r.key, v.version) : col(v, r.key)).join('');
    const reset = hiddenN ? '<button class="reset" data-key="' + esc(r.key) + '">show ' + hiddenN + ' hidden</button>' : '';
    return '<section class="row"><div class="rowhead"><h2>' + esc(r.key) + '</h2>' + reset + '</div><div class="cols ' + DATA.selection.layout + '">' + (cols || '<span class="m">no versions</span>') + '</div></section>';
  }).join('') || '<p class="missing">No sheets match.</p>';
}
render();
`;

export function renderShotPage({ model, selection, title = 'Shot review', slug = '', type = 'shots' }) {
  return page({ title, subtitle: `${model.shots.length} shot(s) · generated ${model.generatedAt || ''}`,
    data: { model, selection, slug, type, title }, script: COMMON_SCRIPT + SHOT_SCRIPT });
}

export function renderImagePage({ model, selection, title = 'Image review', slug = '', type = 'images' }) {
  const n = model.characters.reduce((a, c) => a + c.sheets.length, 0);
  return page({ title, subtitle: `${n} sheet(s) · generated ${model.generatedAt || ''}`,
    data: { model, selection, slug, type, title }, script: COMMON_SCRIPT + IMAGE_SCRIPT });
}
