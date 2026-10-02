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

async function seedShot(root, id, { drafts = [], final = null, promoted = null, elements = [] } = {}) {
  await mkdir(path.join(root, 'shots', id, 'drafts'), { recursive: true });
  await mkdir(path.join(root, 'shots', id, 'final'), { recursive: true });
  await writeFile(path.join(root, 'shots', id, 'shot.yaml'),
    YAMLstringify({ shotId: id, elements, duration: 6, mode: 'narrative', description: 'd' }));
  for (const d of drafts) {
    const dir = path.join(root, 'shots', id, 'drafts', d.version);
    await mkdir(dir, { recursive: true });
    if (!d.noOutput) await writeFile(path.join(dir, 'output.mp4'), 'x');
    if (d.output) await writeFile(path.join(dir, 'output.json'), JSON.stringify(d.output));
  }
  if (final) await writeFile(path.join(root, 'shots', id, 'final', final), 'x');
  if (promoted) await writeFile(path.join(root, 'shots', id, 'final', 'source-draft.txt'), promoted + '\n');
}
// tiny inline YAML.stringify to avoid another import in the helper
import YAML2 from 'yaml';
function YAMLstringify(o) { return YAML2.stringify(o); }

test('scanShots: versions, characters, graceful meta; skips outputless drafts; badges promoted; no final version', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 'art-talk-01', {
      elements: [{ type: 'characters', name: 'mira' }, { type: 'characters', name: 'joh' }],
      drafts: [
        { version: 'v001' },                                   // no output.json -> meta {}
        { version: 'v002', output: { model: 'seedance_2_5', resolution: '480p', ts: 'T' } },
        { version: 'v003', noOutput: true },                   // only prompt/notes -> skipped
      ],
      final: 'art-talk-01-alpha-review.mp4',                   // final folder is NOT surfaced
      promoted: 'v002',
    });
    const model = await scanShots(root, {});
    assert.equal(model.type, 'shots');
    const s = model.shots.find((x) => x.shotId === 'art-talk-01');
    assert.deepEqual(s.characters, ['mira', 'joh']);
    assert.equal(s.episode, null);
    // v003 skipped (no output), no synthetic 'final' version
    assert.deepEqual(s.versions.map((v) => v.version), ['v001', 'v002']);
    assert.equal(s.promotedVersion, 'v002');
    assert.equal(s.versions[0].meta.model, undefined); // graceful: {}
    assert.equal(s.versions[0].promoted, false);
    assert.equal(s.versions[1].meta.model, 'seedance_2_5');
    assert.equal(s.versions[1].promoted, true);           // badged as final
    assert.ok(s.versions.every((v) => v.video && v.video.endsWith('output.mp4')));
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

import { scanFolder } from '../src/review-scan.js';

test('scanFolder: filenames -> shots/versions, single-version fallback, skips non-video', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, 'episodes', '2', 'shots', 'candidates');
    await mkdir(dir, { recursive: true });
    for (const n of ['ai-1-v003.mp4', 'ai-1-v006.mp4', 'art-2-v015.mp4', 'intro.mp4', 'notes.txt']) {
      await writeFile(path.join(dir, n), 'x');
    }
    const model = await scanFolder(root, dir);
    assert.equal(model.type, 'shots');
    const ids = model.shots.map((s) => s.shotId);
    assert.deepEqual(ids, ['ai-1', 'art-2', 'intro']);            // sorted, notes.txt skipped
    const ai1 = model.shots.find((s) => s.shotId === 'ai-1');
    assert.deepEqual(ai1.versions.map((v) => v.version), ['v003', 'v006']);
    assert.equal(ai1.episode, null);
    assert.deepEqual(ai1.characters, []);
    assert.equal(ai1.promotedVersion, null);
    assert.ok(ai1.versions[0].video.endsWith('candidates/ai-1-v003.mp4'));
    const intro = model.shots.find((s) => s.shotId === 'intro');
    assert.deepEqual(intro.versions.map((v) => v.version), ['v001']);   // no -vNNN -> single v001
    assert.equal(intro.versions[0].kind, 'draft');
  });
});

test('scanFolder: shots sort naturally (ai-2 before ai-10)', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, 'cand');
    await mkdir(dir, { recursive: true });
    for (const n of ['ai-1-v001.mp4', 'ai-2-v001.mp4', 'ai-10-v001.mp4', 'ai-11-v001.mp4']) {
      await writeFile(path.join(dir, n), 'x');
    }
    const ids = (await scanFolder(root, dir)).shots.map((s) => s.shotId);
    assert.deepEqual(ids, ['ai-1', 'ai-2', 'ai-10', 'ai-11']);
  });
});

test('scanFolder: empty/no-video folder yields no shots', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, 'empty');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'readme.txt'), 'x');
    const model = await scanFolder(root, dir);
    assert.equal(model.shots.length, 0);
  });
});

test('scanShots: alpha.webm is surfaced as the matte variant', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, 'shots', 's1', 'drafts', 'v001');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'output.mp4'), 'x');
    await writeFile(path.join(dir, 'alpha.webm'), 'x');
    const m = await scanShots(root);
    assert.equal(m.shots[0].versions[0].variants.alpha, path.join('shots', 's1', 'drafts', 'v001', 'alpha.webm'));
  });
});

