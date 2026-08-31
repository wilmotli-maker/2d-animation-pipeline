// test/review-scan.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverShotRoots } from '../src/review-scan.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('discoverShotRoots: flat layout yields one root with episode null', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'shots', 's1'), { recursive: true });
    const roots = await discoverShotRoots(root);
    assert.deepEqual(roots, [{ root, episode: null }]);
  });
});

test('discoverShotRoots: episodic layout yields one root per episode', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'episodes', '1', 'shots', 'a'), { recursive: true });
    await mkdir(path.join(root, 'episodes', '2', 'shots', 'b'), { recursive: true });
    const roots = await discoverShotRoots(root);
    assert.deepEqual(roots.map((r) => r.episode).sort(), ['1', '2']);
    assert.equal(roots.find((r) => r.episode === '1').root, path.join(root, 'episodes', '1'));
  });
});

// append to test/review-scan.test.js
import { scanShots } from '../src/review-scan.js';

async function seedShot(root, id, { drafts = [], final = null, elements = [] } = {}) {
  await mkdir(path.join(root, 'shots', id, 'drafts'), { recursive: true });
  await mkdir(path.join(root, 'shots', id, 'final'), { recursive: true });
  await writeFile(path.join(root, 'shots', id, 'shot.yaml'),
    YAMLstringify({ shotId: id, elements, duration: 6, mode: 'narrative', description: 'd' }));
  for (const d of drafts) {
    const dir = path.join(root, 'shots', id, 'drafts', d.version);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'output.mp4'), 'x');
    if (d.output) await writeFile(path.join(dir, 'output.json'), JSON.stringify(d.output));
  }
  if (final) await writeFile(path.join(root, 'shots', id, 'final', final), 'x');
}
// tiny inline YAML.stringify to avoid another import in the helper
import YAML2 from 'yaml';
function YAMLstringify(o) { return YAML2.stringify(o); }

test('scanShots: builds versions, characters, and graceful meta', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'art-talk-01', {
      elements: [{ type: 'characters', name: 'mira' }, { type: 'characters', name: 'joh' }],
      drafts: [
        { version: 'v001' },                                   // no output.json -> meta {}
        { version: 'v002', output: { model: 'seedance_2_5', resolution: '480p', ts: 'T' } },
      ],
      final: 'art-talk-01-v002.mp4',
    });
    const model = await scanShots(root, {});
    assert.equal(model.type, 'shots');
    const s = model.shots.find((x) => x.shotId === 'art-talk-01');
    assert.deepEqual(s.characters, ['mira', 'joh']);
    assert.equal(s.episode, null);
    assert.deepEqual(s.versions.map((v) => v.version), ['v001', 'v002', 'final']);
    assert.equal(s.versions[0].meta.model, undefined); // graceful: {}
    assert.equal(s.versions[1].meta.model, 'seedance_2_5');
    assert.equal(s.versions[2].kind, 'final');
    assert.ok(s.versions[2].video.endsWith('art-talk-01-v002.mp4'));
  });
});

test('scanShots: episodic tags episode and filters by --episode later', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'episodes', '1'), { recursive: true });
    await seedShot(path.join(root, 'episodes', '1'), 'a', { drafts: [{ version: 'v001' }] });
    const model = await scanShots(root, {});
    assert.equal(model.shots[0].episode, '1');
  });
});
