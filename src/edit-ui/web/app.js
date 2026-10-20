// src/edit-ui/web/app.js
// Targeted-edit UI. The user opens a video (uploaded into the server's workspace);
// everything hangs off *marks* (a frame or a frame range) on the timeline:
// scribbled annotations, prompts and keyframes all belong to a mark (shown on
// the Marks / Ink / Keys lanes). Unlinked prompts apply to the whole video. Session state autosaves to the server.
const $ = (id) => document.getElementById(id);
const video = $('video'); const video2 = $('video2'); const ink = $('ink'); const stage = $('stage'); const lanes = $('lanes');
const COLORS = ['#ff4d6d', '#ffc43d', '#4cc38a', '#5aa9ff', '#c78bff', '#ffffff'];
const ICONS = {
  ink: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12c2-1 3-5 5-5s1 4 3 4 3-3 4-5"/></svg>',
  prompt: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v8H7l-3 3v-3H2z"/></svg>',
  kf: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l7 7-7 7-7-7z"/></svg>',
};

// ---- state ---------------------------------------------------------------
// marks:       { id, kind: 'frame'|'range', start, end, label }        (frames)
// annotations: { id, markId, frame, strokes: [{ color, width, pts }] }
// prompts:     { id, markId | null, text }
// keyframes:   { id, markId, frame, versions: [{ output, source, stub, note, at }], current, status, error }
// renders:     { id, status, run, output, stub, note, at }
// dialogue:    null | { original, text, include }   (transcript; text is the user's edit)
// settings:    { autoKeyframes }
const data = { marks: [], annotations: [], prompts: [], keyframes: [], renders: [], dialogue: null, settings: { autoKeyframes: 0, styleLock: '' } }; // persisted
const ui = {
  id: null, src: null, name: '', meta: { fps: 24, duration: 0, width: 16, height: 9, hasAudio: false }, peaks: null, resultPeaks: null,
  tool: 'none', color: COLORS[0], size: 5, loop: true,
  sel: null, pendingIn: null, view: 'source', resultSrc: null, compare: null,
  undo: [], redo: [], drawing: null, kfUploadTarget: null,
};
const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// ---- helpers -------------------------------------------------------------
const fps = () => ui.meta.fps || 24;
// In result view the timeline is scoped to the result clip itself (its own duration), not the
// source — a window result is a short edit, so showing it against the full source timeline is wrong.
const dur = () => (ui.view === 'result' ? (video.duration || 0) : (ui.meta.duration || video.duration || 0));
const lastFrame = () => Math.max(0, Math.round(dur() * fps()) - 1);
const frameOf = (t) => Math.min(lastFrame(), Math.max(0, Math.floor(t * fps() + 1e-4)));
const timeOf = (f) => (f + 0.5) / fps(); // mid-frame: robust against decoder rounding
const curFrame = () => frameOf(video.currentTime);
function fmt(t) {
  const m = Math.floor(t / 60); const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}
function toast(msg, ms = 2400) {
  const n = $('toast'); n.textContent = msg; n.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => n.classList.remove('show'), ms);
}
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') Object.assign(n.style, v);
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}
const fileUrl = (rel, bust) => `/files/${rel.split('/').map(encodeURIComponent).join('/')}${bust ? `?v=${bust}` : ''}`;
const markById = (id) => data.marks.find((m) => m.id === id);
const selMark = () => (ui.sel ? markById(ui.sel) : null);
const markLabel = (m) => m.label || (m.kind === 'frame' ? `Frame ${m.start}` : `Frames ${m.start}–${m.end}`);
const inMark = (m, f) => f >= m.start && f <= m.end;
const annsOf = (m) => data.annotations.filter((a) => a.markId === m.id);
const promptsOf = (m) => data.prompts.filter((p) => p.markId === m.id);
const kfsOf = (m) => data.keyframes.filter((k) => k.markId === m.id).sort((a, b) => a.frame - b.frame);
const hasContent = (m) => annsOf(m).length || promptsOf(m).length || kfsOf(m).length;

function seekFrame(f) {
  if (!ui.src) return;
  video.pause();
  const t = timeOf(Math.min(lastFrame(), Math.max(0, f)));
  video.currentTime = t;
  if (ui.compare) { video2.pause(); video2.currentTime = t; } // keep the compare pane in lock-step
  renderFrameState();
}

// ---- undo / persistence --------------------------------------------------
const snapshot = () => JSON.stringify(data);
function restore(s) { Object.assign(data, JSON.parse(s)); if (ui.sel && !selMark()) ui.sel = null; renderAll(); scheduleSave(); }
function commit() { ui.undo.push(snapshot()); if (ui.undo.length > 100) ui.undo.shift(); ui.redo = []; }
function undo() { if (!ui.undo.length) return; ui.redo.push(snapshot()); restore(ui.undo.pop()); }
function redo() { if (!ui.redo.length) return; ui.undo.push(snapshot()); restore(ui.redo.pop()); }

