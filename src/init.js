import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(here, '..', 'templates');

// Empty dir or missing dir both count as safe to scaffold into.
async function emptyOrMissing(dir) {
  try { return (await readdir(dir)).length === 0; }
  catch (err) { if (err.code === 'ENOENT') return true; throw err; }
}

// Scaffold a new project folder: CLAUDE.md + every skill under templates/skills/.
export async function initProject(targetDir) {
  const dir = path.resolve(targetDir);
  if (!(await emptyOrMissing(dir))) {
    throw new Error(`refusing to init a non-empty directory: ${dir}`);
  }
  await mkdir(dir, { recursive: true });
  const files = [];

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
