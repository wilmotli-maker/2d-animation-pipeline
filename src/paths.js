import path from 'node:path';

export function formatVersion(n) {
  return 'v' + String(n).padStart(3, '0');
}

export function elementDir(root, type, name) {
  return path.join(root, 'elements', type, name);
}
export function elementInputsDir(root, type, name) {
  return path.join(elementDir(root, type, name), 'inputs');
}
export function styleLockPath(root, type, name) {
  return path.join(elementDir(root, type, name), 'style-lock.yaml');
}
export function generationsLogPath(root, type, name) {
  return path.join(elementDir(root, type, name), 'generations.jsonl');
}
export function sheetDir(root, type, name, sheetType) {
  return path.join(elementDir(root, type, name), 'sheets', sheetType);
}
export function sheetInstanceDir(root, type, name, sheetType, slug) {
  return path.join(sheetDir(root, type, name, sheetType), slug);
}
export function sheetPromptPath(root, type, name, sheetType, slug) {
  return path.join(sheetInstanceDir(root, type, name, sheetType, slug), 'prompt.md');
}

// Composite output of `pipeline element upscale`, beside the sheet version it
// enlarged. Named `<stem>.upscaled-<tag>` where `stem` is the source's own name
// (e.g. "v003") so upscaled files sort next to — and map obviously back to —
// their original; `tag` carries scale+model (e.g. "2x-topaz_image") so different
// passes coexist. Per-panel upscales land in the sibling `<stem>.upscaled-<tag>/`
// directory (see elementUpscaleTag).
export function elementUpscaleTag(stem, tag) {
  return `${stem}.upscaled-${tag}`;
}
export function elementUpscalePath(root, type, name, sheet, id, stem, tag) {
  return path.join(sheetInstanceDir(root, type, name, sheet, id), `${elementUpscaleTag(stem, tag)}.png`);
}

export function shotDir(root, shotId) {
  return path.join(root, 'shots', shotId);
}
export function shotYamlPath(root, shotId) {
  return path.join(shotDir(root, shotId), 'shot.yaml');
}
export function shotDraftsDir(root, shotId) {
  return path.join(shotDir(root, shotId), 'drafts');
}
export function shotDraftDir(root, shotId, version) {
  return path.join(shotDraftsDir(root, shotId), formatVersion(version));
}
export function shotFinalDir(root, shotId) {
  return path.join(shotDir(root, shotId), 'final');
}

// Where a per-version artifact belongs: the promoted clip's final/ dir when
// version is null or 'final', otherwise that draft's own folder. Mattes are
// written next to the clip they were pulled from so the two never separate.
export function shotVersionDir(root, shotId, version = null) {
  return version == null || version === 'final'
    ? shotFinalDir(root, shotId)
    : shotDraftDir(root, shotId, version);
}

// The RGBA output of `pipeline shot matte`. `ext` null means a numbered PNG
// sequence, which is a folder rather than a single file.
export function shotAlphaPath(root, shotId, version = null, ext = 'mov') {
  const dir = shotVersionDir(root, shotId, version);
  return ext == null ? path.join(dir, 'alpha') : path.join(dir, `alpha.${ext}`);
}

export function shotMatteQcDir(root, shotId, version = null) {
  return path.join(shotVersionDir(root, shotId, version), 'qc');
}

// The output of `pipeline shot upscale`, written beside the clip it enlarged.
// The resolution is in the name so 1080p and 2160p passes of the same clip can
// coexist rather than overwrite each other.
export function shotUpscalePath(root, shotId, version = null, resolution = '1080p') {
  return path.join(shotVersionDir(root, shotId, version), `upscaled-${resolution}.mp4`);
}

// Active credit task for a project root. `pipeline task set` writes it; a
// generation with no --task/PIPELINE_TASK falls back to this label. Under
// .pipeline/ so it sits apart from the user's elements/ and shots/ artifacts.
export function taskStatePath(root) {
  return path.join(root, '.pipeline', 'task');
}

export function shotGenerationsLogPath(root, shotId) {
  return path.join(shotDir(root, shotId), 'generations.jsonl');
}

// Credit log for standalone `pipeline image upscale` runs — images with no
// element/shot home. Project-root so `reconcile`/`report` can find it.
export function imageGenerationsLogPath(root) {
  return path.join(root, 'images', 'generations.jsonl');
}
