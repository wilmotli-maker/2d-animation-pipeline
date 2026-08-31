// test/review-scan.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverShotRoots, scanImages } from '../src/review-scan.js';

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

test('scanImages: log-driven versions and panels', async () => {
  await withTempRoot(async (root) => {
    const el = path.join(root, 'elements', 'characters', 'mira');
    await mkdir(path.join(el, 'sheets', 'turnaround', 'main'), { recursive: true });
    const out = path.join(el, 'sheets', 'turnaround', 'main', 'v001.png');
    await writeFile(out, 'x');
    await writeFile(path.join(el, 'generations.jsonl'),
      JSON.stringify({ sheetType: 'turnaround', sheetId: 'main', version: 'v001',
        model: 'nano_banana_pro', prompt: 'p', output: out, panels: [], ts: 'T' }) + '\n');
    const model = await scanImages(root);
    assert.equal(model.type, 'images');
    const c = model.characters.find((x) => x.name === 'mira');
    assert.equal(c.type, 'characters');
    const sheet = c.sheets.find((s) => s.sheetType === 'turnaround' && s.slug === 'main');
    assert.equal(sheet.versions[0].version, 'v001');
    assert.equal(sheet.versions[0].meta.model, 'nano_banana_pro');
    assert.ok(sheet.versions[0].images[0].endsWith('v001.png'));
  });
});

test('scanImages: filesystem fallback for slug-less layout, no log', async () => {
  await withTempRoot(async (root) => {
    const el = path.join(root, 'elements', 'characters', 'joh');
    await mkdir(path.join(el, 'sheets', 'pose'), { recursive: true });
    await writeFile(path.join(el, 'sheets', 'pose', 'v001.png'), 'x');
    const model = await scanImages(root);
    const c = model.characters.find((x) => x.name === 'joh');
    const sheet = c.sheets.find((s) => s.sheetType === 'pose');
    assert.equal(sheet.slug, '');
    assert.equal(sheet.versions[0].version, 'v001');
    assert.ok(sheet.versions[0].images[0].endsWith('v001.png'));
  });
});
