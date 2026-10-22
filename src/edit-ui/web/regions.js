// src/edit-ui/web/regions.js
// Pure region/mark model for the edit-ui timeline (no DOM, no globals) so it can be unit-tested.
//
// Vocabulary:
//   region  — a range mark  { id, kind:'range', start, end, label }   (the bar / generation window)
//   mark    — a frame mark  { id, kind:'frame', start, end, label }   (a tick, start===end)
// Keyframes { id, markId, frame, ... } and ink { id, markId, frame, ... } live inside a region by
// frame position. A region may be empty (no ticks / keyframes / ink). Overlapping/touching regions
// merge into one, matching planWindows() in ./windows.js (overlap OR touch ⇒ one window).
//
// Every mutator takes the data object D ({ marks, prompts, annotations, keyframes }) and a cfg
// ({ regionFrames, lastFrame, uid }) of the three frame/id helpers the UI already owns.

export const inMark = (m, f) => f >= m.start && f <= m.end;
export const idealWindowsTouch = (a, b) => a[0] <= b[1] && b[0] <= a[1];

// Expand [a,b] to at least the 4s minimum (centered on its midpoint) and shift it fully inside
// [0, lastFrame]. A clip shorter than the minimum collapses to the whole clip.
export function clampRegion(a, b, { regionFrames, lastFrame }) {
  const span = regionFrames(); const hi = lastFrame();
  let s = a, e = b;
  if (e - s < span) { const mid = (a + b) / 2; s = Math.round(mid - span / 2); e = s + span; }
  if (s < 0) { s = 0; e = Math.min(hi, s + span); }
  if (e > hi) { e = hi; s = Math.max(0, e - span); }
  return [Math.max(0, s), Math.min(hi, e)];
}

// Ideal edit window for a mark, in frames — mirrors idealWindow() in ./windows.js.
export function markIdealWindow(m, { regionFrames }) {
  const minW = regionFrames();
  if (m.kind === 'frame') { const t = m.start; return [t - minW / 2, t + minW / 2]; }
  const mid = (m.start + m.end) / 2;
  const w = Math.max(minW, m.end - m.start + 1);
  return [mid - w / 2, mid + w / 2];
}

export const regionList = (D) => D.marks.filter((m) => m.kind === 'range');
export const frameMarkList = (D) => D.marks.filter((m) => m.kind === 'frame');
export const regionAt = (D, f) => regionList(D).find((r) => inMark(r, f));
export const frameMarkAt = (D, f) => frameMarkList(D).find((m) => m.start === f);

// Everything a region contains, by frame position: its ticks, keyframes, ink.
export function regionContents(D, R) {
  return {
    marks: D.marks.filter((m) => m.kind === 'frame' && inMark(R, m.start)),
    keyframes: D.keyframes.filter((k) => inMark(R, k.frame)),
    annotations: D.annotations.filter((a) => inMark(R, a.frame)),
  };
}

export function rehomeMarkContent(D, fromId, toId) {
  for (const p of D.prompts) if (p.markId === fromId) p.markId = toId;
  for (const a of D.annotations) if (a.markId === fromId) a.markId = toId;
  for (const k of D.keyframes) if (k.markId === fromId) k.markId = toId;
}

export function newRegion(D, a, b, cfg) {
  const [s, e] = clampRegion(a, b, cfg);
  const m = { id: cfg.uid('m'), kind: 'range', start: s, end: e, label: '' };
  D.marks.push(m);
  return m;
}

export function newFrameMark(D, f, cfg) {
  const m = { id: cfg.uid('m'), kind: 'frame', start: f, end: f, label: '' };
  D.marks.push(m);
  return m;
}

// Merge any regions whose ideal windows overlap/touch into `keepId`. Content on dropped regions is
// rehomed to the survivor. Returns the survivor.
export function mergeRegions(D, keepId, cfg) {
  const keep = D.marks.find((m) => m.id === keepId);
  if (!keep) return null;
  let changed = true;
  while (changed) {
    changed = false;
    for (const R of regionList(D)) {
      if (R.id === keep.id) continue;
      if (idealWindowsTouch(markIdealWindow(keep, cfg), markIdealWindow(R, cfg))) {
        [keep.start, keep.end] = clampRegion(Math.min(keep.start, R.start), Math.max(keep.end, R.end), cfg);
        rehomeMarkContent(D, R.id, keep.id);
        D.marks = D.marks.filter((m) => m.id !== R.id);
        changed = true;
        break;
      }
    }
  }
  return keep;
}