let saveTimer = null;
function scheduleSave() {
  if (!ui.id) return;
  $('save-state').textContent = 'unsaved…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}
async function save() {
  saveTimer = null;
  if (!ui.id) return;
  try {
    const r = await fetch(`/api/session?id=${ui.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 2, ...data }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    $('save-state').textContent = 'saved';
  } catch (err) { $('save-state').textContent = `save failed: ${err.message}`; }
}
function mutate(fn) { commit(); fn(); renderAll(); scheduleSave(); }

// ---- opening -------------------------------------------------------------
function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    if (onProgress) x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let j = {}; try { j = JSON.parse(x.responseText); } catch { /* non-JSON */ }
      return x.status < 300 ? resolve(j) : reject(new Error(j.error || `HTTP ${x.status}`));
    };
    x.onerror = () => reject(new Error('network error'));
    x.send(file);
  });
}
async function openFile(file) {
  if (!file) return;
  const bar = $('progress');
  bar.style.display = 'block';
  const setP = (u, label) => { bar.firstElementChild.style.width = `${u * 100}%`; bar.lastElementChild.textContent = label; };
  setP(0, `Uploading ${file.name}…`);
  try {
    const meta = await upload('/api/open', file, (u) => setP(u, u < 1 ? `Uploading ${file.name} — ${Math.round(u * 100)}%` : 'Importing…'));
    await loadVideo(meta.id);
  } catch (err) { toast(`open failed: ${err.message}`, 5000); }
  bar.style.display = 'none';
}
async function loadVideo(id) {
  if (saveTimer) { clearTimeout(saveTimer); await save(); }
  const [meta, sess] = await Promise.all([
    fetch(`/api/video?id=${id}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('unknown video')))),
    fetch(`/api/session?id=${id}`).then((r) => r.json()),
  ]);
  Object.assign(ui, { id, src: meta.src, name: meta.name, meta, peaks: null, undo: [], redo: [], sel: null, pendingIn: null, view: 'source', resultSrc: null, compare: null });
  history.replaceState(null, '', `?id=${id}`);
  for (const k of ['marks', 'annotations', 'prompts', 'keyframes', 'renders']) data[k] = Array.isArray(sess[k]) ? sess[k] : [];
  data.dialogue = sess.dialogue && typeof sess.dialogue.text === 'string' ? sess.dialogue : null;
  data.settings = { autoKeyframes: 0, styleLock: '', ...(sess.settings || {}) };
  ui.transcribing = false;
  // Jobs don't survive a server restart; anything left "running" is stale.
  for (const kf of data.keyframes) if (kf.status === 'running') kf.status = null;
  data.renders = data.renders.filter((r) => r.status !== 'running');
  if (meta.width && meta.height) stage.style.aspectRatio = `${meta.width} / ${meta.height}`;
  $('file-name').textContent = meta.name;
  document.title = `${meta.name} — Edit`;
  $('meta').textContent = [meta.width && `${meta.width}×${meta.height}`, `${+fps().toFixed(3)} fps`,
    meta.frames && `${meta.frames} frames`, meta.hasAudio ? 'audio' : 'no audio'].filter(Boolean).join(' · ');
  $('auto-kf').value = data.settings.autoKeyframes;
  $('style-lock').value = data.settings.styleLock || '';
  $('welcome').style.display = 'none';
  $('save-state').textContent = sess.savedAt ? 'saved' : '';
  setSource(meta.src);
  renderAll();
  if (meta.hasAudio) {
    fetch(`/api/waveform?id=${id}`).then((r) => r.json()).then((w) => { if (ui.id === id) { ui.peaks = w.peaks; renderWave(); } });
  }
}
function setSource(src) {
  const f = video.src ? curFrame() : 0;
  video.src = src;
  // Switching src stops playback without firing a 'pause' event, so sync the button explicitly.
  $('play').textContent = '▶︎';
  video.addEventListener('loadedmetadata', () => { if (!ui.meta.duration) ui.meta.duration = video.duration; seekFrame(f); renderTimeline(); }, { once: true });
}
async function showWelcome() {
  $('welcome').style.display = 'flex';
  const { recent, initial } = await (await fetch('/api/recent')).json();
  const want = new URLSearchParams(location.search).get('id') || initial;
  if (want && recent.some((r) => r.id === want)) return loadVideo(want);
  $('recent').replaceChildren(...(recent.length ? [el('h3', {}, 'Recent'),
    ...recent.map((r) => el('button', { onclick: () => loadVideo(r.id) }, el('span', {}, r.name), el('span', { class: 'dim' }, new Date(r.openedAt).toLocaleString())))] : []));
}
$('open-btn').addEventListener('click', () => $('open-input').click());
$('welcome-open').addEventListener('click', () => $('open-input').click());
$('open-input').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = [...e.dataTransfer.files].find((x) => /^video\/|\.(mp4|m4v|mov|webm)$/i.test(x.type || x.name));
  if (f) openFile(f); else toast('Drop a video file (mp4, mov, webm)');
});

// ---- transport -----------------------------------------------------------
// Transport (loop, play, to-start/to-end) always spans the whole clip — a selected marked
// region no longer scopes playback/seeking.
function loopBounds() { return [0, lastFrame()]; }
function togglePlay() {
  if (!ui.src) return;
  if (video.paused) {
    const [a, b] = loopBounds();
    const f = curFrame();
    if (ui.loop && (f < a || f >= b)) { video.currentTime = timeOf(a); if (ui.compare) video2.currentTime = timeOf(a); }
    video.play();
    if (ui.compare) { video2.currentTime = video.currentTime; video2.play(); }
  } else { video.pause(); if (ui.compare) video2.pause(); }
}
function onTick() {
  if (!video.paused) {
    if (ui.loop) {
      const [a, b] = loopBounds();
      if (curFrame() > b) { video.currentTime = timeOf(a); if (ui.compare) video2.currentTime = timeOf(a); }
    }
    // Correct any drift so the compare pane stays locked to the source timeline.
    if (ui.compare && Math.abs((video2.currentTime || 0) - video.currentTime) > 1 / fps()) video2.currentTime = video.currentTime;
    renderFrameState();
  }
  requestAnimationFrame(onTick);
}
video.addEventListener('ended', () => { if (ui.loop) { const t = timeOf(loopBounds()[0]); video.currentTime = t; video.play(); if (ui.compare) { video2.currentTime = t; video2.play(); } } });
video.addEventListener('play', () => { $('play').textContent = '❚❚'; });
video.addEventListener('pause', () => { $('play').textContent = '▶︎'; renderFrameState(); });
video.addEventListener('seeked', renderFrameState);
function toggleMute() { video.muted = !video.muted; $('mute').textContent = video.muted ? '🔇' : '🔊'; $('mute').classList.toggle('on', video.muted); }

