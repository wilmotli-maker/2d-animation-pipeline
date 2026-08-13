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
