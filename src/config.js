import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Repo root = one level up from src/. Stable regardless of CWD.
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

// The four element categories from the handoff doc. Any other value is rejected
// by createElement so typos don't silently create a fifth category.
export const ELEMENT_TYPES = ['characters', 'props', 'scenes', 'other'];

// Prefer the workspace-local CLI binary over anything global. This mirrors the
// PATH logic in scripts/sanity-checks/lib.sh.
export function higgsfieldBin(root = REPO_ROOT) {
  return path.join(root, 'node_modules', '.bin', 'higgsfield');
}
