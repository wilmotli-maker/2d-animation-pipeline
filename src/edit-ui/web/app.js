// src/edit-ui/web/app.js
// Targeted-edit UI: one video, frame/range marks on a timeline, scribbled
// on-canvas annotations, prompts linked to marks/annotations, per-keyframe and
// whole-video generation. Session state autosaves to the server.
const $ = (id) => document.getElementById(id);
const video = $('video'); const ink = $('ink'); const stage = $('stage'); const lanes = $('lanes');
const COLORS = ['#ff4d6d', '#ffc43d', '#4cc38a', '#5aa9ff', '#c78bff', '#ffffff'];

// ---- state ---------------------------------------------------------------
const data = { marks: [], annotations: [], prompts: [], keyframes: [], renders: [] }; // persisted
const ui = {
  video: null, meta: { fps: 24, duration: 0, width: 16, height: 9 },
  tool: 'none', color: COLORS[0], size: 5, loop: true,
  sel: { kind: null, id: null }, pendingIn: null, view: 'source', resultSrc: null,
  undo: [], redo: [], drawing: null,
};
const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// ---- helpers -------------------------------------------------------------
const fps = () => ui.meta.fps || 24;
const dur = () => ui.meta.duration || video.duration || 0;
const lastFrame = () => Math.max(0, Math.round(dur() * fps()) - 1);
const frameOf = (t) => Math.min(lastFrame(), Math.max(0, Math.floor(t * fps() + 1e-4)));
const timeOf = (f) => (f + 0.5) / fps(); // mid-frame: robust against decoder rounding
const curFrame = () => frameOf(video.currentTime);
function fmt(t) {
  const m = Math.floor(t / 60); const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}
function toast(msg, ms = 2200) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), ms);
}
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') Object.assign(n.style, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : String(c));
  return n;
}
const markById = (id) => data.marks.find((m) => m.id === id);
const annById = (id) => data.annotations.find((a) => a.id === id);
const markLabel = (m) => m.label || (m.kind === 'frame' ? `Frame ${m.start}` : `Frames ${m.start}–${m.end}`);
const annLabel = (a) => a.label || `Ink @ f${a.frame}`;
const inMark = (m, f) => f >= m.start && f <= m.end;

// Marks and keyframes are stored in frames (exact, fps-stable for one clip).
function seekFrame(f) {
  video.pause();
  video.currentTime = timeOf(Math.min(lastFrame(), Math.max(0, f)));
  renderFrameState();
}

// ---- undo / persistence --------------------------------------------------
const snapshot = () => JSON.stringify(data);
function restore(s) { Object.assign(data, JSON.parse(s)); renderAll(); scheduleSave(); }
function commit() { ui.undo.push(snapshot()); if (ui.undo.length > 100) ui.undo.shift(); ui.redo = []; }
function undo() { if (!ui.undo.length) return; ui.redo.push(snapshot()); restore(ui.undo.pop()); }
function redo() { if (!ui.redo.length) return; ui.undo.push(snapshot()); restore(ui.redo.pop()); }

