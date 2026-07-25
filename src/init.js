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

// Scaffold a new project folder: CLAUDE.md + the element-author skill.
export async function initProject(targetDir) {
  const dir = path.resolve(targetDir);
  if (!(await emptyOrMissing(dir))) {
    throw new Error(`refusing to init a non-empty directory: ${dir}`);
  }
  await mkdir(dir, { recursive: true });

  const claudeMd = await readFile(path.join(TEMPLATES, 'CLAUDE.md'), 'utf8');
  await writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);

  const skillDir = path.join(dir, '.claude', 'skills', 'element-author');
  await mkdir(skillDir, { recursive: true });
  const skillMd = await readFile(path.join(TEMPLATES, 'skills', 'element-author', 'SKILL.md'), 'utf8');
  await writeFile(path.join(skillDir, 'SKILL.md'), skillMd);

  return { dir, files: ['CLAUDE.md', '.claude/skills/element-author/SKILL.md'] };
}
