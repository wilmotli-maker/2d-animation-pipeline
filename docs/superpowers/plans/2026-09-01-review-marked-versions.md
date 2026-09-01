# Marked Versions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let reviewers mark liked versions on a review page, show only marked versions page-wide, and download/import the marked set as JSON with `localStorage` auto-persist — all client-side so it works on GitHub Pages.

**Architecture:** Almost entirely in the embedded page JS of `src/review-render.js`. The duplicated shot/image client scripts are refactored into one shared `COMMON_SCRIPT` (escaping, marks state + persistence, the marks toolbar, download/import, hide handlers, the hidden-version marker) concatenated ahead of a page-specific script (facets, `visible`, `col`, `render`). `buildReviewPage` passes the page `slug` and `type` into the render functions so the page can namespace `localStorage` and name its download.

**Tech Stack:** Node ESM, `node:test`. Client side: vanilla JS, `localStorage`, `Blob`/`URL.createObjectURL` download, `FileReader` import. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-review-marked-versions-design.md`

---

## File structure

- Modify `src/review-render.js` — full rewrite: add `COMMON_SCRIPT`, refactor `SHOT_SCRIPT`/`IMAGE_SCRIPT` to page-specific bodies, add marks CSS, embed `slug`/`type`/`title` in page `DATA`, accept `slug`/`type` in the two exported render fns.
- Modify `bin/pipeline.js` — nothing (no new flag).
- Modify `src/review-page.js` — pass `slug` and `type` into `renderShotPage`/`renderImagePage`.
- Modify `test/review-render.test.js` — assert the new controls/markup and the embedded `slug`/`type`.
- Modify `test/review-page.test.js` — assert the generated `index.html` embeds the page `slug`.
- Modify `README.md` — one line in the Review-pages section about marking + export.

**Client `state` (in the embedded JS), reused across tasks:**
```
state = { text, hidden:Set, marked:Set<"key::version">, showMarkedOnly:bool,
          characters:Set, episodes|sheets:Set }
```
Storage key `review:marks:<slug>`; `VALID` = every `key::version` from `DATA.selection.versions`.

---

## Task 1: Rewrite `review-render.js` (shared script + marks feature + CSS)

**Files:**
- Modify: `src/review-render.js` (full replace)
- Test: `test/review-render.test.js`

- [ ] **Step 1: Update the render tests first (they will fail)**

Replace the whole body of `test/review-render.test.js` with:

```js
// test/review-render.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderShotPage, renderImagePage } from '../src/review-render.js';

const shotModel = { type: 'shots', generatedAt: 'T', shots: [
  { shotId: 's1', episode: '1', characters: ['mira'], description: 'd', promotedVersion: 'v002', versions: [
    { version: 'v001', kind: 'draft', promoted: false, video: 'assets/s1/v001/output.mp4',
      variants: { alpha: null, upscaled: [], qc: [] }, meta: {} },
    { version: 'v002', kind: 'draft', promoted: true, video: 'assets/s1/v002/output.mp4',
      variants: { alpha: null, upscaled: [], qc: [] }, meta: { model: 'seedance_2_5' } }] }] };
const shotSel = { layout: 'side-by-side', versions: { s1: ['v001', 'v002'] } };

test('renderShotPage: embeds slug/type, marks controls, preserves hide/marker', () => {
  const html = renderShotPage({ model: shotModel, selection: shotSel, title: 'Shots', slug: 'ep1', type: 'shots' });
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /"slug": ?"ep1"/);            // slug embedded (namespaces storage/download)
  assert.match(html, /"type": ?"shots"/);
  assert.match(html, /review:marks:/);             // localStorage key prefix
  assert.match(html, /-marks\.json/);              // download filename
  assert.match(html, /class="markbox"/);           // per-version mark checkbox
  assert.match(html, /Show only marked/);
  assert.match(html, /Download marks/);
  assert.match(html, /Import marks/);
  assert.match(html, /no marked versions/);
  assert.match(html, /class="hide"/);              // preserved
  assert.match(html, /function hmark/);            // preserved
  assert.match(html, /"promotedVersion": ?"v002"/);
});