// ---- marks ---------------------------------------------------------------
// A range mark is the edit region / generation window. It auto-sizes to a 4s minimum and
// remembers the marked moment as its `anchor`, so extending a boundary leaves the target pose
// where it was marked (off-center) rather than snapping it to the new midpoint. A zero-width
// mark stays a 'frame' (the attach point for an annotation or keyframe).
const REGION_SECONDS = 4;
const regionFrames = () => Math.max(1, Math.round(REGION_SECONDS * fps()));
// Expand [a,b] to at least the 4s minimum (centered on its midpoint) and shift it fully inside
// [0, lastFrame]. A clip shorter than the minimum collapses to the whole clip.
function clampRegion(a, b) {
  const span = regionFrames(); const hi = lastFrame();
  let s = a, e = b;
  if (e - s < span) { const mid = (a + b) / 2; s = Math.round(mid - span / 2); e = s + span; }
  if (s < 0) { s = 0; e = Math.min(hi, s + span); }
  if (e > hi) { e = hi; s = Math.max(0, e - span); }
  return [Math.max(0, s), Math.min(hi, e)];
}
function newMark(s, e, anchor) {
  let a = Math.min(s, e), b = Math.max(s, e);
  if (a === b) { const m = { id: uid('m'), kind: 'frame', start: a, end: a, label: '' }; data.marks.push(m); return m; }
  [a, b] = clampRegion(a, b);
  const anc = Math.min(b, Math.max(a, anchor != null ? anchor : Math.round((a + b) / 2)));
  const m = { id: uid('m'), kind: 'range', start: a, end: b, anchor: anc, label: '' };
  data.marks.push(m);
  return m;
}
// Mark the current frame: reuse a region that already covers it, else create a 4s region
// centered on it (shifted inward near the clip edges) with the frame as its anchor.
function addRegionMark() {
  if (!ui.src) return;
  const f = curFrame();
  const existing = data.marks.find((m) => m.kind === 'range' && inMark(m, f));
  if (existing) { ui.sel = existing.id; return renderAll(); }
  const half = Math.round(regionFrames() / 2);
  mutate(() => { ui.sel = newMark(f - half, f + half, f).id; });
}
function setIn() { if (!ui.src) return; ui.pendingIn = curFrame(); renderTimeline(); toast(`In at frame ${ui.pendingIn} — press O to close the range`); }
function setOut() {
  if (ui.pendingIn == null) return toast('Set an In point first (I)');
  const a = ui.pendingIn; ui.pendingIn = null;
  mutate(() => { ui.sel = newMark(a, curFrame()).id; });
}
// The mark new content at frame f should attach to: the selected mark if it
// covers f, else an existing frame mark at f, else a new frame mark (selected).
function markForFrame(f) {
  const s = selMark();
  if (s && inMark(s, f)) return s;
  const m = data.marks.find((x) => x.kind === 'frame' && x.start === f) || newMark(f, f);
  ui.sel = m.id;
  return m;
}
function select(id) { ui.sel = ui.sel === id ? null : id; renderAll(); }
function deleteMark(id) {
  mutate(() => {
    data.marks = data.marks.filter((m) => m.id !== id);
    data.annotations = data.annotations.filter((a) => a.markId !== id);
    data.prompts = data.prompts.filter((p) => p.markId !== id);
    data.keyframes = data.keyframes.filter((k) => k.markId !== id);
    if (ui.sel === id) ui.sel = null;
  });
}

