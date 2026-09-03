import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
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

test('initProject scaffolds references/ and elements/ structural dirs', async () => {
  await withTemp(async (base) => {
    const target = path.join(base, 'proj');
    const res = await initProject(target);
    assert.ok((await stat(path.join(target, 'references'))).isDirectory());
    assert.ok((await stat(path.join(target, 'elements'))).isDirectory());
    assert.ok(res.files.includes('references/.gitkeep'));
    assert.ok(res.files.includes('elements/.gitkeep'));
  });
});

test('initProject scaffolds alongside pre-existing content (e.g. a references/ folder)', async () => {
  await withTemp(async (base) => {
    await mkdir(path.join(base, 'references'), { recursive: true });
    await writeFile(path.join(base, 'references', 'ref.png'), 'x');
    const res = await initProject(base);
    assert.equal(res.dir, base);
    assert.match(await readFile(path.join(base, 'CLAUDE.md'), 'utf8'), /Style bible/);
    // pre-existing content left untouched
    assert.ok((await stat(path.join(base, 'references', 'ref.png'))).isFile());
  });
});

test('initProject refuses to clobber an already-initialized project', async () => {
  await withTemp(async (base) => {
    await initProject(base);                        // first init succeeds
    await assert.rejects(() => initProject(base), /already initialized/i);
  });
});
