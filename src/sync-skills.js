import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(here, '..', 'templates');

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

async function readOrNull(p) {
  try { return await readFile(p, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

// Refresh a project's .claude/skills/ from the tool's current skill templates.
// The skills are tool-managed guidance (not project-owned), so each SKILL.md is
// overwritten with the template. CLAUDE.md is deliberately left alone — it holds
// project-specific content (the Style bible). Returns one record per skill with
// status 'added' | 'updated' | 'unchanged'. `templatesDir` is injectable for tests.
export async function syncSkills(root, { templatesDir = TEMPLATES } = {}) {
  if (!(await exists(path.join(root, 'CLAUDE.md'))) && !(await exists(path.join(root, '.claude')))) {
    throw new Error(`not an initialized project (no CLAUDE.md or .claude/): ${root} — run \`pipeline init\` first`);
  }

  const skillsSrc = path.join(templatesDir, 'skills');
  let names = [];
  try { names = await readdir(skillsSrc); } catch (err) { if (err.code !== 'ENOENT') throw err; }

  const results = [];
  for (const name of names.sort()) {
    const content = await readOrNull(path.join(skillsSrc, name, 'SKILL.md'));
    if (content === null) continue; // skip non-skill entries

    const destDir = path.join(root, '.claude', 'skills', name);
    const dest = path.join(destDir, 'SKILL.md');
    const prev = await readOrNull(dest);

    const status = prev === null ? 'added' : prev === content ? 'unchanged' : 'updated';
    if (status !== 'unchanged') {
      await mkdir(destDir, { recursive: true });
      await writeFile(dest, content);
    }
    results.push({ name, status, path: dest });
  }
  return results;
}
