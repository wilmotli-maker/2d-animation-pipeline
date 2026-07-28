import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncSkills } from '../src/sync-skills.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sync-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// A fake templates/ dir with two skills, plus an initialized project dir.
async function scaffold(base, { skills }) {
  const templatesDir = path.join(base, 'templates');
  for (const [name, content] of Object.entries(skills)) {
    await mkdir(path.join(templatesDir, 'skills', name), { recursive: true });
    await writeFile(path.join(templatesDir, 'skills', name, 'SKILL.md'), content);
  }
  const project = path.join(base, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'CLAUDE.md'), '# Project\n<!-- style bible -->\n');
  return { templatesDir, project };
}

test('syncSkills adds skills that are missing from the project', async () => {
  await withTemp(async (base) => {
    const { templatesDir, project } = await scaffold(base, {
      skills: { 'element-author': 'AUTHOR v2\n', 'build-element': 'BUILD v2\n' },
    });
    const results = await syncSkills(project, { templatesDir });

    assert.deepEqual(
      results.map((r) => [r.name, r.status]).sort(),
      [['build-element', 'added'], ['element-author', 'added']],
    );
    assert.equal(
      await readFile(path.join(project, '.claude/skills/element-author/SKILL.md'), 'utf8'),
      'AUTHOR v2\n',
    );
  });
});

test('syncSkills overwrites a stale copy and reports it updated', async () => {
  await withTemp(async (base) => {
    const { templatesDir, project } = await scaffold(base, { skills: { 'element-author': 'NEW\n' } });
    const dest = path.join(project, '.claude/skills/element-author/SKILL.md');
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, 'OLD\n');

    const results = await syncSkills(project, { templatesDir });
    assert.deepEqual(results.map((r) => [r.name, r.status]), [['element-author', 'updated']]);
    assert.equal(await readFile(dest, 'utf8'), 'NEW\n');
  });
});

test('syncSkills reports an identical copy as unchanged', async () => {
  await withTemp(async (base) => {
    const { templatesDir, project } = await scaffold(base, { skills: { 'element-author': 'SAME\n' } });
    const dest = path.join(project, '.claude/skills/element-author/SKILL.md');
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, 'SAME\n');

    const results = await syncSkills(project, { templatesDir });
    assert.deepEqual(results.map((r) => [r.name, r.status]), [['element-author', 'unchanged']]);
    assert.equal(await readFile(dest, 'utf8'), 'SAME\n');
  });
});

test('syncSkills never touches CLAUDE.md', async () => {
  await withTemp(async (base) => {
    const { templatesDir, project } = await scaffold(base, { skills: { 'element-author': 'X\n' } });
    const before = await readFile(path.join(project, 'CLAUDE.md'), 'utf8');
    await syncSkills(project, { templatesDir });
    assert.equal(await readFile(path.join(project, 'CLAUDE.md'), 'utf8'), before);
  });
});

test('syncSkills refuses a directory that is not an initialized project', async () => {
  await withTemp(async (base) => {
    const { templatesDir } = await scaffold(base, { skills: { 'element-author': 'X\n' } });
    const notAProject = path.join(base, 'empty');
    await mkdir(notAProject, { recursive: true });
    await assert.rejects(
      () => syncSkills(notAProject, { templatesDir }),
      /not an initialized project|pipeline init/,
    );
  });
});
