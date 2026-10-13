// src/edit-ui/runview.js
// Normalize a run manifest (workspace.createRun + inputs.prepareRunInputs) into
// the single shape a real generation backend consumes, so each backend reads one
// view instead of re-walking inputs[]. Pure and synchronous: it resolves the
// workspace-relative input paths to absolute and picks the image references to
// send, capped and priority-ordered.
//
//   readRunView(workspace, manifest, { maxImages = 8 }) ->
//     { prompt, source, audio, speechref, window, images[], dropped[] }
//
// `images` and `dropped` entries are { role, kind, frame, path(abs) }. Image
// priority is edited keyframe > annotation(frame) > auto keyframe; strokes-only
// annotation images are never sent (they carry no frame context on their own).
// Everything beyond maxImages lands in `dropped` rather than being silently cut,
// so a caller can surface it.
import path from 'node:path';

export const DEFAULT_MAX_IMAGES = 8;

// Lower rank = sent first, kept when the cap bites.
const IMAGE_RANK = { 'keyframe:edited': 0, 'annotation:frame': 1, 'keyframe:auto': 2 };

function abs(workspace, rel) {
  return rel ? path.resolve(workspace, rel) : null;
}

export function readRunView(workspace, manifest, { maxImages = DEFAULT_MAX_IMAGES } = {}) {
  const inputs = manifest.inputs || [];
  const first = (role) => inputs.find((i) => i.role === role) || null;
  const source = first('source');
  const audio = first('audio');
  const speech = first('speechref');

  const ranked = inputs
    .map((i) => ({ input: i, rank: IMAGE_RANK[`${i.role}:${i.kind}`] }))
    .filter((x) => x.rank !== undefined)
    .map((x) => ({
      x,
      entry: { role: x.input.role, kind: x.input.kind, frame: x.input.frame ?? null, path: abs(workspace, x.input.path) },
    }))
    // priority first, then timeline order within a priority for stable, readable output
    .sort((a, b) => (a.x.rank - b.x.rank) || ((a.entry.frame ?? 0) - (b.entry.frame ?? 0)))
    .map((x) => x.entry);

  const cap = Math.max(0, Math.floor(maxImages));
  return {
    prompt: (manifest.prompt && manifest.prompt.text) || '',
    source: source ? abs(workspace, source.path) : null,
    audio: audio ? abs(workspace, audio.path) : null,
    speechref: speech ? abs(workspace, speech.path) : null,
    window: manifest.window || null,
    images: ranked.slice(0, cap),
    dropped: ranked.slice(cap),
  };
}
