import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(here, '..', 'templates');

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

// Scaffold a new project folder: CLAUDE.md + every skill under templates/skills/,
// plus the two structural dirs every project shares — references/ and elements/.
// Beyond those, each project's structure differs (episodes/, shots/, etc.), so we
// leave the rest to the pipeline as work is authored.
// Scaffolding alongside other content (e.g. a references/ folder the user created)
// is fine; we only refuse if the dir is already an initialized project — i.e. a
// CLAUDE.md or .claude/ is present — so we never clobber existing setup.
export async function initProject(targetDir) {
  const dir = path.resolve(targetDir);
  if ((await exists(path.join(dir, 'CLAUDE.md'))) || (await exists(path.join(dir, '.claude')))) {
    throw new Error(`already initialized (CLAUDE.md or .claude/ present): ${dir}`);
  }
  await mkdir(dir, { recursive: true });
  const files = [];

  // Structural dirs shared by every project. Add a .gitkeep so they survive
  // an empty checkout; harmless if the user later fills or removes them.
  for (const d of ['references', 'elements']) {
    await mkdir(path.join(dir, d), { recursive: true });
    await writeFile(path.join(dir, d, '.gitkeep'), '');
    files.push(`${d}/.gitkeep`);
  }

  const claudeMd = await readFile(path.join(TEMPLATES, 'CLAUDE.md'), 'utf8');
  await writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);
  files.push('CLAUDE.md');

  // Copy every templates/skills/<name>/SKILL.md into the project's .claude/skills/.
  const skillsSrc = path.join(TEMPLATES, 'skills');
  let names = [];
  try { names = await readdir(skillsSrc); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  for (const name of names.sort()) {
    let content;
    try { content = await readFile(path.join(skillsSrc, name, 'SKILL.md'), 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') continue; throw err; } // skip non-skill entries
    const destDir = path.join(dir, '.claude', 'skills', name);
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, 'SKILL.md'), content);
    files.push(`.claude/skills/${name}/SKILL.md`);
  }

  return { dir, files };
}