async function seedFinalFiles(root, id, files) {
  for (const f of files) {
    const p = path.join(root, 'shots', id, 'final', f);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, 'x');
  }
}

test('scanShots: promoted draft without own alpha picks up final/alpha.mov', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 's1', { drafts: [{ version: 'v001' }, { version: 'v002' }], promoted: 'v002' });
    await seedFinalFiles(root, 's1', ['alpha.mov']);
    const s = (await scanShots(root, {})).shots.find((x) => x.shotId === 's1');
    assert.deepEqual(s.versions.map((v) => v.version), ['v001', 'v002']);
    assert.equal(s.versions[1].variants.alpha, path.join('shots', 's1', 'final', 'alpha.mov'));
    assert.equal(s.versions[0].variants.alpha, null);
  });
});

test('scanShots: promoted draft own alpha wins over final/alpha.mov', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 's1', { drafts: [{ version: 'v002' }], promoted: 'v002' });
    await writeFile(path.join(root, 'shots', 's1', 'drafts', 'v002', 'alpha.webm'), 'x');
    await seedFinalFiles(root, 's1', ['alpha.mov']);
    const s = (await scanShots(root, {})).shots.find((x) => x.shotId === 's1');
    assert.equal(s.versions[0].variants.alpha, path.join('shots', 's1', 'drafts', 'v002', 'alpha.webm'));
  });
});

test('scanShots: final/ qc and upscales are attributed to the promoted draft', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 's1', { drafts: [{ version: 'v002' }], promoted: 'v002' });
    await seedFinalFiles(root, 's1', ['qc/f0.png', 'upscaled-1080p.mp4']);
    const s = (await scanShots(root, {})).shots.find((x) => x.shotId === 's1');
    const v = s.versions[0].variants;
    assert.deepEqual(v.qc, [path.join('shots', 's1', 'final', 'qc', 'f0.png')]);
    assert.deepEqual(v.upscaled, [path.join('shots', 's1', 'final', 'upscaled-1080p.mp4')]);
  });
});

test('scanShots: without source-draft.txt, final/ variants are ignored', async () => {
  await withTempRoot(async (root) => {
    await seedShot(root, 's1', { drafts: [{ version: 'v001' }] });
    await seedFinalFiles(root, 's1', ['alpha.mov', 'qc/f0.png', 'upscaled-1080p.mp4']);
    const s = (await scanShots(root, {})).shots.find((x) => x.shotId === 's1');
    const v = s.versions[0].variants;
    assert.equal(v.alpha, null);
    assert.deepEqual(v.qc, []);
    assert.deepEqual(v.upscaled, []);
  });
});

// ---- element sheets: disk is truth, log only enriches ----
import { isShotDir } from '../src/review-scan.js';

async function seedFiles(root, files) {
  for (const f of files) {
    const p = path.join(root, f);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, 'x');
  }
}
const EL = 'elements/characters/mira';
async function sheetsOf(root, sheetType, slug) {
  const c = (await scanImages(root)).characters.find((x) => x.name === 'mira');
  return c && c.sheets.find((s) => s.sheetType === sheetType && s.slug === slug);
}
const logLine = (o) => JSON.stringify(o) + '\n';

test('scanImages: logged sheet with no folder on disk is dropped; logged sheet on disk is enriched', async () => {
  await withTempRoot(async (root) => {
    await seedFiles(root, [`${EL}/sheets/pose/here/v001.png`]);
    await writeFile(path.join(root, EL, 'generations.jsonl'),
      logLine({ sheetType: 'pose', sheetId: 'gone', version: 'v001', model: 'm0', prompt: 'p0', ts: 'T0' }) +
      logLine({ sheetType: 'pose', sheetId: 'here', version: 'v001', model: 'm1', prompt: 'p1', ts: 'T1' }));
    const c = (await scanImages(root)).characters[0];
    assert.deepEqual(c.sheets.map((s) => s.slug), ['here']);
    assert.deepEqual(c.sheets[0].versions[0].meta, { model: 'm1', prompt: 'p1', ts: 'T1' });
  });
});

test('scanImages: log versions missing on disk are ignored', async () => {
  await withTempRoot(async (root) => {
    await seedFiles(root, [`${EL}/sheets/turnaround/default/v002.png`]);
    await writeFile(path.join(root, EL, 'generations.jsonl'),
      ['v001', 'v002', 'v003'].map((version) => logLine({ sheetType: 'turnaround', sheetId: 'default', version, model: 'm' })).join(''));
    const s = await sheetsOf(root, 'turnaround', 'default');
    assert.deepEqual(s.versions.map((v) => v.version), ['v002']);
  });
});

test('scanImages: never-logged disk slug appears with empty meta', async () => {
  await withTempRoot(async (root) => {
    await seedFiles(root, [`${EL}/sheets/pose/new/v001.png`]);
    const s = await sheetsOf(root, 'pose', 'new');
    assert.deepEqual(s.versions[0].meta, {});
  });
});

