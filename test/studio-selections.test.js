// test/studio-selections.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile, symlink, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSelections, setSelection, selectionsPath, isValidVersion } from '../src/studio/selections.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-sel-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('readSelections: missing file -> empty doc', async () => {
  await withTempRoot(async (root) => {
    assert.deepEqual(await readSelections(root), { version: 1, selected: {} });
  });
});

test('setSelection: writes sorted, dedupes, empty list removes key', async () => {
  await withTempRoot(async (root) => {
    await setSelection(root, '1/ai-1', ['v010', 'v002', 'v002']);
    let doc = JSON.parse(await readFile(selectionsPath(root), 'utf8'));
    assert.deepEqual(doc.selected, { '1/ai-1': ['v002', 'v010'] });
    await setSelection(root, '1/ai-1', []);
    doc = await readSelections(root);
    assert.deepEqual(doc.selected, {});
  });
});

test('setSelection: rejects bad keys and versions', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(setSelection(root, '', ['v001']), /key/);
    await assert.rejects(setSelection(root, 'x'.repeat(600), ['v001']), /key/);
    await assert.rejects(setSelection(root, '__proto__', ['v001']), /key/);
    await assert.rejects(setSelection(root, 'a', ['final']), /version/);
    await assert.rejects(setSelection(root, 'a', 'v001'), /versions/);
    await assert.rejects(setSelection(root, '', ['v001']), (e) => e.status === 400);
  });
});

// Symlinks can be unavailable (e.g. unprivileged Windows); skip rather than fail.
async function trySymlink(t, target, p) {
  try { await symlink(target, p); return true; } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') { t.skip('symlinks unavailable'); return false; }
    throw err;
  }
}
async function snapshot(dir) {
  const files = (await readdir(dir, { recursive: true })).sort();
  const out = {};
  for (const f of files) {
    const p = path.join(dir, f);
    out[f] = (await lstat(p)).isFile() ? await readFile(p, 'utf8') : '<dir>';
  }
  return out;
}

for (const [label, link] of [['.pipeline', ['.pipeline']], ['.pipeline/studio', ['.pipeline', 'studio']]]) {
  test(`selections: symlinked ${label} pointing outside the project is refused (403), outside untouched`, async (t) => {
    const outer = await mkdtemp(path.join(tmpdir(), 'studio-sel-esc-'));
    try {
      const root = path.join(outer, 'proj');
      const ext = path.join(outer, 'ext');
      await mkdir(root);
      // <ext> mirrors whatever the link stands in for, holding a sentinel selections file.
      const studioDir = link.length === 1 ? path.join(ext, 'studio') : ext;
      await mkdir(studioDir, { recursive: true });
      await writeFile(path.join(studioDir, 'selections.json'), JSON.stringify({ version: 1, selected: { SENTINEL: ['v001'] } }));
      if (link.length === 2) await mkdir(path.join(root, '.pipeline'));
      if (!await trySymlink(t, ext, path.join(root, ...link))) return;
      const before = await snapshot(ext);
      await assert.rejects(readSelections(root), (e) => e.status === 403 && /outside the project/.test(e.message));
      await assert.rejects(setSelection(root, 'a', ['v001']), (e) => e.status === 403);
      assert.deepEqual(await snapshot(ext), before);
    } finally { await rm(outer, { recursive: true, force: true }); }
  });
}

test('selections: a dangling .pipeline symlink is refused, nothing is created at its target', async (t) => {
  const outer = await mkdtemp(path.join(tmpdir(), 'studio-sel-dangle-'));
  try {
    const root = path.join(outer, 'proj');
    await mkdir(root);
    if (!await trySymlink(t, path.join(outer, 'ext'), path.join(root, '.pipeline'))) return;
    await assert.rejects(setSelection(root, 'a', ['v001']), (e) => e.status === 403);
    assert.deepEqual((await readdir(outer)).sort(), ['proj']);
  } finally { await rm(outer, { recursive: true, force: true }); }
});

