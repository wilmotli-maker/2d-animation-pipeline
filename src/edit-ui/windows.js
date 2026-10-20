// src/edit-ui/windows.js
// Plan centered, edge-padded, merged edit windows from marked regions. Pure: no I/O.
// A region is { kind: 'point'|'range', start, end } in seconds (point: start===end).
// Each window is centered on its region(s); near a clip edge the window extends past
// 0 / past duration and the overflow becomes pad (filled with a freeze frame + silence
// by the generator), so the edit point stays at the window midpoint. Overlapping or
// touching windows merge; the splice step later uses sourceSpan + pad to reinsert.
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function idealWindow(region, minWindow) {
  if (region.kind === 'range') {
    const mid = (region.start + region.end) / 2;
    const w = Math.max(minWindow, region.end - region.start);
    // The edit point is the marked moment (anchor) when the user set one — so dragging a
    // boundary leaves the target where it was marked rather than snapping it to the midpoint.
    const center = region.anchor != null ? region.anchor : mid;
    return [mid - w / 2, mid + w / 2, center];
  }
  const t = region.start;
  return [t - minWindow / 2, t + minWindow / 2, t];
}

export function planWindows({ regions = [], duration, fps, minWindow = 4 } = {}) {
  const items = regions
    .map((r) => { const [w0, w1, c] = idealWindow(r, minWindow); return { w0, w1, center: c, region: r }; })
    .sort((a, b) => a.w0 - b.w0);

  const merged = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (last && it.w0 <= last.w1) {
      last.w1 = Math.max(last.w1, it.w1);
      last.centers.push(it.center);
      last.regions.push(it.region);
    } else {
      merged.push({ w0: it.w0, w1: it.w1, centers: [it.center], regions: [it.region] });
    }
  }

  const windows = merged.map((m) => {
    const s = clamp(m.w0, 0, duration);
    const e = clamp(m.w1, 0, duration);
    return {
      window: [m.w0, m.w1],
      sourceSpan: [s, e],
      pad: { start: Math.max(0, -m.w0), end: Math.max(0, m.w1 - duration) },
      clipDuration: m.w1 - m.w0,
      editCenters: m.centers,
      regions: m.regions,
    };
  });
  return { windows };
}
