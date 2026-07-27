import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/init.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'init-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('initProject scaffolds CLAUDE.md and all skill templates', async () => {
  await withTemp(async (base) => {
    const target = path.join(base, 'proj');
    const res = await initProject(target);
    assert.equal(res.dir, target);
    const claude = await readFile(path.join(target, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /Style bible/);
    const ea = await readFile(
      path.join(target, '.claude', 'skills', 'element-author', 'SKILL.md'), 'utf8');
    assert.match(ea, /name: element-author/);
    const be = await readFile(
      path.join(target, '.claude', 'skills', 'build-element', 'SKILL.md'), 'utf8');
    assert.match(be, /name: build-element/);
    // res.files lists every scaffolded file.
    assert.ok(res.files.includes('.claude/skills/element-author/SKILL.md'));
    assert.ok(res.files.includes('.claude/skills/build-element/SKILL.md'));
  });
});

test('initProject creates a missing target dir but refuses a non-empty one', async () => {
  await withTemp(async (base) => {
    await writeFile(path.join(base, 'existing.txt'), 'x');
    await assert.rejects(() => initProject(base), /non-empty/i);
  });
});
