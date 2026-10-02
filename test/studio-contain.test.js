// test/studio-contain.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { realWithin } from '../src/studio/contain.js';

// os.tmpdir() is itself behind a symlink on macOS (/var -> /private/var), so every
// expectation below is phrased in real paths.
async function withTemp(fn) {
  const outer = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-contain-')));
  try { await fn(outer); } finally { await rm(outer, { recursive: true, force: true }); }
}
// Symlinks can be unavailable (e.g. unprivileged Windows); skip rather than fail.
async function trySymlink(t, target, p) {
  try { await symlink(target, p); return true; } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') { t.skip('symlinks unavailable'); return false; }
    throw err;
  }
}

test('realWithin: plain file inside, root itself, missing target, lexical outside', async () => {
  await withTemp(async (outer) => {
    const root = path.join(outer, 'proj');
    await mkdir(path.join(root, 'a'), { recursive: true });
    await writeFile(path.join(root, 'a', 'f.txt'), 'x');
    assert.equal(await realWithin(root, path.join(root, 'a', 'f.txt')), path.join(root, 'a', 'f.txt'));
    assert.equal(await realWithin(root, root), root);
    assert.equal(await realWithin(root, path.join(root, 'nope.txt')), null);
    await writeFile(path.join(outer, 'secret.txt'), 's');
    assert.equal(await realWithin(root, path.join(outer, 'secret.txt')), null);
    assert.equal(await realWithin(path.join(outer, 'missing-root'), path.join(root, 'a', 'f.txt')), null);
  });
});

test('realWithin: symlinks resolving outside are refused; inside ones resolve to the real path', async (t) => {
  await withTemp(async (outer) => {
    const root = path.join(outer, 'proj');
    const ext = path.join(outer, 'ext');
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await mkdir(ext);
    await writeFile(path.join(ext, 'secret.txt'), 's');
    await writeFile(path.join(root, 'assets', 'clip.mp4'), 'v');
    if (!await trySymlink(t, ext, path.join(root, 'escape'))) return;
    await symlink(path.join(ext, 'secret.txt'), path.join(root, 'link.txt'));
    await symlink(path.join('assets', 'clip.mp4'), path.join(root, 'inner.mp4'));
    assert.equal(await realWithin(root, path.join(root, 'escape', 'secret.txt')), null);
    assert.equal(await realWithin(root, path.join(root, 'escape')), null);
    assert.equal(await realWithin(root, path.join(root, 'link.txt')), null);
    assert.equal(await realWithin(root, path.join(root, 'inner.mp4')), path.join(root, 'assets', 'clip.mp4'));
  });
});

test('realWithin forWrite: missing target under an in-root parent is allowed; under a symlinked-out parent is refused', async (t) => {
  await withTemp(async (outer) => {
    const root = path.join(outer, 'proj');
    const ext = path.join(outer, 'ext');
    await mkdir(root); await mkdir(ext);
    assert.equal(await realWithin(root, path.join(root, '.pipeline', 'studio', 'x.json'), { forWrite: true }),
      path.join(root, '.pipeline', 'studio', 'x.json'));
    assert.equal(await realWithin(root, path.join(root, '.pipeline', 'x.json')), null, 'read mode: missing -> null');
    if (!await trySymlink(t, ext, path.join(root, '.pipeline'))) return;
    assert.equal(await realWithin(root, path.join(root, '.pipeline', 'studio', 'x.json'), { forWrite: true }), null);
    // A dangling symlink component must not be treated as "missing, so fine".
    await rm(path.join(root, '.pipeline'));
    await symlink(path.join(ext, 'not-yet'), path.join(root, '.pipeline'));
    assert.equal(await realWithin(root, path.join(root, '.pipeline', 'studio', 'x.json'), { forWrite: true }), null);
  });
});

test('realWithin: root that is itself a symlink uses its real path as the base', async (t) => {
  await withTemp(async (outer) => {
    const real = path.join(outer, 'real-proj');
    await mkdir(path.join(real, 'a'), { recursive: true });
    await writeFile(path.join(real, 'a', 'f.txt'), 'x');
    const root = path.join(outer, 'proj-link');
    if (!await trySymlink(t, real, root)) return;
    assert.equal(await realWithin(root, path.join(root, 'a', 'f.txt')), path.join(real, 'a', 'f.txt'));
    assert.equal(await realWithin(root, path.join(root, 'b', 'new.json'), { forWrite: true }), path.join(real, 'b', 'new.json'));
  });
});