// ---- timeline ------------------------------------------------------------
const xOfFrame = (f) => `${(f / (lastFrame() + 1)) * 100}%`;
function frameAtX(clientX) {
  const r = lanes.getBoundingClientRect();
  const u = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  return Math.min(lastFrame(), Math.floor(u * (lastFrame() + 1)));
}
function renderTimeline() {
  const n = lastFrame() + 1; const d = dur();
  const ruler = $('ruler'); ruler.replaceChildren();
  if (ui.src && d > 0) {
    const w = lanes.clientWidth || 800;
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => (w / d) * s >= 70) || 300;
    for (let t = 0; t <= d + 1e-6; t += step) ruler.append(el('div', { class: 'tick', style: { left: xOfFrame(frameOf(t)) } }, el('span', {}, fmt(t).replace(/^00:/, ''))));
    if (w / n >= 6) for (let f = 0; f < n; f++) ruler.append(el('div', { class: 'tick minor', style: { left: xOfFrame(f) } }));
  }
  // Keep the marks/ink/keys lanes visible while reviewing a result (spliced results and the
  // side-by-side pane share the source timeline, so the overlays line up). `resultView` still
  // hides the editing-only pending-in marker below.
  const resultView = ui.view === 'result';
  // Marks lane: ranges under frame marks.
  const track = $('track'); track.replaceChildren();
  const sorted = [...data.marks].sort((a, b) => (a.kind === 'range' ? 0 : 1) - (b.kind === 'range' ? 0 : 1));
  for (const m of sorted) {
    const sel = ui.sel === m.id;
    const node = el('div', {
      class: `mark ${m.kind}${sel ? ' sel' : ''}`, title: markLabel(m),
      style: { left: xOfFrame(m.start), ...(m.kind === 'range' ? { width: `calc(${xOfFrame(m.end + 1)} - ${xOfFrame(m.start)})` } : {}) },
    });
    node.addEventListener('pointerdown', (e) => { e.stopPropagation(); select(m.id); if (!sel) seekFrame(m.start); });
    if (m.kind === 'range' && sel) {
      for (const side of ['l', 'r']) {
        const h = el('div', { class: `h ${side}` });
        h.addEventListener('pointerdown', (e) => { e.stopPropagation(); dragHandle(m, side); });
        node.append(h);
      }
    }
    track.append(node);
    // Anchor tick: the marked moment / target-pose time inside the region.
    if (m.kind === 'range' && m.anchor != null) {
      track.append(el('div', { class: `mark-anchor${sel ? ' sel' : ''}`, title: `Target pose @ f${m.anchor}`,
        style: { left: xOfFrame(m.anchor + 0.5) }, onpointerdown: (e) => { e.stopPropagation(); select(m.id); seekFrame(m.anchor); } }));
    }
  }
  // Ink lane: one dot per annotated frame. Clicking selects its mark.
  const la = $('lane-ann'); la.replaceChildren();
  for (const a of data.annotations) {
    la.append(el('div', { class: `dot${ui.sel === a.markId ? ' sel' : ''}`, title: `Ink @ f${a.frame}`,
      style: { left: xOfFrame(a.frame + 0.5), background: a.strokes[0]?.color || 'var(--ink)' },
      onpointerdown: (e) => { e.stopPropagation(); ui.sel = a.markId; seekFrame(a.frame); renderAll(); } }));
  }
  // Keys lane: filled = has an image, hollow = not generated/uploaded yet.
  const lk = $('lane-kf'); lk.replaceChildren();
  for (const k of data.keyframes) {
    lk.append(el('div', { class: `diamond${k.versions.length ? '' : ' empty'}${k.status === 'running' ? ' busy' : ''}`, title: `Keyframe f${k.frame}`,
      style: { left: xOfFrame(k.frame + 0.5) }, onpointerdown: (e) => { e.stopPropagation(); ui.sel = k.markId; seekFrame(k.frame); renderAll(); } }));
  }
  const pin = $('pending-in');
  pin.style.display = (resultView || ui.pendingIn == null) ? 'none' : 'block';
  if (!resultView && ui.pendingIn != null) pin.style.left = xOfFrame(ui.pendingIn);
  $('playhead').style.left = xOfFrame(curFrame() + 0.5);
  renderWave();
}
function renderWave() {
  const c = $('wave'); const r = c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
  const resultView = ui.view === 'result';
  $('no-audio').style.display = (!resultView && ui.src && !ui.meta.hasAudio) ? 'block' : 'none';
  const peaks = resultView ? ui.resultPeaks : ui.peaks;
  if (!peaks || !peaks.length) return;
  const mid = c.height / 2;
  ctx.fillStyle = '#5f7fa3';
  for (let x = 0; x < c.width; x++) {
    const a = Math.floor((x / c.width) * peaks.length); const b = Math.max(a + 1, Math.floor(((x + 1) / c.width) * peaks.length));
    let v = 0; for (let i = a; i < b && i < peaks.length; i++) v = Math.max(v, peaks[i]);
    const h = Math.max(1, v * (c.height - 4) / 2);
    ctx.fillRect(x, mid - h, 1, h * 2);
  }
}
function dragHandle(m, side) {
  commit();
  const minSpan = regionFrames(); // a region can't shrink below the 4s minimum
  const move = (ev) => {
    const f = frameAtX(ev.clientX);
    if (side === 'l') m.start = Math.max(0, Math.min(f, m.end - minSpan));
    else m.end = Math.min(lastFrame(), Math.max(f, m.start + minSpan));
    seekFrame(side === 'l' ? m.start : m.end); renderTimeline();
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    // Content outside the trimmed range would be orphaned: clamp it in. Keep the anchor (the
    // marked moment) inside the region too — it stays put, so it may now be off-center.
    for (const a of annsOf(m)) a.frame = Math.min(m.end, Math.max(m.start, a.frame));
    for (const k of kfsOf(m)) k.frame = Math.min(m.end, Math.max(m.start, k.frame));
    if (m.anchor != null) m.anchor = Math.min(m.end, Math.max(m.start, m.anchor));
    if (m.start === m.end) m.kind = 'frame';
    renderAll(); scheduleSave();
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
function scrubFrom(e) {
  if (!ui.src) return;
  seekFrame(frameAtX(e.clientX));
  const move = (ev) => seekFrame(frameAtX(ev.clientX));
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
for (const id of ['ruler', 'wave-lane', 'lane-ann', 'lane-kf']) $(id).addEventListener('pointerdown', scrubFrom);
// Marks lane: drag creates a range; a plain click scrubs and clears the selection.
$('track').addEventListener('pointerdown', (e) => {
  if (!ui.src) return;
  const a = frameAtX(e.clientX); let b = a;
  seekFrame(a);
  const ghost = el('div', { class: 'mark range sel', style: { left: xOfFrame(a), width: '0' } });
  $('track').append(ghost);
  const move = (ev) => {
    b = frameAtX(ev.clientX); const [s, t] = a <= b ? [a, b] : [b, a];
    ghost.style.left = xOfFrame(s); ghost.style.width = `calc(${xOfFrame(t + 1)} - ${xOfFrame(s)})`;
    seekFrame(b);
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    ghost.remove();
    if (a !== b) mutate(() => { ui.sel = newMark(a, b).id; }); else { ui.sel = null; renderAll(); }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});

// ---- ink (annotations) ---------------------------------------------------
// An annotation is drawn on one frame and belongs to a mark; in a range mark it
// shows (dimmed off its own frame) across the whole range.
function visibleAnnotations(f) {
  return data.annotations.filter((a) => a.frame === f || (markById(a.markId)?.kind === 'range' && inMark(markById(a.markId), f)));
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
  if (!$('show-ann').checked || ui.view !== 'source' || ui.compare) return;
  const f = curFrame();
  for (const a of visibleAnnotations(f)) {
    const dim = ui.sel && ui.sel !== a.markId ? 0.45 : 1;
    for (const s of a.strokes) drawStroke(ctx, s, a.frame === f ? dim : dim * 0.5);
  }
  if (ui.drawing) drawStroke(ctx, ui.drawing);
}
const normPt = (e) => { const r = ink.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height].map((v) => Math.min(1, Math.max(0, v))); };
ink.addEventListener('pointerdown', (e) => {
  if (!ui.src) return;
  if (ui.tool === 'none') { togglePlay(); return; }
  if (ui.view !== 'source') { toast('Switch to Source to annotate'); return; }
  video.pause(); ink.setPointerCapture(e.pointerId);
  if (ui.tool === 'erase') {
    commit(); eraseAt(normPt(e));
    const mv = (ev) => eraseAt(normPt(ev));
    ink.addEventListener('pointermove', mv);
    ink.addEventListener('pointerup', () => { ink.removeEventListener('pointermove', mv); renderAll(); scheduleSave(); }, { once: true });
    return;
  }
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
  mutate(() => {
    const m = markForFrame(f);
    let a = data.annotations.find((x) => x.markId === m.id && x.frame === f);
    if (!a) { a = { id: uid('a'), markId: m.id, frame: f, strokes: [] }; data.annotations.push(a); }
    a.strokes.push(s);
  });
}
function eraseAt([x, y]) {
  const r = 0.02; const f = curFrame(); const ar = ui.meta.height / ui.meta.width || 1;
  for (const a of visibleAnnotations(f)) a.strokes = a.strokes.filter((s) => !s.pts.some(([px, py]) => Math.hypot(px - x, (py - y) * ar) < r));
  data.annotations = data.annotations.filter((a) => a.strokes.length);
  renderInk();
}

// ---- prompts -------------------------------------------------------------
function addPrompt(markId) {
  const p = { id: uid('p'), markId, text: '' };
  mutate(() => data.prompts.push(p));
  document.querySelector(`[data-prompt="${p.id}"] textarea`)?.focus();
}
function promptCard(p) {
  const ta = el('textarea', { placeholder: p.markId ? 'Describe the edit for this mark…' : 'Applies to the whole video…' });
  ta.value = p.text;
  ta.addEventListener('focus', () => commit());
  ta.addEventListener('input', () => { p.text = ta.value; scheduleSave(); });
  return el('div', { class: 'prompt', 'data-prompt': p.id }, ta,
    el('div', { class: 'row' }, el('button', { class: 'x', onclick: () => mutate(() => { data.prompts = data.prompts.filter((x) => x !== p); }) }, 'Delete')));
}

// ---- keyframes -----------------------------------------------------------
// The frame a keyframe action targets for mark m: the playhead if inside m, else m.start.
const kfFrame = (m) => (inMark(m, curFrame()) ? curFrame() : m.start);
function ensureKeyframe(m, f) {
  let k = data.keyframes.find((x) => x.markId === m.id && x.frame === f);
  if (!k) { k = { id: uid('k'), markId: m.id, frame: f, versions: [], current: -1, status: null }; data.keyframes.push(k); }
  return k;
}
function addKeyframe() {
  if (!ui.src) return;
  const f = curFrame();
  mutate(() => ensureKeyframe(markForFrame(f), f));
}
function pushVersion(k, v) {
  commit();
  k.versions.push({ at: new Date().toISOString(), ...v });
  k.current = k.versions.length - 1;
}
async function startJob(body) {
  const r = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ui.id, ...body }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  for (;;) {
    await new Promise((res) => setTimeout(res, 700));
    const s = await (await fetch(`/api/jobs/${j.jobId}`)).json();
    if (s.status === 'done') return s;
    if (s.status !== 'running') throw new Error(s.error || s.status);
  }
}
async function generateKeyframe(k) {
  if (k.status === 'running') return;
  const m = markById(k.markId);
  const prompts = [...promptsOf(m), ...data.prompts.filter((p) => !p.markId)].filter((p) => p.text.trim());
  const anns = annsOf(m);
  if (!prompts.length && !anns.length) return toast('Add a prompt or annotation to this mark first');
  k.status = 'running'; k.error = null; renderAll();
  try {
    const res = await startJob({ kind: 'keyframe', time: timeOf(k.frame), frame: k.frame, fps: fps(), mark: m, prompts, annotations: anns });
    pushVersion(k, { output: res.output, source: 'generated', stub: !!res.stub, note: res.note || '' });
    k.status = null;
    if (res.note) toast(res.note);
  } catch (err) { k.status = 'error'; k.error = err.message; }
  renderAll(); scheduleSave();
}
function uploadKeyframe(k) { ui.kfUploadTarget = k; $('kf-input').click(); }
$('kf-input').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  const k = ui.kfUploadTarget; ui.kfUploadTarget = null;
  if (!file || !k) return;
  try {
    const res = await upload(`/api/keyframe-upload?id=${ui.id}`, file);
    pushVersion(k, { output: res.output, source: 'upload', note: file.name });
    renderAll(); scheduleSave();
  } catch (err) { toast(`upload failed: ${err.message}`, 5000); }
});
function keyframeCard(k) {
  const v = k.versions[k.current];
  const here = k.frame === curFrame();
  const thumb = el('div', { class: 'thumb', title: 'Go to frame', onclick: () => seekFrame(k.frame),
    style: v ? { backgroundImage: `url("${fileUrl(v.output)}")` } : {} }, v ? '' : (k.status === 'running' ? 'generating…' : 'empty'));
  const status = k.status === 'error' ? el('div', { class: 'status err', style: { padding: '0 6px 4px' } }, k.error)
    : v ? el('div', { class: `status${v.stub ? ' stub' : ''}`, style: { padding: '0 6px 4px' } }, v.source === 'upload' ? `uploaded · ${v.note}` : v.stub ? 'placeholder (stub)' : 'generated') : null;
  const many = k.versions.length > 1;
  return el('div', { class: `kf-card${here ? ' here' : ''}` }, thumb,
    el('div', { class: 'bar' },
      el('span', { class: 'grow' }, `f${k.frame}`),
      many ? el('button', { title: 'Previous version', disabled: k.current <= 0, onclick: () => mutate(() => { k.current--; }) }, '‹') : null,
      many ? el('span', { class: 'dim' }, `${k.current + 1}/${k.versions.length}`) : null,
      many ? el('button', { title: 'Next version', disabled: k.current >= k.versions.length - 1, onclick: () => mutate(() => { k.current++; }) }, '›') : null,
      el('button', { class: 'x', title: 'Delete keyframe', onclick: () => mutate(() => { data.keyframes = data.keyframes.filter((x) => x !== k); }) }, '×')),
    el('div', { class: 'bar' },
      el('button', { disabled: k.status === 'running', title: 'Generate from this mark’s prompts + annotations', onclick: () => generateKeyframe(k) }, v ? 'Regenerate' : 'Generate'),
      el('button', { title: 'Upload a predefined keyframe image', onclick: () => uploadKeyframe(k) }, 'Upload…')),
    status);
}

// ---- whole video ---------------------------------------------------------
async function generateVideo() {
  if (!ui.id) return;
  const r = { id: uid('r'), status: 'running', at: new Date().toISOString() };
  data.renders.unshift(r); renderAll();
  try {
    const res = await startJob({
      kind: 'video', fps: fps(), autoKeyframes: data.settings.autoKeyframes, styleLock: data.settings.styleLock || '',
      transcript: data.dialogue ? { text: data.dialogue.text, include: data.dialogue.include !== false } : null, marks: data.marks, prompts: data.prompts.filter((p) => p.text.trim()), annotations: data.annotations,
      keyframes: data.keyframes.filter((k) => k.current >= 0).map((k) => ({ frame: k.frame, time: timeOf(k.frame), markId: k.markId, image: k.versions[k.current].output })),
    });
    Object.assign(r, { status: 'done', run: res.run || null, output: res.output, spliced: res.spliced || null, stub: !!res.stub, note: res.note || '' });
    showResult(r); // defaults to the spliced output when the auto-splice produced one
    if (res.warnings && res.warnings.length) toast(`Run ${res.run}: ${res.warnings.join('; ')}`, 7000);
    else if (res.note) toast(res.note);
  } catch (err) { Object.assign(r, { status: 'error', error: err.message }); }
  renderAll(); scheduleSave();
}
// Show a result in single-clip mode. Defaults to the spliced output (full-length, same timeline
// as the source); pass raw=true to view the unspliced generated clip instead.
function showResult(r, raw = false) {
  clearCompare();
  const out = (!raw && r.spliced) ? r.spliced : r.output;
  ui.view = 'result'; ui.resultSrc = out; ui.resultRaw = !!(raw && r.spliced); ui.resultPeaks = null;
  const url = fileUrl(out, r.at);
  setSource(url); renderAll();
  // The result clip's own audio waveform (client-side; the source /api/waveform is by video id).
  computeResultPeaks(url).then((p) => { if (ui.view === 'result' && ui.resultSrc === out) { ui.resultPeaks = p; renderWave(); } });
}
function showSource() { clearCompare(); ui.view = 'source'; setSource(ui.src); renderAll(); }

// --- side-by-side compare: source + one spliced result, locked to the same timeline ---
// Only spliced results qualify (a raw generation has a different timeline than the source).
const splicedRenders = () => data.renders.filter((r) => r.status === 'done' && r.spliced);
function clearCompare() { if (ui.compare) { video2.pause(); video2.removeAttribute('src'); video2.load(); ui.compare = null; } }
function enterCompare(r) {
  if (!r || !r.spliced) return toast('Side-by-side needs a spliced result');
  const f = curFrame();
  ui.compare = r; ui.view = 'source';
  setSource(ui.src);                         // left pane = source
  video2.src = fileUrl(r.spliced, r.at);     // right pane = the spliced result
  video2.muted = true;
  video2.addEventListener('loadedmetadata', () => { video2.currentTime = timeOf(f); }, { once: true });
  $('label-b').textContent = r.run ? `${r.run} · spliced` : 'spliced';
  renderAll();
}
// Toggle from the Side-by-side button: compare the shown/last spliced result, or drop back to single.
function toggleCompare() {
  if (ui.compare) return showSource();
  const shown = data.renders.find((r) => r.spliced && (ui.resultSrc === r.spliced || ui.resultSrc === r.output));
  const r = shown || splicedRenders()[0];
  if (!r) return toast('Generate and splice a result first');
  enterCompare(r);
}

// Splice a run's edited window(s) back into the full source, then show the result.
async function spliceRun(r) {
  r.status = 'splicing'; renderAll();
  try {
    const { jobId } = await (await fetch('/api/splice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ui.id, run: r.run }) })).json();
    let s; do { await new Promise((z) => setTimeout(z, 700)); s = await (await fetch(`/api/jobs/${jobId}`)).json(); } while (s.status === 'running');
    r.status = 'done';
    // Keep the raw generated output on r.output; store the spliced clip alongside it so the
    // unspliced result stays viewable.
    if (s.status === 'done' && s.output) { r.spliced = s.output; r.at = new Date().toISOString(); showResult(r); }
    else toast(`Splice failed: ${s.error || 'unknown error'}`, 5000);
  } catch (err) { r.status = 'done'; toast(`Splice failed: ${err.message}`, 5000); }
  renderAll();
}

// Decode a result clip's audio to a peak envelope for the waveform lane. Best-effort: returns
// null if the browser can't decode the file's audio (the lane just stays empty).
async function computeResultPeaks(url, buckets = 2000) {
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ac = new Ctx();
    const audio = await ac.decodeAudioData(buf);
    ac.close && ac.close();
    const ch = audio.getChannelData(0); const len = ch.length;
    if (!len) return null;
    const n = Math.min(buckets, len); const peaks = new Array(n).fill(0);
    for (let i = 0; i < len; i++) { const b = Math.min(n - 1, Math.floor((i / len) * n)); const v = Math.abs(ch[i]); if (v > peaks[b]) peaks[b] = v; }
    const max = Math.max(...peaks) || 1;
    return peaks.map((v) => +(v / max).toFixed(3));
  } catch { return null; }
}

// ---- sidebar -------------------------------------------------------------
function renderInspector() {
  const box = $('inspector'); box.replaceChildren();
  const m = selMark();
  if (!m) {
    box.append(el('header', {}, el('h2', {}, 'Selection')),
      el('div', { class: 'hint' }, ui.src
        ? 'Select a mark on the Marks lane, or create one: M marks a 4s region around the current frame (drag the edges to extend, 4s minimum), I/O or drag on the Marks lane marks a custom range. Drawing or adding a keyframe without a selection marks the current frame.'
        : 'Open a video to begin.'));
    return;
  }
  const label = el('input', { type: 'text', placeholder: markLabel({ ...m, label: '' }) }); label.value = m.label || '';
  label.addEventListener('focus', () => commit());
  label.addEventListener('input', () => { m.label = label.value; scheduleSave(); renderTimeline(); renderMarksList(); });
  const f = kfFrame(m);
  box.append(...[
    el('header', {}, el('h2', {}, m.kind === 'range' ? 'Selected range' : 'Selected frame'),
      el('button', { class: 'x', onclick: () => deleteMark(m.id) }, 'Delete mark')),
    el('div', { class: 'title' }, label),
    el('div', { class: 'sub' }, m.kind === 'range'
      ? `Frames ${m.start}–${m.end} · ${m.end - m.start + 1}f · ${fmt(m.start / fps())}–${fmt((m.end + 1) / fps())}`
      : `Frame ${m.start} · ${fmt(m.start / fps())}`),
    el('h3', {}, 'Prompts', el('button', { onclick: () => addPrompt(m.id) }, '+ Prompt')),
    promptsOf(m).length ? promptsOf(m).map(promptCard) : el('div', { class: 'hint' }, 'No prompts — describe the edit for this mark.'),
    el('h3', {}, 'Annotations'),
    annsOf(m).length
      ? el('ul', { class: 'list' }, annsOf(m).sort((a, b) => a.frame - b.frame).map((a) => el('li', { onclick: () => seekFrame(a.frame) },
        el('span', { class: 'chip-dot', style: { background: a.strokes[0]?.color } }),
        el('span', { class: 'grow' }, `Ink @ f${a.frame}`), el('span', { class: 'dim' }, `${a.strokes.length} stroke${a.strokes.length === 1 ? '' : 's'}`),
        el('button', { class: 'x', title: 'Delete', onclick: (e) => { e.stopPropagation(); mutate(() => { data.annotations = data.annotations.filter((x) => x !== a); }); } }, '×'))))
      : el('div', { class: 'hint' }, `Pen (B) to scribble on ${m.kind === 'range' ? 'a frame in this range' : 'this frame'}.`),
    el('h3', {}, 'Keyframes'),
    kfsOf(m).length ? el('div', { class: 'kf-grid' }, kfsOf(m).map(keyframeCard)) : null,
    kfsOf(m).some((k) => k.frame === f) ? null : el('div', { class: 'actions', style: { marginTop: '6px' } },
      el('button', { onclick: () => { commit(); const k = ensureKeyframe(m, f); generateKeyframe(k); } }, `Generate keyframe @ f${f}`),
      el('button', { onclick: () => { commit(); const k = ensureKeyframe(m, f); renderAll(); uploadKeyframe(k); } }, 'Upload keyframe…')),
  ].flat().filter(Boolean));
}
function renderMarksList() {
  const ml = $('marks-list'); ml.replaceChildren();
  if (!data.marks.length) ml.append(el('li', { class: 'empty' }, ui.src ? 'No marks yet' : '—'));
  for (const m of [...data.marks].sort((a, b) => a.start - b.start)) {
    const counts = [[annsOf(m).length, 'ink'], [promptsOf(m).length, 'prompt'], [kfsOf(m).length, 'kf']].filter(([c]) => c);
    ml.append(el('li', { class: ui.sel === m.id ? 'sel' : '', onclick: () => { select(m.id); seekFrame(m.start); } },
      el('span', { class: 'chip-dot', style: { background: 'var(--accent)' } }),
      el('span', { class: 'grow' }, markLabel(m)),
      counts.map(([c, k]) => el('span', { class: `mini ${k}`, html: `${ICONS[k]}${c > 1 ? c : ''}` }))));
  }
}
async function transcribe() {
  if (!ui.id || ui.transcribing) return;
  const id = ui.id; ui.transcribing = true; renderDialogue();
  try {
    const r = await fetch(`/api/transcript?id=${id}`); const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    if (ui.id !== id) return;
    if (!j.transcript) toast('This video has no audio');
    else mutate(() => { data.dialogue = { original: j.transcript.text, text: j.transcript.text, include: true }; });
  } catch (err) { toast(`transcription failed: ${err.message}`, 6000); }
  if (ui.id === id) { ui.transcribing = false; renderDialogue(); }
}
function renderDialogue() {
  const box = $('dialogue'); box.replaceChildren();
  const btn = $('transcribe-btn');
  $('dialogue-panel').style.display = !ui.src || (ui.meta.hasAudio === false) ? 'none' : '';
  btn.disabled = ui.transcribing; btn.textContent = ui.transcribing ? 'Transcribing…' : data.dialogue ? 'Re-transcribe' : 'Transcribe';
  const d = data.dialogue;
  if (!d) { box.append(el('div', { class: 'empty' }, 'Transcribe the speech to include the exact words in the prompt. Without this, a transcript is still made at generate time.')); return; }
  const ta = el('textarea', { placeholder: 'Spoken words…' }); ta.value = d.text;
  ta.addEventListener('focus', () => commit());
  ta.addEventListener('input', () => { d.text = ta.value; sync(); scheduleSave(); });
  const edited = el('span', { class: 'badge-edited' }, 'edited ');
  const reset = el('button', { class: 'x', title: 'Restore the Whisper transcript', onclick: () => mutate(() => { d.text = d.original; }) }, 'Reset');
  const sync = () => { edited.hidden = reset.hidden = d.text.trim() === d.original.trim(); };
  sync();
  const inc = el('input', { type: 'checkbox' }); inc.checked = d.include !== false;
  inc.addEventListener('change', () => mutate(() => { d.include = inc.checked; }));
  box.append(ta, el('div', { class: 'row' }, el('label', { class: 'inline' }, inc, ' Include in prompt'), el('span', {}, edited, reset)));
}
function renderGlobalPrompts() {
  const box = $('global-prompts'); box.replaceChildren();
  const ps = data.prompts.filter((p) => !p.markId);
  box.append(...(ps.length ? ps.map(promptCard) : [el('div', { class: 'empty' }, 'Prompts here apply to the whole video.')]));
  $('add-global-prompt').disabled = !ui.src;
}
function reveal(run) {
  fetch('/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ui.id, run }) })
    .then((r) => (r.ok ? null : r.json().then((j) => toast(`reveal failed: ${j.error}`))));
}
function renderRenders() {
  const ul = $('render-list'); ul.replaceChildren();
  if (!data.renders.length) ul.append(el('li', { class: 'empty' }, 'Generate video to produce a result'));
  data.renders.forEach((r, i) => {
    const on = !ui.compare && ui.view === 'result' && (ui.resultSrc === r.output || (r.spliced && ui.resultSrc === r.spliced));
    const viewing = on ? (ui.resultRaw ? 'raw' : 'spliced') : null;
    const done = r.status === 'done';
    // Row = a name/status line on top + a wrapping actions line below, so a result with many
    // controls never squeezes the name off the row.
    const main = el('div', { class: 'result-main' },
      el('span', { class: 'grow' }, r.run ? `Run ${r.run}` : `Result ${data.renders.length - i}`),
      el('span', { class: `status${r.status === 'error' ? ' err' : r.stub ? ' stub' : ''}` },
        r.status === 'running' ? 'generating…' : r.status === 'splicing' ? 'splicing…' : r.status === 'error' ? r.error
          : (r.spliced ? 'spliced · ' : '') + new Date(r.at).toLocaleTimeString()));
    // Left group: the Raw / Spliced view toggles (only when a spliced output exists). To compare
    // side by side, select the result and use the transport's "Side by side" button.
    const viewBtns = (r.spliced && done) ? [
      el('button', { class: `x${viewing === 'raw' ? ' on' : ''}`, title: 'View the raw generated clip (unspliced)', onclick: (e) => { e.stopPropagation(); showResult(r, true); } }, 'Raw'),
      el('button', { class: `x${viewing === 'spliced' ? ' on' : ''}`, title: 'View the spliced result (full-length)', onclick: (e) => { e.stopPropagation(); showResult(r, false); } }, 'Spliced'),
    ] : [];
    // Right group: management actions.
    const manage = el('div', { class: 'ra-manage' },
      (r.run && done) ? el('button', { class: 'x', title: r.spliced ? 'Re-splice this edit into the source' : 'Splice this edit back into the full source clip', onclick: (e) => { e.stopPropagation(); spliceRun(r); } }, r.spliced ? 'Re-splice' : 'Splice') : null,
      r.run ? el('button', { class: 'x', title: 'Show the run folder (manifest, prompt, inputs)', onclick: (e) => { e.stopPropagation(); reveal(r.run); } }, 'Reveal') : null,
      el('button', { class: 'x', title: 'Remove from list', onclick: (e) => { e.stopPropagation(); mutate(() => { data.renders = data.renders.filter((x) => x !== r); }); } }, '×'));
    const actions = el('div', { class: `result-actions${viewBtns.length ? ' has-view' : ''}` },
      el('div', { class: 'ra-view' }, ...viewBtns), manage);
    ul.append(el('li', { class: `result${on ? ' sel' : ''}`, onclick: () => done && showResult(r) }, main, actions));
  });
  $('gen-video').disabled = !ui.id || data.renders.some((r) => r.status === 'running' || r.status === 'splicing');
}

// ---- per-frame view ------------------------------------------------------
let lastFrameShown = -1;
function renderFrameState() {
  const f = curFrame();
  $('tc').textContent = fmt(video.currentTime || 0);
  $('fc').textContent = `f ${f} / ${lastFrame()}`;
  $('playhead').style.left = xOfFrame(f + 0.5);
  const k = data.keyframes.find((x) => x.frame === f && x.current >= 0);
  const img = $('kf-overlay');
  if (k && $('show-kf').checked && ui.view === 'source' && !ui.compare) {
    const src = fileUrl(k.versions[k.current].output);
    if (img.getAttribute('src') !== src) img.src = src;
    img.style.display = 'block'; img.style.opacity = $('kf-opacity').value / 100;
  } else img.style.display = 'none';
  renderInk();
  // The inspector's keyframe actions follow the playhead; refresh when paused.
  if (f !== lastFrameShown) { lastFrameShown = f; if (video.paused && !document.activeElement?.matches('textarea, input[type=text]')) renderInspector(); }
}
function renderAll() {
  stage.className = `stage tool-${ui.tool}`;
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === ui.tool);
  for (const b of document.querySelectorAll('.swatch')) b.classList.toggle('on', b.dataset.color === ui.color);
  $('loop').classList.toggle('on', ui.loop);
  $('view-source').classList.toggle('on', ui.view === 'source' && !ui.compare);
  $('view-result').classList.toggle('on', ui.view === 'result' && !ui.compare);
  $('view-result').disabled = !data.renders.some((r) => r.status === 'done');
  $('view-side').classList.toggle('on', !!ui.compare);
  $('view-side').disabled = !splicedRenders().length;
  $('stage-wrap').classList.toggle('compare', !!ui.compare);
  $('view-badge').textContent = ui.compare ? '' : ui.view === 'result' ? 'Result' : '';
  $('undo').disabled = !ui.undo.length; $('redo').disabled = !ui.redo.length;
  renderTimeline(); renderInspector(); renderMarksList(); renderDialogue(); renderGlobalPrompts(); renderRenders(); renderFrameState();
}

// ---- wiring --------------------------------------------------------------
function setTool(t) { ui.tool = t; renderAll(); }
for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
$('swatches').append(...COLORS.map((c) => el('button', { class: 'swatch', 'data-color': c, style: { background: c }, title: c,
  onclick: () => { ui.color = c; ui.tool = 'pen'; renderAll(); } })));
$('pen-size').addEventListener('input', (e) => { ui.size = +e.target.value; });
for (const id of ['show-ann', 'show-kf', 'kf-opacity']) $(id).addEventListener('input', renderFrameState);
$('play').addEventListener('click', togglePlay);
$('step-back').addEventListener('click', () => seekFrame(curFrame() - 1));
$('step-fwd').addEventListener('click', () => seekFrame(curFrame() + 1));
$('to-start').addEventListener('click', () => seekFrame(loopBounds()[0]));
$('to-end').addEventListener('click', () => seekFrame(loopBounds()[1]));
$('loop').addEventListener('click', () => { ui.loop = !ui.loop; renderAll(); });
$('mute').addEventListener('click', toggleMute);
$('mark-frame').addEventListener('click', addRegionMark);
$('mark-in').addEventListener('click', setIn);
$('mark-out').addEventListener('click', setOut);
$('add-kf').addEventListener('click', addKeyframe);
$('add-global-prompt').addEventListener('click', () => addPrompt(null));
$('style-lock').addEventListener('input', (e) => { data.settings.styleLock = e.target.value; scheduleSave(); });
$('gen-video').addEventListener('click', generateVideo);
$('transcribe-btn').addEventListener('click', transcribe);
$('auto-kf').addEventListener('change', (e) => {
  const n = Math.max(0, Math.min(12, Math.floor(Number(e.target.value) || 0)));
  e.target.value = n; data.settings.autoKeyframes = n; scheduleSave();
});
$('view-source').addEventListener('click', () => (ui.compare || ui.view !== 'source') && showSource());
$('view-result').addEventListener('click', () => { const r = data.renders.find((x) => x.status === 'done'); if (r && (ui.compare || ui.view !== 'result')) showResult(r); });
$('view-side').addEventListener('click', toggleCompare);
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
window.addEventListener('resize', () => { renderTimeline(); renderInk(); });

window.addEventListener('keydown', (e) => {
  if (e.target.matches('textarea, input[type=text], select')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); return $('open-input').click(); }
  if (mod) return;
  const step = e.shiftKey ? Math.round(fps()) : 1;
  const keys = {
    ' ': togglePlay, ArrowLeft: () => seekFrame(curFrame() - step), ArrowRight: () => seekFrame(curFrame() + step),
    Home: () => seekFrame(loopBounds()[0]), End: () => seekFrame(loopBounds()[1]),
    l: () => { ui.loop = !ui.loop; renderAll(); }, u: toggleMute, m: addRegionMark, i: setIn, o: setOut, k: addKeyframe,
    b: () => setTool('pen'), e: () => setTool('erase'), v: () => setTool('none'),
    Escape: () => { ui.pendingIn = null; ui.sel = null; renderAll(); },
    Backspace: () => { if (ui.sel) deleteMark(ui.sel); },
  };
  const fn = keys[e.key] || keys[e.key.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
});
window.addEventListener('beforeunload', () => { if (saveTimer) save(); });

renderAll();
onTick();
showWelcome().catch((err) => toast(`load failed: ${err.message}`, 5000));