// Ensure a region covers frame f (create a 4s one, or grow + merge an existing one). Returns it.
export function ensureRegionAround(D, f, cfg) {
  const half = Math.round(cfg.regionFrames() / 2);
  const [a, b] = clampRegion(f - half, f + half, cfg);
  let R = regionAt(D, f);
  if (R) [R.start, R.end] = clampRegion(Math.min(R.start, a), Math.max(R.end, b), cfg);
  else R = newRegion(D, a, b, cfg);
  return mergeRegions(D, R.id, cfg);
}

// Mark frame f: ensure a region, add a tick there (reuse one already at f). Returns the tick.
export function addMarkAtFrame(D, f, cfg) {
  ensureRegionAround(D, f, cfg);
  return frameMarkAt(D, f) || newFrameMark(D, f, cfg);
}

// Create a custom range [a,b] (I/O or drag): a region plus a tick at its midpoint. Returns the tick.
export function addRange(D, a, b, cfg) {
  const R = newRegion(D, Math.min(a, b), Math.max(a, b), cfg);
  mergeRegions(D, R.id, cfg);
  const mid = Math.round((a + b) / 2);
  return frameMarkAt(D, mid) || newFrameMark(D, mid, cfg);
}

// After a region bar is resized, pull any now-orphaned ticks/keyframes/ink back inside it, then
// re-merge in case the resize made it touch a neighbor.
export function clampRegionContents(D, R, cfg) {
  const clamp = (f) => Math.min(R.end, Math.max(R.start, f));
  for (const t of regionContents(D, R).marks) { t.start = clamp(t.start); t.end = t.start; }
  for (const a of D.annotations) if (a.markId === R.id) a.frame = clamp(a.frame);
  for (const k of D.keyframes) if (k.markId === R.id) k.frame = clamp(k.frame);
  return mergeRegions(D, R.id, cfg);
}

// Delete only what's selected: a single tick / keyframe / ink, or — for a whole-region selection —
// the region and everything inside it. Selecting a range mark ('mark' focus on a range) also
// deletes the whole region. An empty region (no contents) is left intact otherwise.
export function deleteSelection(D, { sel, focus }) {
  if (!sel || !focus) return;
  const m = D.marks.find((x) => x.id === sel);
  const wholeRegion = focus === 'region' || (focus === 'mark' && m && m.kind === 'range');
  if (wholeRegion) {
    if (!m) return;
    const ids = new Set([m.id, ...regionContents(D, m).marks.map((x) => x.id)]);
    D.marks = D.marks.filter((x) => !ids.has(x.id));
    D.keyframes = D.keyframes.filter((k) => !inMark(m, k.frame));
    D.annotations = D.annotations.filter((a) => !inMark(m, a.frame));
    D.prompts = D.prompts.filter((p) => !ids.has(p.markId));
  } else if (focus === 'mark') {
    D.marks = D.marks.filter((x) => x.id !== sel);
    D.prompts = D.prompts.filter((p) => p.markId !== sel);
    D.annotations = D.annotations.filter((a) => a.markId !== sel);
    D.keyframes = D.keyframes.filter((k) => k.markId !== sel);
  } else if (focus.kf) {
    D.keyframes = D.keyframes.filter((k) => k.id !== focus.kf);
  } else if (focus.ann) {
    D.annotations = D.annotations.filter((a) => a.id !== focus.ann);
  }
}

// Legacy sessions: a range mark used to double as its own first tick via an `anchor`. Split each
// such region into a pure region plus a frame mark at the old anchor so every tick is a frame mark.
export function migrateMarks(D, cfg) {
  for (const m of D.marks) {
    if (m.kind === 'range' && m.anchor != null) {
      const a = Math.min(m.end, Math.max(m.start, m.anchor));
      if (!frameMarkAt(D, a)) newFrameMark(D, a, cfg);
      delete m.anchor;
    }
  }
}
