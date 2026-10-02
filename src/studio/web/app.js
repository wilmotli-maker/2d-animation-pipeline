// src/studio/web/app.js
import {
  esc, parseRoute, treeHTML, homeHTML, shotRowItems, sheetRowItems, itemRowHTML, MATTE_BGS,
} from './views.js';

const rail = document.getElementById('rail');
const grid = document.getElementById('grid');
const toolbar = document.getElementById('toolbar');
const titleEl = document.getElementById('title');
const subEl = document.getElementById('subtitle');

const state = {
  tree: null, route: { view: 'home' }, items: [], byKey: {},
  selected: new Set(), hidden: new Set(), mode: 'clips', bg: loadBg(), onlySelected: false,
};

// Matte background is a per-viewer convenience, so localStorage is enough.
function loadBg() {
  try { const b = localStorage.getItem('studio:bg'); return MATTE_BGS.includes(b) ? b : 'checker'; } catch { return 'checker'; }
}
function saveBg() { try { localStorage.setItem('studio:bg', state.bg); } catch {} }

// Swap each .mpv placeholder for its composite <video>. The server renders on
// demand (max 2 at once), so poll pending ones; a placeholder that leaves the
// DOM (re-render, navigation, bg change) just stops polling.
function hydratePreviews(scope = grid) {
  for (const el of scope.querySelectorAll('.mpv:not([data-polling])')) {
    el.dataset.polling = '1';
    const q = `/api/matte-preview?src=${encodeURIComponent(el.dataset.src)}&bg=${encodeURIComponent(el.dataset.bg)}`;
    const tick = async () => {
      if (!el.isConnected) return;
      let r;
      try { r = await getJson(q); } catch (err) { r = { state: 'error', error: err.message }; }
      if (!el.isConnected) return;
      if (r.state === 'ready') {
        const v = document.createElement('video');
        Object.assign(v, { src: r.url, controls: true, loop: true, preload: 'metadata' });
        el.replaceWith(v);
      } else if (r.state === 'error') {
        el.classList.add('err');
        el.textContent = `preview failed: ${r.error}`;
      } else {
        setTimeout(tick, 1500);
      }
    };
    tick();
  }
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function loadSelections() {
  const doc = await getJson('/api/selections');
  state.selected = new Set(Object.entries(doc.selected).flatMap(([k, vs]) => vs.map((v) => `${k}::${v}`)));
}

function versionsFor(key) {
  const p = `${key}::`;
  return [...state.selected].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length));
}

async function saveKey(key) {
  const r = await fetch('/api/selections', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, versions: versionsFor(key) }) });
  if (!r.ok) throw new Error((await r.json()).error || r.status);
}

function flash(msg) { const e = document.getElementById('err'); if (e) e.textContent = msg; }

function renderToolbar() {
  const isShots = state.route.view === 'episode' || state.route.view === 'shot';
  const seg = isShots
    ? `<span class="seg"><button data-mode="clips" class="${state.mode === 'clips' ? 'on' : ''}">Clips</button>`
      + `<button data-mode="mattes" class="${state.mode === 'mattes' ? 'on' : ''}">Mattes</button></span>`
      + (state.mode === 'mattes'
        ? '<span class="bgs">bg ' + MATTE_BGS.map((b) =>
          `<button data-bg="${b}" title="${b}" class="${state.bg === b ? 'on' : ''}"></button>`).join('') + '</span>'
        : '')
    : '';
  const reviewing = state.route.view !== 'home';
  toolbar.innerHTML = seg
    + (reviewing ? `<button id="onlySelected" class="${state.onlySelected ? 'on' : ''}">Show only selected</button>` : '')
    + `<span class="count">${state.selected.size} selected (project)</span>`
    + '<button id="refresh">Rescan</button><button id="export">Export selection</button>'
    + '<span class="err" id="err"></span>';
}

function renderGrid() {
  if (state.route.view === 'home') { grid.innerHTML = homeHTML(state.tree); return; }
  const y = window.scrollY;
  grid.innerHTML = state.items.map((it) => itemRowHTML(it, state)).join('')
    || `<p class="missing">${state.route.view === 'element' ? 'No sheets yet.' : 'No shots here yet.'}</p>`;
  window.scrollTo(0, y);
  hydratePreviews();
}

// Re-render one row only, so other rows' loaded <video>s keep their state.
function rerenderRow(key) {
  const item = state.byKey[key];
  const cols = [...grid.querySelectorAll('.cols[data-row]')].find((c) => c.dataset.row === key);
  if (!item || !cols) return;
  const sx = cols.scrollLeft;
  const sec = cols.closest('section');
  sec.outerHTML = itemRowHTML(item, state);
  const fresh = [...grid.querySelectorAll('.cols[data-row]')].find((c) => c.dataset.row === key);
  if (fresh) { fresh.scrollLeft = sx; hydratePreviews(fresh); }
}