test('scanImages: panels dir wins over composite, natural order; composite-only version uses the file', async () => {
  await withTempRoot(async (root) => {
    const d = `${EL}/sheets/turnaround/default`;
    await seedFiles(root, [`${d}/v001.png`, `${d}/v001/panel-10.png`, `${d}/v001/panel-2.png`,
      `${d}/v001/panel-1.png`, `${d}/v002.png`]);
    const s = await sheetsOf(root, 'turnaround', 'default');
    assert.deepEqual(s.versions[0].images.map((p) => path.basename(p)), ['panel-1.png', 'panel-2.png', 'panel-10.png']);
    assert.deepEqual(s.versions[1].images.map((p) => path.basename(p)), ['v002.png']);
    assert.ok(!path.isAbsolute(s.versions[1].images[0]));
  });
});

test('scanImages: vNNN.upscaled-* files attach as upscaled, never as versions or images', async () => {
  await withTempRoot(async (root) => {
    const d = `${EL}/sheets/turnaround/default`;
    await seedFiles(root, [`${d}/v003.png`, `${d}/v003.upscaled-2x-topaz_image.png`,
      `${d}/v003.upscaled-2x-topaz_image/panel-1.png`, `${d}/v003.upscaled-2x-topaz_image.json`]);
    const s = await sheetsOf(root, 'turnaround', 'default');
    assert.equal(s.versions.length, 1);
    assert.deepEqual(s.versions[0].images.map((p) => path.basename(p)), ['v003.png']);
    assert.deepEqual(s.versions[0].upscaled.map((p) => path.basename(p)), ['v003.upscaled-2x-topaz_image.png']);
  });
});

test('scanImages: candidates dir (no vNNN) makes one version per image, sorted, labelled', async () => {
  await withTempRoot(async (root) => {
    const d = `${EL}/sheets/pose/cands`;
    await seedFiles(root, [`${d}/b.png`, `${d}/a.png`, `${d}/notes.md`]);
    const s = await sheetsOf(root, 'pose', 'cands');
    assert.deepEqual(s.versions.map((v) => v.version), ['v001', 'v002']);
    assert.equal(s.versions[0].meta.label, 'a.png');
    assert.ok(s.versions[0].images[0].endsWith('a.png'));
    assert.equal(s.versions[1].meta.label, 'b.png');
  });
});

test('scanImages: stray unversioned image beside real versions is ignored', async () => {
  await withTempRoot(async (root) => {
    const d = `${EL}/sheets/pose/x`;
    await seedFiles(root, [`${d}/v001.png`, `${d}/ref.png`]);
    const s = await sheetsOf(root, 'pose', 'x');
    assert.equal(s.versions.length, 1);
    assert.deepEqual(s.versions[0].images.map((p) => path.basename(p)), ['v001.png']);
  });
});

test('scanImages: stray .DS_Store files at sheets/ and sheetType level do not crash', async () => {
  await withTempRoot(async (root) => {
    await seedFiles(root, [`${EL}/sheets/.DS_Store`, `${EL}/sheets/pose/.DS_Store`, `${EL}/sheets/pose/s/v001.png`]);
    const c = (await scanImages(root)).characters[0];
    assert.deepEqual(c.sheets.map((s) => s.slug), ['s']);
  });
});

test('scanImages: direct sheetType files keep slug empty', async () => {
  await withTempRoot(async (root) => {
    await seedFiles(root, [`${EL}/sheets/pose/v001.png`]);
    assert.ok(await sheetsOf(root, 'pose', ''));
  });
});

test('scanImages: last log entry for a sheet/version wins', async () => {
  await withTempRoot(async (root) => {
    await seedFiles(root, [`${EL}/sheets/pose/s/v001.png`]);
    await writeFile(path.join(root, EL, 'generations.jsonl'),
      logLine({ sheetType: 'pose', sheetId: 's', version: 'v001', model: 'old', prompt: 'a', ts: '1' }) +
      logLine({ sheetType: 'pose', sheetId: 's', version: 'v001', model: 'new', prompt: 'b', ts: '2' }));
    const s = await sheetsOf(root, 'pose', 's');
    assert.deepEqual(s.versions[0].meta, { model: 'new', prompt: 'b', ts: '2' });
  });
});

test('scanShots: only dirs with shot.yaml or drafts/ are shots; isShotDir agrees', async () => {
  await withTempRoot(async (root) => {
    await seedFiles(root, ['shots/candidates/x.mp4', 'shots/a/shot.yaml', 'shots/b/drafts/v001/output.mp4']);
    const m = await scanShots(root);
    assert.deepEqual(m.shots.map((s) => s.shotId), ['a', 'b']);
    assert.equal(await isShotDir(path.join(root, 'shots', 'a')), true);
    assert.equal(await isShotDir(path.join(root, 'shots', 'b')), true);
    assert.equal(await isShotDir(path.join(root, 'shots', 'candidates')), false);
    assert.equal(await isShotDir(path.join(root, 'shots', 'nope')), false);
  });
});
