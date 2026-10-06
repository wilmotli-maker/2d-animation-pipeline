// src/studio/web/app.js
import {
  esc, parseRoute, treeHTML, homeHTML, shotRowItems, sheetRowItems, itemRowHTML, MATTE_BGS, selectionExportDoc,
} from './views.js';
import { createSelectionSync } from './selection-sync.js';

const rail = document.getElementById('rail');
const grid = document.getElementById('grid');
const toolbar = document.getElementById('toolbar');
const titleEl = document.getElementById('title');
const subEl = document.getElementById('subtitle');

// Selection state + server sync live in selection-sync.js; state.selected is
// its Set (mutated in place), which the view builders read directly.
const sync = createSelectionSync({ fetchJson: getJson, putJson });
const state = {
  tree: null, route: { view: 'home' }, items: [], byKey: {},
  selected: sync.selected, hidden: new Set(), mode: 'clips', bg: loadBg(), onlySelected: false,
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
    let delay = 1500;   // back off 1.5x up to 5s while the server is still rendering
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
        setTimeout(tick, delay);
        delay = Math.min(delay * 1.5, 5000);
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

async function putJson(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const b = await r.json().catch(() => null);
    throw new Error(b?.error || `HTTP ${r.status}`);
  }
  return r.json().catch(() => null);
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
  // A rebuild resets every row's horizontal scroll; snapshot per data-row and restore.
  const sx = new Map([...grid.querySelectorAll('.cols[data-row]')].map((c) => [c.dataset.row, c.scrollLeft]));
  grid.innerHTML = state.items.map((it) => itemRowHTML(it, state)).join('')
    || `<p class="missing">${state.route.view === 'element' ? 'No sheets yet.' : 'No shots here yet.'}</p>`;
  for (const c of grid.querySelectorAll('.cols[data-row]')) if (sx.has(c.dataset.row)) c.scrollLeft = sx.get(c.dataset.row);
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

// Bumped per route() call so a slow response for an older route is dropped.
let routeSeq = 0;
async function route() {
  const my = ++routeSeq;
  state.route = parseRoute(location.hash);
  state.hidden.clear();
  rail.innerHTML = treeHTML(state.tree, location.hash || '#/');
  // Bring the active node into the rail's viewport. Set scrollTop directly (not
  // scrollIntoView) so only the rail scrolls, never the window.
  const on = rail.querySelector('a.node.on');
  if (on) {
    const rr = rail.getBoundingClientRect(), nr = on.getBoundingClientRect();
    if (nr.top < rr.top) rail.scrollTop += nr.top - rr.top;
    else if (nr.bottom > rr.bottom) rail.scrollTop += nr.bottom - rr.bottom;
  }
  const r = state.route;
  try {
    if (r.view === 'element') {
      const el = await getJson(`/api/element?type=${encodeURIComponent(r.type)}&name=${encodeURIComponent(r.name)}`);
      if (my !== routeSeq) return;
      state.items = sheetRowItems(el);
      titleEl.textContent = `${r.name}`;
      subEl.textContent = `${r.type} · ${state.items.length} sheet(s)`;
    } else if (r.view === 'episode' || r.view === 'shot') {
      const q = `episode=${encodeURIComponent(r.episode)}` + (r.view === 'shot' ? `&id=${encodeURIComponent(r.shotId)}` : '');
      const { shots } = await getJson(`/api/shots?${q}`);
      if (my !== routeSeq) return;
      state.items = shotRowItems(shots);
      titleEl.textContent = r.view === 'shot' ? r.shotId : (r.episode === '_' ? 'All shots' : `Episode ${r.episode}`);
      subEl.textContent = `${shots.length} shot(s)`;
    } else {
      state.items = [];
      titleEl.textContent = state.tree.project;
      subEl.textContent = 'Project overview';
    }
  } catch (err) {
    if (my !== routeSeq) return;
    state.items = [];
    subEl.textContent = `error: ${err.message}`;
  }
  state.byKey = Object.fromEntries(state.items.map((it) => [it.key, it]));
  document.title = `${titleEl.textContent} · Studio`;
  renderToolbar();
  renderGrid();
}

// Also the Rescan path: sync.load() waits for pending saves and keeps toggles
// made during its GET, so a rescan can't undo a click.
async function boot() {
  let sel;
  [state.tree, sel] = await Promise.all([getJson('/api/tree'), sync.load()]);
  await route();
  if (sel.warnings.length) flash(sel.warnings[0]);   // e.g. a corrupt selections.json was ignored
}

function exportSelection() {
  // `selected` uses static-review keys so the file imports into generated review pages.
  const doc = selectionExportDoc({ project: state.tree.project, selected: state.selected, exportedAt: new Date().toISOString() });
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${state.tree.project}-selection.json` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);   // immediate revoke can cancel the download in Safari/Firefox
}

toolbar.addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.mode) { state.mode = t.dataset.mode; renderToolbar(); renderGrid(); }
  else if (t.dataset.bg) { state.bg = t.dataset.bg; saveBg(); renderToolbar(); renderGrid(); }
  else if (t.id === 'onlySelected') { state.onlySelected = !state.onlySelected; renderToolbar(); renderGrid(); }
  else if (t.id === 'refresh') { try { await boot(); } catch (err) { flash(`rescan failed: ${err.message}`); } }
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

// Optimistic: sync.toggle updates state.selected synchronously and queues the
// save. On failure it reverts only if no later click of the same box happened.
grid.addEventListener('change', async (e) => {
  const t = e.target; if (!t.classList.contains('selectbox')) return;
  const key = t.dataset.key, want = t.checked;
  const saved = sync.toggle(key, t.dataset.v, want);
  if (state.onlySelected) rerenderRow(key); else t.closest('.col')?.classList.toggle('selected', want);
  renderToolbar();
  const r = await saved;
  if (r.ok) { flash(''); return; }
  if (r.reverted) {
    rerenderRow(key);   // t may be detached by now; redraw the live row from state
    renderToolbar();
  }
  flash(`save failed: ${r.error.message}`);
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
