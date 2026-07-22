import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Repo root = one level up from src/. Stable regardless of CWD. This is the
// TOOL's own clone — used to locate the workspace-local CLI binary, NOT to store
// user data. Distinct from projectRoot() below.
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

// Where the USER's project data (elements/, shots/, style-locks, generated
// artifacts) lives — their data, kept separate from the tooling. Resolution
// order: explicit argument > ANIMATION_PIPELINE_ROOT env var > current directory.
// Defaulting to CWD means a user runs `pipeline` from inside their project and
// the data lands there, the way git or npm behave — one install, many projects.
export function projectRoot(explicit) {
  return path.resolve(explicit || process.env.ANIMATION_PIPELINE_ROOT || process.cwd());
}

// The four element categories from the handoff doc. Any other value is rejected
// by createElement so typos don't silently create a fifth category.
export const ELEMENT_TYPES = ['characters', 'props', 'scenes', 'other'];

// Prefer the workspace-local CLI binary over anything global. This mirrors the
// PATH logic in scripts/sanity-checks/lib.sh.
export function higgsfieldBin(root = REPO_ROOT) {
  return path.join(root, 'node_modules', '.bin', 'higgsfield');
}
