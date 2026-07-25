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