test('renderImagePage: embeds slug and marks controls', () => {
  const model = { type: 'images', generatedAt: 'T', characters: [
    { type: 'characters', name: 'mira', sheets: [
      { sheetType: 'pose', slug: 'a', versions: [
        { version: 'v001', images: ['assets/mira/pose/a/v001.png'], upscaled: [], meta: {} }] }] }] };
  const sel = { layout: 'side-by-side', versions: { 'mira/pose/a': ['v001'] } };
  const html = renderImagePage({ model, selection: sel, title: 'Sheets', slug: 'sh', type: 'images' });
  assert.match(html, /assets\/mira\/pose\/a\/v001\.png/);
  assert.match(html, /"slug": ?"sh"/);
  assert.match(html, /class="markbox"/);
  assert.match(html, /Show only marked/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/review-render.test.js`
Expected: FAIL (render fns don't embed slug / lack marks controls).

- [ ] **Step 3: Replace `src/review-render.js` entirely with:**

```js
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
.col { flex:0 0 320px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.7rem; }
.cols.stacked .col { flex-basis:auto; width:100%; max-width:640px; }
.col.marked { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
.col .vrow { display:flex; align-items:center; justify-content:space-between; gap:.5rem; margin-bottom:.4rem; }
.col .ctl { display:flex; align-items:center; gap:.4rem; }
.col .v { font-family:ui-monospace,Menlo,monospace; color:var(--good); font-size:.85rem; }
.col .mark { display:flex; align-items:center; gap:.25rem; font-size:.72rem; color:var(--dim); cursor:pointer; }
.col .mark input { margin:0; }
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
const state = { text: '', hidden: new Set(), marked: new Set(), showMarkedOnly: false };
const VALID = new Set();
for (const key in DATA.selection.versions) for (const v of DATA.selection.versions[key]) VALID.add(key + '::' + v);
const LSKEY = 'review:marks:' + (DATA.slug || '');
function loadMarks(){ try { const raw = localStorage.getItem(LSKEY); if (raw) for (const k of JSON.parse(raw)) if (VALID.has(k)) state.marked.add(k); } catch (e) {} }
function saveMarks(){ try { localStorage.setItem(LSKEY, JSON.stringify([...state.marked])); } catch (e) {} }
function marksObject(){
  const out = {};
  for (const k of state.marked){ const i = k.lastIndexOf('::'); const key = k.slice(0, i), v = k.slice(i + 2); (out[key] = out[key] || []).push(v); }
  for (const key in out) out[key].sort(function(a, b){ return (parseInt(a.slice(1), 10) || 0) - (parseInt(b.slice(1), 10) || 0); });
  return out;
}
function toggle(set, el){ el.checked ? set.add(el.value) : set.delete(el.value); }
function unhideRow(key){ const p = key + '::'; for (const k of [...state.hidden]) if (k.slice(0, p.length) === p) state.hidden.delete(k); }
function hmark(key, version){
  return '<button class="hmark" data-key="' + esc(key) + '" data-v="' + esc(version) + '" title="Show ' + esc(version) + '">'
    + '<span class="lbl">' + esc(version) + '</span><span class="bar"></span></button>';
}
function markbox(key, version){
  const on = state.marked.has(key + '::' + version) ? ' checked' : '';
  return '<label class="mark"><input type="checkbox" class="markbox" data-key="' + esc(key) + '" data-v="' + esc(version) + '"' + on + '>mark</label>';
}
function downloadMarks(){
  const obj = { page: DATA.slug || '', type: DATA.type || '', title: DATA.title || '', exportedAt: new Date().toISOString(), marks: marksObject() };
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = (DATA.slug || 'review') + '-marks.json';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function importMarks(file){
  const errEl = document.getElementById('impErr'); errEl.textContent = '';
  const reader = new FileReader();
  reader.onerror = function(){ errEl.textContent = 'could not read marks file'; };
  reader.onload = function(){
    try {
      const obj = JSON.parse(reader.result);
      if (!obj || typeof obj !== 'object' || !obj.marks || typeof obj.marks !== 'object') throw new Error('bad');
      let n = 0;
      for (const key in obj.marks){ const arr = obj.marks[key]; if (!Array.isArray(arr)) continue;
        for (const v of arr){ const k = key + '::' + v; if (VALID.has(k) && !state.marked.has(k)){ state.marked.add(k); n++; } } }
      saveMarks(); render();
      errEl.textContent = 'imported ' + n + ' mark' + (n === 1 ? '' : 's');
    } catch (e) { errEl.textContent = 'could not read marks file'; }
  };
  reader.readAsText(file);
}
function updateCount(){ document.getElementById('markCount').textContent = state.marked.size + ' marked'; }
document.getElementById('toolbar').innerHTML =
  '<button id="onlyMarked">Show only marked</button><span class="count" id="markCount"></span>'
  + '<button id="dl">Download marks</button>'
  + '<label class="btn" for="imp">Import marks</label>'
  + '<input id="imp" type="file" accept="application/json" style="display:none">'
  + '<span class="err" id="impErr"></span>';
document.getElementById('onlyMarked').addEventListener('click', function(e){ state.showMarkedOnly = !state.showMarkedOnly; e.currentTarget.classList.toggle('on', state.showMarkedOnly); render(); });
document.getElementById('dl').addEventListener('click', downloadMarks);
document.getElementById('imp').addEventListener('change', function(e){ const f = e.target.files[0]; if (f) importMarks(f); e.target.value = ''; });
grid.addEventListener('click', function(e){
  const t = e.target, mk = t.closest ? t.closest('.hmark') : null;
  if (t.classList.contains('hide')) { state.hidden.add(t.dataset.key + '::' + t.dataset.v); render(); }
  else if (mk) { state.hidden.delete(mk.dataset.key + '::' + mk.dataset.v); render(); }
  else if (t.classList.contains('reset')) { unhideRow(t.dataset.key); render(); }
});
grid.addEventListener('change', function(e){
  if (e.target.classList.contains('markbox')) {
    const k = e.target.dataset.key + '::' + e.target.dataset.v;
    e.target.checked ? state.marked.add(k) : state.marked.delete(k);
    saveMarks(); render();
  }
});
loadMarks();
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
  const on = state.marked.has(key + '::' + v.version) ? ' marked' : '';
  return '<div class="col' + on + '"><div class="vrow"><span class="v">' + esc(v.version) + badge + '</span>'
    + '<span class="ctl">' + markbox(key, v.version) + hide + '</span></div>' + media
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
    if (state.showMarkedOnly) {
      const cols = sel.filter(v => state.marked.has(s.shotId + '::' + v.version)).map(v => col(v, s.shotId)).join('');
      return '<section class="row"><div class="rowhead"><h2>' + esc(s.shotId) + '</h2></div><div class="tags">' + tags(s)
        + '</div><div class="cols ' + DATA.selection.layout + '">' + (cols || '<span class="m">no marked versions</span>') + '</div></section>';
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
  const on = state.marked.has(key + '::' + v.version) ? ' marked' : '';
  return '<div class="col' + on + '"><div class="vrow"><span class="v">' + esc(v.version) + '</span>'
    + '<span class="ctl">' + markbox(key, v.version) + hide + '</span></div>' + imgs
    + '<div class="m">' + esc(m) + '</div></div>';
}
function render(){
  updateCount();
  grid.innerHTML = rows.filter(visible).map(r => {
    const picks = new Set(DATA.selection.versions[r.key] || []);
    const sel = r.versions.filter(v => picks.has(v.version));
    if (state.showMarkedOnly) {
      const cols = sel.filter(v => state.marked.has(r.key + '::' + v.version)).map(v => col(v, r.key)).join('');
      return '<section class="row"><div class="rowhead"><h2>' + esc(r.key) + '</h2></div><div class="cols ' + DATA.selection.layout + '">' + (cols || '<span class="m">no marked versions</span>') + '</div></section>';
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/review-render.test.js`
Expected: PASS (2 tests).

Then the full suite to catch regressions:
Run: `node --test`
Expected: PASS (the `review-page` build tests still pass — render is called with the same args plus new optional ones).

- [ ] **Step 5: Commit**

```bash
git add src/review-render.js test/review-render.test.js
git commit -m "feat(review): mark versions, show-only-marked, download/import; share client JS"
```

---

## Task 2: Pass `slug`/`type` from `buildReviewPage` into the render functions

**Files:**
- Modify: `src/review-page.js`
- Test: `test/review-page.test.js`

- [ ] **Step 1: Add the failing test**

Append to `test/review-page.test.js` (near the other `buildReviewPage` tests):

```js
test('buildReviewPage: embeds the page slug for marks storage/download', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'art-talk-01');
    await buildReviewPage(root, { type: 'shots', slug: 'ep1' });
    const html = await readFile(path.join(root, 'web', 'ep1', 'index.html'), 'utf8');
    assert.match(html, /"slug": ?"ep1"/);
    assert.match(html, /"type": ?"shots"/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/review-page.test.js`
Expected: FAIL (`"slug": "ep1"` not present — render isn't given the slug yet).

- [ ] **Step 3: Pass slug/type in `buildReviewPage`**

In `src/review-page.js`, find:

```js
  const html = type === 'images'
    ? renderImagePage({ model: pageModel, selection, title: title || 'Image review' })
    : renderShotPage({ model: pageModel, selection, title: title || 'Shot review' });
```

Replace with:

```js
  const html = type === 'images'
    ? renderImagePage({ model: pageModel, selection, title: title || 'Image review', slug, type })
    : renderShotPage({ model: pageModel, selection, title: title || 'Shot review', slug, type });
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/review-page.test.js`
Expected: PASS.

Full suite:
Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review-page.js test/review-page.test.js
git commit -m "feat(review): pass page slug/type into the rendered page"
```

---

## Task 3: Manual smoke test + docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Manual smoke test against the real project**

Run:
```bash
cd "/Users/wilmotli/Projects/Seedance Animation/ArtAI"
node /Users/wilmotli/Projects/2d-animation-pipeline/bin/pipeline.js review shots \
  --episode 1 --match '^art-' --exclude 'candidates|assembled' --slug art-ep1 --update
```
Expected: `review page: …/web/art-ep1 (8 item(s))`. Open `web/art-ep1/index.html` in a browser and confirm: a toolbar with **Show only marked / N marked / Download marks / Import marks**; a **mark** checkbox on each version; marking highlights the column (accent border) and bumps the count; **Show only marked** collapses rows to marked versions and shows *"no marked versions"* where there are none; **Download marks** saves `art-ep1-marks.json`; reloading the page keeps the marks (localStorage); **Import marks** of that file re-applies them.

- [ ] **Step 2: Update `README.md`**

In the "Review pages" section (the bullet list), add a bullet after the `--update` bullet:

```markdown
- Mark the takes you like with each version's **mark** checkbox; the toolbar's
  **Show only marked** collapses every row to its marked versions (rows with none
  say so). **Download marks** exports a small JSON of the marked shot/versions
  (names only, no media) and **Import marks** restores it; marks also auto-save in
  the browser. All client-side, so it works on a static GitHub Pages host.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(review): document marking, show-only-marked, and marks export/import"
```

---

## Self-review notes (author)

- **Spec coverage:** mark checkbox (Task 1 `markbox`/`col`), show-only-marked toggle + no-marks text (Task 1 `render`), download (`downloadMarks`) and import (`importMarks`) with the documented JSON schema, `localStorage` auto-persist namespaced by slug (`LSKEY`/`loadMarks`/`saveMarks`), slug/type plumbing (Task 2), the shared-`COMMON_SCRIPT` refactor (Task 1), GitHub-Pages-only browser APIs. All covered.
- **Preserved behavior:** hide/unhide/reset, hidden-version markers, per-row `show N hidden`, promoted `final` badge + `final: vNNN` label, facets, filters — all retained in the rewritten scripts and asserted (`class="hide"`, `function hmark`, `promotedVersion`).
- **Scope-scoping the `VALID` set:** it's built from `DATA.selection.versions`, which is page-type-agnostic, so `loadMarks`/import validation and the whole `COMMON_SCRIPT` need no shot-vs-image branching.
- **Hoisting:** `COMMON_SCRIPT` references `render`/`updateCount` (defined in the page script) only inside event handlers and after concatenation into one `<script>`; function declarations hoist across the combined scope, and the handlers fire only after load, so ordering is safe. `state.characters`/`state.episodes|sheets` are created at the top of each page script before any `render()`.
- **No placeholders**; every step has full code and exact commands.

## Out of scope (do not build)
- A CLI consumer of the marks JSON (promote/export marked versions).
- An import that clears existing marks first (current import merges).
- Per-row show-only-marked toggles.