let saveTimer = null;
function scheduleSave() {
  $('save-state').textContent = 'unsaved…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}
async function save() {
  if (!ui.video) return;
  try {
    const r = await fetch(`/api/session?video=${encodeURIComponent(ui.video)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, ...data }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    $('save-state').textContent = 'saved';
  } catch (err) { $('save-state').textContent = `save failed: ${err.message}`; }
}
function mutate(fn) { commit(); fn(); renderAll(); scheduleSave(); }

// ---- loading -------------------------------------------------------------
async function loadVideoList() {
  const { videos, initial } = await (await fetch('/api/videos')).json();
  const pick = $('video-pick');
  pick.replaceChildren(el('option', { value: '' }, videos.length ? 'Choose a video…' : 'No videos found in project'),
    ...videos.map((v) => el('option', { value: v }, v)));
  const want = new URLSearchParams(location.search).get('video') || initial;
  if (want) { pick.value = want; if (pick.value === want) await loadVideo(want); }
}
async function loadVideo(rel) {
  if (saveTimer) { clearTimeout(saveTimer); await save(); }
  ui.video = rel; ui.undo = []; ui.redo = []; ui.sel = { kind: null, id: null }; ui.pendingIn = null;
  ui.view = 'source'; ui.resultSrc = null;
  history.replaceState(null, '', `?video=${encodeURIComponent(rel)}`);
  const [meta, sess] = await Promise.all([
    fetch(`/api/probe?video=${encodeURIComponent(rel)}`).then((r) => r.json()),
    fetch(`/api/session?video=${encodeURIComponent(rel)}`).then((r) => r.json()),
  ]);
  ui.meta = { ...ui.meta, ...meta };
  for (const k of Object.keys(data)) data[k] = Array.isArray(sess[k]) ? sess[k] : [];
  // Jobs don't survive a server restart; anything left "running" is stale.
  for (const kf of data.keyframes) if (kf.status === 'running') kf.status = null;
  data.renders = data.renders.filter((r) => r.status !== 'running');
  if (meta.width && meta.height) stage.style.aspectRatio = `${meta.width} / ${meta.height}`;
  $('meta').textContent = [meta.width && `${meta.width}×${meta.height}`, `${+fps().toFixed(3)} fps`,
    meta.frames && `${meta.frames} frames`].filter(Boolean).join(' · ');
  setSource(`/media/${rel.split('/').map(encodeURIComponent).join('/')}`);
  $('save-state').textContent = sess.savedAt ? 'saved' : '';
  renderAll();
}
function setSource(src) {
  const f = ui.video && video.src ? curFrame() : 0;
  video.src = src;
  video.addEventListener('loadedmetadata', () => { if (!ui.meta.duration) ui.meta.duration = video.duration; seekFrame(f); renderTimeline(); }, { once: true });
}

// ---- transport -----------------------------------------------------------
function loopBounds() {
  const m = ui.sel.kind === 'mark' && markById(ui.sel.id);
  if (m && m.kind === 'range') return [m.start, m.end];
  return [0, lastFrame()];
}
function togglePlay() {
  if (!video.src) return;
  if (video.paused) {
    const [a, b] = loopBounds();
    const f = curFrame();
    if (ui.loop && (f < a || f >= b)) video.currentTime = timeOf(a);
    video.play();
  } else video.pause();
}
function onTick() {
  if (!video.paused && ui.loop) {
    const [a, b] = loopBounds();
    if (curFrame() > b || video.ended) { video.currentTime = timeOf(a); if (video.paused) video.play(); }
  }
  if (!video.paused) renderFrameState();
  requestAnimationFrame(onTick);
}
video.addEventListener('ended', () => { if (ui.loop) { video.currentTime = timeOf(loopBounds()[0]); video.play(); } });
video.addEventListener('play', () => { $('play').textContent = '❚❚'; });
video.addEventListener('pause', () => { $('play').textContent = '▶︎'; renderFrameState(); });
video.addEventListener('seeked', renderFrameState);

// ---- marks ---------------------------------------------------------------
function addFrameMark() {
  const f = curFrame(); const m = { id: uid('m'), kind: 'frame', start: f, end: f, label: '' };
  mutate(() => { data.marks.push(m); ui.sel = { kind: 'mark', id: m.id }; });
}
function setIn() { ui.pendingIn = curFrame(); renderTimeline(); toast(`In at frame ${ui.pendingIn} — press O to close the range`); }
function setOut() {
  const f = curFrame();
  if (ui.pendingIn == null) return toast('Set an In point first (I)');
  addRange(ui.pendingIn, f); ui.pendingIn = null;
}
function addRange(a, b) {
  const [s, e] = a <= b ? [a, b] : [b, a];
  const m = { id: uid('m'), kind: s === e ? 'frame' : 'range', start: s, end: e, label: '' };
  mutate(() => { data.marks.push(m); ui.sel = { kind: 'mark', id: m.id }; });
}
function select(kind, id) {
  ui.sel = ui.sel.kind === kind && ui.sel.id === id ? { kind: null, id: null } : { kind, id };
  renderAll();
}

// ---- timeline ------------------------------------------------------------
const xOfFrame = (f) => `${(lastFrame() ? f / (lastFrame() + 1) : 0) * 100}%`;
function frameAtX(clientX) {
  const r = lanes.getBoundingClientRect();
  const u = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  return Math.min(lastFrame(), Math.floor(u * (lastFrame() + 1)));
}
function renderTimeline() {
  const n = lastFrame() + 1; const d = dur();
  // Ruler: pick a second step so labels don't collide.
  const ruler = $('ruler'); ruler.replaceChildren();
  if (d > 0) {
    const w = lanes.clientWidth || 800;
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => (w / d) * s >= 70) || 300;
    for (let t = 0; t <= d + 1e-6; t += step) ruler.append(el('div', { class: 'tick', style: { left: xOfFrame(frameOf(t)) } }, el('span', {}, fmt(t).replace(/^00:/, ''))));
    const pxPerFrame = w / n;
    if (pxPerFrame >= 6) for (let f = 0; f < n; f++) ruler.append(el('div', { class: 'tick minor', style: { left: xOfFrame(f) } }));
  }
  // Marks: ranges under frame marks.
  const lm = $('lane-marks'); lm.replaceChildren();
  const sorted = [...data.marks].sort((a, b) => (a.kind === 'range' ? 0 : 1) - (b.kind === 'range' ? 0 : 1));
  for (const m of sorted) {
    const sel = ui.sel.kind === 'mark' && ui.sel.id === m.id;
    const node = el('div', {
      class: `mark ${m.kind}${sel ? ' sel' : ''}`, title: markLabel(m),
      style: { left: xOfFrame(m.start), ...(m.kind === 'range' ? { width: `calc(${xOfFrame(m.end + 1)} - ${xOfFrame(m.start)})` } : {}) },
    });
    node.addEventListener('pointerdown', (e) => { e.stopPropagation(); select('mark', m.id); if (!sel) seekFrame(m.start); });
    if (m.kind === 'range' && sel) {
      for (const side of ['l', 'r']) {
        const h = el('div', { class: `h ${side}` });
        h.addEventListener('pointerdown', (e) => { e.stopPropagation(); dragHandle(e, m, side); });
        node.append(h);
      }
    }
    lm.append(node);
  }
  const pin = $('pending-in');
  pin.style.display = ui.pendingIn == null ? 'none' : 'block';
  if (ui.pendingIn != null) pin.style.left = xOfFrame(ui.pendingIn);
  // Annotation dots.
  const la = $('lane-ann'); la.replaceChildren();
  for (const a of data.annotations) {
    const sel = ui.sel.kind === 'ann' && ui.sel.id === a.id;
    la.append(el('div', { class: `dot${sel ? ' sel' : ''}`, title: annLabel(a), style: { left: xOfFrame(a.frame + 0.5), background: a.strokes[0]?.color || 'var(--ink)' },
      onpointerdown: (e) => { e.stopPropagation(); select('ann', a.id); seekFrame(a.frame); } }));
  }
  // Keyframe diamonds.
  const lk = $('lane-kf'); lk.replaceChildren();
  for (const k of data.keyframes) {
    const has = k.versions.length > 0;
    lk.append(el('div', { class: `diamond${has ? '' : ' empty'}${k.status === 'running' ? ' busy' : ''}`, title: `Keyframe f${k.frame}`,
      style: { left: xOfFrame(k.frame + 0.5) }, onpointerdown: (e) => { e.stopPropagation(); seekFrame(k.frame); } }));
  }
  $('playhead').style.left = xOfFrame(curFrame() + 0.5);
}
function dragHandle(e, m, side) {
  commit();
  const move = (ev) => {
    const f = frameAtX(ev.clientX);
    if (side === 'l') m.start = Math.min(f, m.end); else m.end = Math.max(f, m.start);
    seekFrame(side === 'l' ? m.start : m.end); renderTimeline();
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); renderAll(); scheduleSave(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
// Scrub: ruler / ink / key lanes. Marks lane: drag creates a range, click a frame mark.
function scrubFrom(e) {
  if (!video.src) return;
  video.pause(); seekFrame(frameAtX(e.clientX));
  const move = (ev) => seekFrame(frameAtX(ev.clientX));
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
for (const id of ['ruler', 'lane-ann', 'lane-kf']) $(id).addEventListener('pointerdown', scrubFrom);
$('lane-marks').addEventListener('pointerdown', (e) => {
  if (!video.src) return;
  const a = frameAtX(e.clientX); let b = a;
  seekFrame(a);
  const ghost = el('div', { class: 'mark range sel', style: { left: xOfFrame(a), width: '0' } });
  $('lane-marks').append(ghost);
  const move = (ev) => {
    b = frameAtX(ev.clientX); const [s, t] = a <= b ? [a, b] : [b, a];
    ghost.style.left = xOfFrame(s); ghost.style.width = `calc(${xOfFrame(t + 1)} - ${xOfFrame(s)})`;
    seekFrame(b);
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    ghost.remove();
    if (a !== b) addRange(a, b); else { ui.sel = { kind: null, id: null }; renderAll(); }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});

// ---- ink (annotations) ---------------------------------------------------
// An annotation is drawn on one frame; if made while a range is selected that
// contains the frame, it is linked to that range and shows across all of it.
function visibleAnnotations(f) {
  return data.annotations.filter((a) => a.frame === f || (a.markId && markById(a.markId) && inMark(markById(a.markId), f)));
}
function sizeCanvas() {
  const r = ink.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  const w = Math.round(r.width * dpr); const h = Math.round(r.height * dpr);
  if (ink.width !== w || ink.height !== h) { ink.width = w; ink.height = h; }
}
function drawStroke(ctx, s, alpha = 1) {
  const W = ink.width; const H = ink.height;
  ctx.globalAlpha = alpha; ctx.strokeStyle = s.color; ctx.lineWidth = s.width * (W / 1000);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
  s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
  if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * W + 0.1, s.pts[0][1] * H);
  ctx.stroke(); ctx.globalAlpha = 1;
}
function renderInk() {
  sizeCanvas();
  const ctx = ink.getContext('2d'); ctx.clearRect(0, 0, ink.width, ink.height);
  if (!$('show-ann').checked) return;
  const f = curFrame();
  for (const a of visibleAnnotations(f)) {
    const dim = ui.sel.kind === 'ann' && ui.sel.id !== a.id ? 0.45 : 1;
    for (const s of a.strokes) drawStroke(ctx, s, a.frame === f ? dim : dim * 0.6);
  }
  if (ui.drawing) drawStroke(ctx, ui.drawing);
}
const normPt = (e) => { const r = ink.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height].map((v) => Math.min(1, Math.max(0, v))); };
ink.addEventListener('pointerdown', (e) => {
  if (!video.src) return;
  if (ui.tool === 'none') { togglePlay(); return; }
  video.pause(); ink.setPointerCapture(e.pointerId);
  if (ui.tool === 'erase') { commit(); eraseAt(normPt(e)); const mv = (ev) => eraseAt(normPt(ev)); ink.addEventListener('pointermove', mv); ink.addEventListener('pointerup', () => { ink.removeEventListener('pointermove', mv); renderAll(); scheduleSave(); }, { once: true }); return; }
  ui.drawing = { color: ui.color, width: ui.size, pts: [normPt(e)] };
  const mv = (ev) => { ui.drawing.pts.push(normPt(ev)); renderInk(); };
  ink.addEventListener('pointermove', mv);
  ink.addEventListener('pointerup', () => { ink.removeEventListener('pointermove', mv); finishStroke(); }, { once: true });
});
function finishStroke() {
  const s = ui.drawing; ui.drawing = null;
  if (!s) return;
  s.pts = s.pts.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
  const f = curFrame();
  const selMark = ui.sel.kind === 'mark' ? markById(ui.sel.id) : null;
  const markId = selMark && inMark(selMark, f) ? selMark.id : null;
  mutate(() => {
    let a = ui.sel.kind === 'ann' ? annById(ui.sel.id) : null;
    if (!a || a.frame !== f) a = data.annotations.find((x) => x.frame === f && x.markId === markId);
    if (!a) { a = { id: uid('a'), frame: f, markId, label: '', strokes: [] }; data.annotations.push(a); }
    a.strokes.push(s);
    if (ui.sel.kind !== 'mark') ui.sel = { kind: 'ann', id: a.id };
  });
}
function eraseAt([x, y]) {
  const r = 0.02; const f = curFrame();
  for (const a of visibleAnnotations(f)) a.strokes = a.strokes.filter((s) => !s.pts.some(([px, py]) => Math.hypot(px - x, (py - y) * (ui.meta.height / ui.meta.width || 1)) < r));
  data.annotations = data.annotations.filter((a) => a.strokes.length);
  renderInk();
}

// ---- prompts -------------------------------------------------------------
function addPrompt() {
  const p = { id: uid('p'), text: '', markIds: [], annIds: [] };
  if (ui.sel.kind === 'mark') p.markIds.push(ui.sel.id);
  if (ui.sel.kind === 'ann') p.annIds.push(ui.sel.id);
  mutate(() => data.prompts.push(p));
  requestAnimationFrame(() => document.querySelector(`[data-prompt="${p.id}"] textarea`)?.focus());
}
// Prompts that apply at frame f: linked to a mark containing f, to an
// annotation visible at f, or unlinked (global).
function promptsAt(f) {
  const vis = new Set(visibleAnnotations(f).map((a) => a.id));
  return data.prompts.filter((p) => p.text.trim() && ((!p.markIds.length && !p.annIds.length)
    || p.markIds.some((id) => markById(id) && inMark(markById(id), f)) || p.annIds.some((id) => vis.has(id))));
}
function renderPrompts() {
  const box = $('prompt-list'); box.replaceChildren();
  if (!data.prompts.length) box.append(el('div', { class: 'empty' }, 'Select a mark or annotation, then + Prompt. Unlinked prompts apply to the whole video.'));
  for (const p of data.prompts) {
    const linked = (ui.sel.kind === 'mark' && p.markIds.includes(ui.sel.id)) || (ui.sel.kind === 'ann' && p.annIds.includes(ui.sel.id));
    const ta = el('textarea', { placeholder: 'Describe the edit…' }); ta.value = p.text;
    ta.addEventListener('focus', () => commit());
    ta.addEventListener('input', () => { p.text = ta.value; scheduleSave(); });
    const chips = [
      ...p.markIds.map((id) => [id, markById(id) && markLabel(markById(id)), 'var(--accent)', 'markIds']),
      ...p.annIds.map((id) => [id, annById(id) && annLabel(annById(id)), annById(id)?.strokes[0]?.color, 'annIds']),
    ].filter(([, label]) => label).map(([id, label, color, key]) => el('span', { class: 'chip' },
      el('span', { class: 'chip-dot', style: { background: color } }), label,
      el('button', { class: 'x', title: 'Unlink', onclick: () => mutate(() => { p[key] = p[key].filter((x) => x !== id); }) }, '×')));
    const opts = [
      ...data.marks.filter((m) => !p.markIds.includes(m.id)).map((m) => el('option', { value: `m:${m.id}` }, markLabel(m))),
      ...data.annotations.filter((a) => !p.annIds.includes(a.id)).map((a) => el('option', { value: `a:${a.id}` }, annLabel(a))),
    ];
    const link = el('select', {}, el('option', { value: '' }, '+ link…'), ...opts);
    link.addEventListener('change', () => {
      const [k, id] = link.value.split(':');
      if (id) mutate(() => (k === 'm' ? p.markIds : p.annIds).push(id));
    });
    box.append(el('div', { class: `prompt${linked ? ' sel' : ''}`, 'data-prompt': p.id }, ta,
      el('div', { class: 'links' }, chips.length ? chips : el('span', { class: 'chip global' }, 'whole video'), opts.length ? link : null),
      el('div', { class: 'row' }, el('button', { class: 'x', onclick: () => mutate(() => { data.prompts = data.prompts.filter((x) => x !== p); }) }, 'Delete'))));
  }
}

// ---- lists ---------------------------------------------------------------
function renameInput(obj, fallback) {
  const i = el('input', { type: 'text', placeholder: fallback }); i.value = obj.label || '';
  i.addEventListener('focus', () => commit());
  i.addEventListener('input', () => { obj.label = i.value; scheduleSave(); renderTimeline(); });
  i.addEventListener('pointerdown', (e) => e.stopPropagation());
  i.addEventListener('keydown', (e) => e.stopPropagation());
  return i;
}
function renderLists() {
  const ml = $('marks-list'); ml.replaceChildren();
  if (!data.marks.length) ml.append(el('li', { class: 'empty' }, 'M marks a frame · I/O or drag the Marks lane for a range'));
  for (const m of [...data.marks].sort((a, b) => a.start - b.start)) {
    const sel = ui.sel.kind === 'mark' && ui.sel.id === m.id;
    ml.append(el('li', { class: sel ? 'sel' : '', onclick: () => { select('mark', m.id); seekFrame(m.start); } },
      el('span', { class: 'chip-dot', style: { background: m.kind === 'range' ? 'var(--accent)' : 'var(--frame)' } }),
      renameInput(m, markLabel({ ...m, label: '' })),
      el('span', { class: 'dim' }, m.kind === 'range' ? `${m.end - m.start + 1}f` : ''),
      el('button', { class: 'x', title: 'Delete mark', onclick: (e) => { e.stopPropagation(); deleteMark(m.id); } }, '×')));
  }
  const al = $('ann-list'); al.replaceChildren();
  if (!data.annotations.length) al.append(el('li', { class: 'empty' }, 'Pen (B) to scribble on a frame; with a range selected, ink spans the range'));
  for (const a of [...data.annotations].sort((x, y) => x.frame - y.frame)) {
    const sel = ui.sel.kind === 'ann' && ui.sel.id === a.id;
    const span = a.markId && markById(a.markId);
    al.append(el('li', { class: sel ? 'sel' : '', onclick: () => { select('ann', a.id); seekFrame(a.frame); } },
      el('span', { class: 'chip-dot', style: { background: a.strokes[0]?.color } }),
      renameInput(a, annLabel({ ...a, label: '' })),
      el('span', { class: 'dim' }, span ? `↔ ${markLabel(span)}` : `${a.strokes.length} st`),
      el('button', { class: 'x', title: 'Delete annotation', onclick: (e) => { e.stopPropagation(); deleteAnn(a.id); } }, '×')));
  }
}
function deleteMark(id) {
  mutate(() => {
    data.marks = data.marks.filter((m) => m.id !== id);
    for (const p of data.prompts) p.markIds = p.markIds.filter((x) => x !== id);
    for (const a of data.annotations) if (a.markId === id) a.markId = null;
    if (ui.sel.id === id) ui.sel = { kind: null, id: null };
  });
}
function deleteAnn(id) {
  mutate(() => {
    data.annotations = data.annotations.filter((a) => a.id !== id);
    for (const p of data.prompts) p.annIds = p.annIds.filter((x) => x !== id);
    if (ui.sel.id === id) ui.sel = { kind: null, id: null };
  });
}

// ---- generation ----------------------------------------------------------
async function startJob(body) {
  const r = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ video: ui.video, ...body }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  for (;;) {
    await new Promise((res) => setTimeout(res, 700));
    const s = await (await fetch(`/api/jobs/${j.jobId}`)).json();
    if (s.status === 'done') return s;
    if (s.status !== 'running') throw new Error(s.error || s.status);
  }
}
const mediaUrl = (rel) => `/media/${rel.split('/').map(encodeURIComponent).join('/')}?v=${Date.now()}`;
function addKeyframe() {
  const f = curFrame();
  if (data.keyframes.some((k) => k.frame === f)) return toast(`Frame ${f} already has a keyframe`);
  mutate(() => data.keyframes.push({ id: uid('k'), frame: f, versions: [], current: -1, status: null }));
}
async function generateKeyframe(k) {
  if (k.status === 'running') return;
  const prompts = promptsAt(k.frame);
  if (!prompts.length) toast('No prompts apply to this frame — generating with annotations only');
  k.status = 'running'; k.error = null; renderAll();
  const vis = visibleAnnotations(k.frame).map((a) => a.id);
  try {
    const res = await startJob({
      kind: 'keyframe', time: timeOf(k.frame), frame: k.frame, fps: fps(),
      prompts, annotations: data.annotations.filter((a) => vis.includes(a.id)),
      marks: data.marks.filter((m) => inMark(m, k.frame)),
    });
    commit();
    k.versions.push({ output: res.output, stub: !!res.stub, note: res.note || '', at: new Date().toISOString() });
    k.current = k.versions.length - 1; k.status = null;
    if (res.note) toast(res.note);
  } catch (err) { k.status = 'error'; k.error = err.message; }
  renderAll(); scheduleSave();
}
async function generateVideo() {
  if (!ui.video) return;
  const r = { id: uid('r'), status: 'running', at: new Date().toISOString() };
  data.renders.unshift(r); renderAll();
  try {
    const res = await startJob({
      kind: 'video', fps: fps(), prompts: data.prompts.filter((p) => p.text.trim()),
      annotations: data.annotations, marks: data.marks,
      keyframes: data.keyframes.filter((k) => k.current >= 0).map((k) => ({ frame: k.frame, time: timeOf(k.frame), image: k.versions[k.current].output })),
    });
    Object.assign(r, { status: 'done', output: res.output, stub: !!res.stub, note: res.note || '' });
    showResult(r);
    if (res.note) toast(res.note);
  } catch (err) { Object.assign(r, { status: 'error', error: err.message }); }
  renderAll(); scheduleSave();
}
function showResult(r) { ui.view = 'result'; ui.resultSrc = r.output; setSource(mediaUrl(r.output)); renderAll(); }
function showSource() { ui.view = 'source'; setSource(`/media/${ui.video.split('/').map(encodeURIComponent).join('/')}`); renderAll(); }

function renderKeyframes() {
  const box = $('kf-list'); box.replaceChildren(); const f = curFrame();
  if (!data.keyframes.length) box.append(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, 'K adds a keyframe at the current frame'));
  for (const k of [...data.keyframes].sort((a, b) => a.frame - b.frame)) {
    const v = k.versions[k.current];
    const thumb = el('div', { class: 'thumb', title: 'Go to frame', onclick: () => seekFrame(k.frame),
      style: v ? { backgroundImage: `url("${mediaUrl(v.output)}")` } : {} }, v ? '' : (k.status === 'running' ? 'generating…' : 'not generated'));
    const status = k.status === 'error' ? el('div', { class: 'status err', style: { padding: '0 6px 4px' } }, k.error)
      : v && v.stub ? el('div', { class: 'status stub', style: { padding: '0 6px 4px' } }, 'placeholder (stub)') : null;
    box.append(el('div', { class: `kf-card${k.frame === f ? ' here' : ''}` }, thumb,
      el('div', { class: 'bar' },
        el('span', { class: 'grow' }, `f${k.frame}`),
        k.versions.length > 1 ? el('button', { title: 'Previous version', disabled: k.current <= 0, onclick: () => mutate(() => { k.current--; }) }, '‹') : null,
        k.versions.length > 1 ? el('span', { class: 'dim' }, `${k.current + 1}/${k.versions.length}`) : null,
        k.versions.length > 1 ? el('button', { title: 'Next version', disabled: k.current >= k.versions.length - 1, onclick: () => mutate(() => { k.current++; }) }, '›') : null,
        el('button', { disabled: k.status === 'running', onclick: () => generateKeyframe(k) }, k.versions.length ? 'Regen' : 'Gen'),
        el('button', { class: 'x', title: 'Delete keyframe', onclick: () => mutate(() => { data.keyframes = data.keyframes.filter((x) => x !== k); }) }, '×')),
      status));
  }
}
function renderRenders() {
  const ul = $('render-list'); ul.replaceChildren();
  if (!data.renders.length) ul.append(el('li', { class: 'empty' }, 'Generate video to produce a result'));
  data.renders.forEach((r, i) => {
    const n = data.renders.length - i;
    const on = ui.view === 'result' && r.output && ui.resultSrc === r.output;
    ul.append(el('li', { class: on ? 'sel' : '', onclick: () => r.status === 'done' && showResult(r) },
      el('span', { class: 'grow' }, `Result v${n}`),
      el('span', { class: `status${r.status === 'error' ? ' err' : r.stub ? ' stub' : ''}` },
        r.status === 'running' ? 'generating…' : r.status === 'error' ? r.error : r.stub ? 'stub' : new Date(r.at).toLocaleTimeString()),
      el('button', { class: 'x', title: 'Remove from list', onclick: (e) => { e.stopPropagation(); mutate(() => { data.renders = data.renders.filter((x) => x !== r); }); } }, '×')));
  });
  $('gen-video').disabled = !ui.video || data.renders.some((r) => r.status === 'running');
}

// ---- per-frame view ------------------------------------------------------
let lastRendered = -1;
function renderFrameState() {
  const f = curFrame();
  $('tc').textContent = fmt(video.currentTime || 0);
  $('fc').textContent = `f ${f} / ${lastFrame()}`;
  $('playhead').style.left = xOfFrame(f + 0.5);
  const k = data.keyframes.find((x) => x.frame === f && x.current >= 0);
  const img = $('kf-overlay');
  if (k && $('show-kf').checked && ui.view === 'source') {
    const src = mediaUrl(k.versions[k.current].output).split('?')[0];
    if (!img.src.endsWith(src)) img.src = src;
    img.style.display = 'block'; img.style.opacity = $('kf-opacity').value / 100;
  } else img.style.display = 'none';
  renderInk();
  if (f !== lastRendered) { lastRendered = f; if (video.paused) renderKeyframes(); }
}
function renderAll() {
  stage.className = `stage tool-${ui.tool}`;
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === ui.tool);
  for (const b of document.querySelectorAll('.swatch')) b.classList.toggle('on', b.dataset.color === ui.color);
  $('loop').classList.toggle('on', ui.loop);
  $('view-source').classList.toggle('on', ui.view === 'source');
  $('view-result').classList.toggle('on', ui.view === 'result');
  $('view-result').disabled = !data.renders.some((r) => r.status === 'done');
  $('view-badge').textContent = ui.view === 'result' ? 'Result' : '';
  $('undo').disabled = !ui.undo.length; $('redo').disabled = !ui.redo.length;
  renderTimeline(); renderLists(); renderPrompts(); renderKeyframes(); renderRenders(); renderFrameState();
}

// ---- wiring --------------------------------------------------------------
function setTool(t) { ui.tool = t; renderAll(); }
for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
$('swatches').append(...COLORS.map((c) => el('button', { class: 'swatch', 'data-color': c, style: { background: c }, title: c,
  onclick: () => { ui.color = c; if (ui.tool !== 'pen') ui.tool = 'pen'; renderAll(); } })));
$('pen-size').addEventListener('input', (e) => { ui.size = +e.target.value; });
for (const id of ['show-ann', 'show-kf', 'kf-opacity']) $(id).addEventListener('input', renderFrameState);
$('play').addEventListener('click', togglePlay);
$('step-back').addEventListener('click', () => seekFrame(curFrame() - 1));
$('step-fwd').addEventListener('click', () => seekFrame(curFrame() + 1));
$('to-start').addEventListener('click', () => seekFrame(loopBounds()[0]));
$('to-end').addEventListener('click', () => seekFrame(loopBounds()[1]));
$('loop').addEventListener('click', () => { ui.loop = !ui.loop; renderAll(); });
$('mark-frame').addEventListener('click', addFrameMark);
$('mark-in').addEventListener('click', setIn);
$('mark-out').addEventListener('click', setOut);
$('add-kf').addEventListener('click', addKeyframe);
$('add-prompt').addEventListener('click', addPrompt);
$('gen-video').addEventListener('click', generateVideo);
$('view-source').addEventListener('click', () => ui.view !== 'source' && showSource());
$('view-result').addEventListener('click', () => { const r = data.renders.find((x) => x.status === 'done'); if (r && ui.view !== 'result') showResult(r); });
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('video-pick').addEventListener('change', (e) => e.target.value && loadVideo(e.target.value));
window.addEventListener('resize', () => { renderTimeline(); renderInk(); });

window.addEventListener('keydown', (e) => {
  if (e.target.matches('textarea, input[type=text], select')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod) return;
  const step = e.shiftKey ? Math.round(fps()) : 1;
  const keys = {
    ' ': togglePlay, ArrowLeft: () => seekFrame(curFrame() - step), ArrowRight: () => seekFrame(curFrame() + step),
    Home: () => seekFrame(loopBounds()[0]), End: () => seekFrame(loopBounds()[1]),
    l: () => { ui.loop = !ui.loop; renderAll(); }, m: addFrameMark, i: setIn, o: setOut, k: addKeyframe,
    b: () => setTool('pen'), e: () => setTool('erase'), v: () => setTool('none'),
    Escape: () => { ui.pendingIn = null; ui.sel = { kind: null, id: null }; renderAll(); },
    Backspace: () => { if (ui.sel.kind === 'mark') deleteMark(ui.sel.id); else if (ui.sel.kind === 'ann') deleteAnn(ui.sel.id); },
  };
  const fn = keys[e.key] || keys[e.key.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
});
window.addEventListener('beforeunload', () => { if (saveTimer) save(); });

renderAll();
onTick();
loadVideoList().catch((err) => toast(`load failed: ${err.message}`, 5000));