async function route() {
  state.route = parseRoute(location.hash);
  state.hidden.clear();
  rail.innerHTML = treeHTML(state.tree, location.hash || '#/');
  const r = state.route;
  try {
    if (r.view === 'element') {
      const el = await getJson(`/api/element?type=${encodeURIComponent(r.type)}&name=${encodeURIComponent(r.name)}`);
      state.items = sheetRowItems(el);
      titleEl.textContent = `${r.name}`;
      subEl.textContent = `${r.type} · ${state.items.length} sheet(s)`;
    } else if (r.view === 'episode' || r.view === 'shot') {
      const q = `episode=${encodeURIComponent(r.episode)}` + (r.view === 'shot' ? `&id=${encodeURIComponent(r.shotId)}` : '');
      const { shots } = await getJson(`/api/shots?${q}`);
      state.items = shotRowItems(shots);
      titleEl.textContent = r.view === 'shot' ? r.shotId : (r.episode === '_' ? 'All shots' : `Episode ${r.episode}`);
      subEl.textContent = `${shots.length} shot(s)`;
    } else {
      state.items = [];
      titleEl.textContent = state.tree.project;
      subEl.textContent = 'Project overview';
    }
  } catch (err) {
    state.items = [];
    subEl.textContent = `error: ${err.message}`;
  }
  state.byKey = Object.fromEntries(state.items.map((it) => [it.key, it]));
  document.title = `${titleEl.textContent} · Studio`;
  renderToolbar();
  renderGrid();
}

async function boot() {
  [state.tree] = await Promise.all([getJson('/api/tree'), loadSelections()]);
  await route();
}

function exportSelection() {
  const doc = { project: state.tree.project, exportedAt: new Date().toISOString(),
    selected: Object.fromEntries([...new Set([...state.selected].map((k) => k.slice(0, k.lastIndexOf('::'))))]
      .sort().map((key) => [key, versionsFor(key)])) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${state.tree.project}-selection.json` });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

toolbar.addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.mode) { state.mode = t.dataset.mode; renderToolbar(); renderGrid(); }
  else if (t.dataset.bg) { state.bg = t.dataset.bg; saveBg(); renderToolbar(); renderGrid(); }
  else if (t.id === 'onlySelected') { state.onlySelected = !state.onlySelected; renderToolbar(); renderGrid(); }
  else if (t.id === 'refresh') { await boot(); }
  else if (t.id === 'export') exportSelection();
});

grid.addEventListener('click', (e) => {
  const t = e.target;
  const mk = t.closest('.hmark');
  if (t.classList.contains('hide')) { state.hidden.add(`${t.dataset.key}::${t.dataset.v}`); rerenderRow(t.dataset.key); }
  else if (mk) { state.hidden.delete(`${mk.dataset.key}::${mk.dataset.v}`); rerenderRow(mk.dataset.key); }
  else if (t.classList.contains('reset')) {
    const p = `${t.dataset.key}::`;
    for (const k of [...state.hidden]) if (k.startsWith(p)) state.hidden.delete(k);
    rerenderRow(t.dataset.key);
  }
});

grid.addEventListener('change', async (e) => {
  const t = e.target; if (!t.classList.contains('selectbox')) return;
  const key = t.dataset.key, k = `${key}::${t.dataset.v}`;
  if (t.checked) state.selected.add(k); else state.selected.delete(k);
  if (state.onlySelected) rerenderRow(key); else t.closest('.col')?.classList.toggle('selected', t.checked);
  renderToolbar();
  try { await saveKey(key); flash(''); }
  catch (err) {
    if (t.checked) state.selected.delete(k); else state.selected.add(k);   // revert
    t.checked = !t.checked; t.closest('.col')?.classList.toggle('selected', t.checked);
    renderToolbar(); flash(`save failed: ${err.message}`);
  }
});

// Media errors don't bubble; capture them so a broken clip shows a message
// rather than a black box. (Mattes never reach here raw; they are composites.)
grid.addEventListener('error', (e) => {
  const v = e.target;
  if (v.tagName !== 'VIDEO') return;
  const div = document.createElement('div');
  div.className = 'missing';
  div.innerHTML = `can’t play this file · <a href="${esc(v.getAttribute('src'))}" download>download</a>`;
  v.replaceWith(div);
}, true);

window.addEventListener('hashchange', route);
boot().catch((err) => { grid.innerHTML = `<p class="missing">${esc(err.message)}</p>`; });