test('setSelection: a planted symlink at the temp-file path is not written through', async (t) => {
  const outer = await mkdtemp(path.join(tmpdir(), 'studio-sel-tmp-'));
  try {
    const root = path.join(outer, 'proj');
    await mkdir(path.join(root, '.pipeline', 'studio'), { recursive: true });
    await writeFile(path.join(outer, 'victim.txt'), 'untouched');
    if (!await trySymlink(t, path.join(outer, 'victim.txt'), `${selectionsPath(root)}.${process.pid}.tmp`)) return;
    await setSelection(root, 'a', ['v001']);
    assert.equal(await readFile(path.join(outer, 'victim.txt'), 'utf8'), 'untouched');
    assert.deepEqual((await readSelections(root)).selected, { a: ['v001'] });
  } finally { await rm(outer, { recursive: true, force: true }); }
});

test('selections: a project root reached through a symlink still works', async (t) => {
  await withTempRoot(async (real) => {
    const link = `${real}-link`;
    if (!await trySymlink(t, real, link)) return;
    try {
      await setSelection(link, 'k', ['v002']);
      assert.deepEqual((await readSelections(link)).selected, { k: ['v002'] });
      assert.deepEqual(JSON.parse(await readFile(selectionsPath(real), 'utf8')).selected, { k: ['v002'] });
    } finally { await rm(link, { force: true }); }
  });
});

test('setSelection: concurrent writes to different keys all land', async () => {
  await withTempRoot(async (root) => {
    await Promise.all(['a', 'b', 'c', 'd'].map((k) => setSelection(root, k, ['v001'])));
    assert.deepEqual(Object.keys((await readSelections(root)).selected).sort(), ['a', 'b', 'c', 'd']);
  });
});

test('isValidVersion is the one version rule', () => {
  assert.equal(isValidVersion('v001'), true);
  for (const v of ['final', 'v', 'v1x', 5, null, 'bad::x']) assert.equal(isValidVersion(v), false);
});

test('readSelections: normalizes a malformed doc without rewriting the file', async () => {
  await withTempRoot(async (root) => {
    const raw = JSON.stringify({ selected: {
      a: ['v010', 'v002', 'v002', 'nope'], b: [], c: 'v001', '': ['v001'], ['x'.repeat(600)]: ['v001'],
      d: [7], e: ['v003'],
    } }).replace('"e"', '"__proto__"');
    await mkdir(path.dirname(selectionsPath(root)), { recursive: true });
    await writeFile(selectionsPath(root), raw);
    const doc = await readSelections(root);
    assert.deepEqual(doc.selected, { a: ['v002', 'v010'] });
    assert.equal(Object.getPrototypeOf(doc.selected), Object.prototype);
    // nope, c, '', long key, 7 (d left empty), __proto__ — the empty `b` is not counted.
    assert.deepEqual(doc.warnings, ['ignored 6 invalid selection entries']);
    assert.equal(await readFile(selectionsPath(root), 'utf8'), raw);
  });
});

test('readSelections: clean doc has no warnings key', async () => {
  await withTempRoot(async (root) => {
    await setSelection(root, 'a', ['v001']);
    assert.deepEqual(await readSelections(root), { version: 1, selected: { a: ['v001'] } });
  });
});

for (const [label, raw] of [['invalid JSON', '{nope'], ['null doc', 'null'], ['array selected', '{"selected":[1]}'], ['string selected', '{"selected":"x"}']]) {
  test(`readSelections: ${label} -> empty + one warning; setSelection then writes a clean doc`, async () => {
    await withTempRoot(async (root) => {
      await mkdir(path.dirname(selectionsPath(root)), { recursive: true });
      await writeFile(selectionsPath(root), raw);
      const doc = await readSelections(root);
      assert.deepEqual(doc.selected, {});
      assert.equal(doc.warnings.length, 1);
      assert.equal(await readFile(selectionsPath(root), 'utf8'), raw);
      assert.deepEqual(await setSelection(root, 'k', ['v001']), { version: 1, selected: { k: ['v001'] } });
      assert.deepEqual(JSON.parse(await readFile(selectionsPath(root), 'utf8')), { version: 1, selected: { k: ['v001'] } });
    });
  });
}
