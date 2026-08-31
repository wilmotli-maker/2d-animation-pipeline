// src/review-render.js
// Pure HTML rendering. Asset paths in `model` must already be page-relative.

const STYLE = `
:root { --bg:#14151a; --panel:#1c1e25; --line:#2c2f39; --fg:#e8e9ee;
  --dim:#9aa0b0; --accent:#7cc4ff; --warn:#ffcc66; --good:#7ddba0; }
* { box-sizing:border-box; }
body { margin:0; padding:1.5rem 1.25rem 5rem; background:var(--bg); color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
.wrap { max-width:1400px; margin:0 auto; display:grid; grid-template-columns:220px 1fr; gap:1.5rem; }
h1 { font-size:1.5rem; margin:0 0 .3rem; letter-spacing:-.01em; }
.sub { color:var(--dim); margin:0 0 1.5rem; }
.rail { position:sticky; top:1rem; align-self:start; }
.rail h3 { font-size:.8rem; text-transform:uppercase; letter-spacing:.05em; color:var(--dim); margin:1.2rem 0 .4rem; }
.rail label { display:block; font-size:.9rem; padding:.15rem 0; cursor:pointer; }
.rail input { margin-right:.5rem; }
.row { border-top:1px solid var(--line); padding:1.2rem 0; }
.row h2 { font-size:1rem; margin:0 0 .1rem; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent); }
.row .tags { color:var(--dim); font-size:.82rem; margin:0 0 .7rem; }
.cols { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); }
.cols.stacked { grid-template-columns:1fr; }
.col { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.7rem; }
.col .v { font-family:ui-monospace,Menlo,monospace; color:var(--good); font-size:.85rem; margin-bottom:.4rem; }
.col video, .col img { width:100%; border-radius:6px; display:block; background:#000; }
.col .m { color:var(--dim); font-size:.78rem; margin-top:.4rem; }
.missing { color:var(--warn); font-size:.85rem; padding:2rem 0; text-align:center; }
.links a { color:var(--accent); font-size:.78rem; margin-right:.6rem; }
`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// JSON embedded in a <script type="application/json"> — only </script> needs escaping.
function embed(data) {
  return JSON.stringify(data, null, 2).replace(/<\/script>/gi, '<\\/script>');
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
    <div id="grid"></div>
  </main>
</div>
<script type="application/json" id="review-data">${embed(data)}</script>
<script>${script}</script>
</body></html>`;
}

const SHOT_SCRIPT = `
const DATA = JSON.parse(document.getElementById('review-data').textContent);
const state = { characters: new Set(), episodes: new Set(), text: '' };
const rail = document.getElementById('rail'), grid = document.getElementById('grid');
const allChars = [...new Set(DATA.model.shots.flatMap(s => s.characters))].sort();
const allEps = [...new Set(DATA.model.shots.map(s => s.episode).filter(Boolean))].sort();
function facet(title, values, set) {
  if (!values.length) return '';
  return '<h3>' + title + '</h3>' + values.map(v =>
    '<label><input type="checkbox" data-set="' + title + '" value="' + v + '">' + v + '</label>').join('');
}
rail.innerHTML = '<h3>Filter</h3><label><input id="txt" placeholder="regex" style="width:100%"></label>'
  + facet('Characters', allChars, state.characters)
  + facet('Episodes', allEps, state.episodes);
rail.addEventListener('input', (e) => {
  if (e.target.id === 'txt') state.text = e.target.value;
  else if (e.target.dataset.set === 'Characters') toggle(state.characters, e.target);
  else if (e.target.dataset.set === 'Episodes') toggle(state.episodes, e.target);
  render();
});
function toggle(set, el){ el.checked ? set.add(el.value) : set.delete(el.value); }
function visible(s) {
  if (state.text) { try { if (!new RegExp(state.text).test(s.shotId)) return false; } catch {} }
  if (state.characters.size && !s.characters.some(c => state.characters.has(c))) return false;
  if (state.episodes.size && !state.episodes.has(s.episode)) return false;
  return true;
}
function col(v) {
  const media = v.video
    ? '<video src="' + v.video + '" controls preload="metadata"></video>'
    : '<div class="missing">missing artifact</div>';
  const links = (v.variants.upscaled||[]).map(u => '<a href="' + u + '">upscaled</a>').join('')
    + (v.variants.alpha ? '<a href="' + v.variants.alpha + '">alpha</a>' : '');
  const m = [v.meta.model, v.meta.resolution, v.meta.ts].filter(Boolean).join(' · ');
  return '<div class="col"><div class="v">' + v.version + '</div>' + media
    + '<div class="m">' + m + '</div><div class="links">' + links + '</div></div>';
}
function render() {
  grid.innerHTML = DATA.model.shots.filter(visible).map(s => {
    const picks = new Set(DATA.selection.versions[s.shotId] || []);
    const cols = s.versions.filter(v => picks.has(v.version)).map(col).join('');
    return '<section class="row"><h2>' + s.shotId + '</h2><div class="tags">'
      + [s.episode && 'ep ' + s.episode, s.characters.join(', '), s.description].filter(Boolean).join(' — ')
      + '</div><div class="cols ' + DATA.selection.layout + '">' + cols + '</div></section>';
  }).join('') || '<p class="missing">No shots match.</p>';
}
render();
`;

const IMAGE_SCRIPT = `
const DATA = JSON.parse(document.getElementById('review-data').textContent);
const state = { characters: new Set(), sheets: new Set(), text: '' };
const rail = document.getElementById('rail'), grid = document.getElementById('grid');
const rows = DATA.model.characters.flatMap(c => c.sheets.map(sh => ({
  key: c.name + '/' + sh.sheetType + '/' + sh.slug, name: c.name,
  sheetType: sh.sheetType, slug: sh.slug, versions: sh.versions })));
const allChars = [...new Set(DATA.model.characters.map(c => c.name))].sort();
const allSheets = [...new Set(rows.map(r => r.sheetType))].sort();
function facet(title, values) {
  if (!values.length) return '';
  return '<h3>' + title + '</h3>' + values.map(v =>
    '<label><input type="checkbox" data-set="' + title + '" value="' + v + '">' + v + '</label>').join('');
}
rail.innerHTML = '<h3>Filter</h3><label><input id="txt" placeholder="slug regex" style="width:100%"></label>'
  + facet('Characters', allChars) + facet('Sheets', allSheets);
rail.addEventListener('input', (e) => {
  if (e.target.id === 'txt') state.text = e.target.value;
  else if (e.target.dataset.set === 'Characters') toggle(state.characters, e.target);
  else if (e.target.dataset.set === 'Sheets') toggle(state.sheets, e.target);
  render();
});
function toggle(set, el){ el.checked ? set.add(el.value) : set.delete(el.value); }
function visible(r) {
  if (state.text) { try { if (!new RegExp(state.text).test(r.slug)) return false; } catch {} }
  if (state.characters.size && !state.characters.has(r.name)) return false;
  if (state.sheets.size && !state.sheets.has(r.sheetType)) return false;
  return true;
}
function col(v) {
  const imgs = (v.images||[]).map(s => '<img src="' + s + '" loading="lazy">').join('')
    || '<div class="missing">missing artifact</div>';
  const m = [v.meta.model, v.meta.ts].filter(Boolean).join(' · ');
  return '<div class="col"><div class="v">' + v.version + '</div>' + imgs + '<div class="m">' + m + '</div></div>';
}
function render() {
  grid.innerHTML = rows.filter(visible).map(r => {
    const picks = new Set(DATA.selection.versions[r.key] || []);
    const cols = r.versions.filter(v => picks.has(v.version)).map(col).join('');
    return '<section class="row"><h2>' + r.key + '</h2><div class="cols ' + DATA.selection.layout + '">' + cols + '</div></section>';
  }).join('') || '<p class="missing">No sheets match.</p>';
}
render();
`;

export function renderShotPage({ model, selection, title = 'Shot review' }) {
  return page({ title, subtitle: `${model.shots.length} shot(s) · generated ${model.generatedAt || ''}`,
    data: { model, selection }, script: SHOT_SCRIPT });
}

export function renderImagePage({ model, selection, title = 'Image review' }) {
  const n = model.characters.reduce((a, c) => a + c.sheets.length, 0);
  return page({ title, subtitle: `${n} sheet(s) · generated ${model.generatedAt || ''}`,
    data: { model, selection }, script: IMAGE_SCRIPT });
}
