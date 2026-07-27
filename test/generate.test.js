import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement, writeStyleLock } from '../src/element.js';
import { createShot, newDraft } from '../src/shot.js';
import { sheetPromptPath } from '../src/paths.js';
import { generateElementSheet, generateShotDraft } from '../src/generate.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gen-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function deps() {
  const downloaded = [];
  const splits = [];
  return {
    downloaded,
    splits,
    runBatch: async (_runner, requests) => {
      deps._lastRequest = requests[0];
      return requests.map((r) => ({ ref: r.ref, id: 'job_1', status: 'completed',
        outputUrl: 'https://cdn/job_1.png' }));
    },
    downloadTo: async (url, dest) => {
      downloaded.push({ url, dest });
      const { mkdir, writeFile: wf } = await import('node:fs/promises');
      await mkdir(path.dirname(dest), { recursive: true });
      await wf(dest, 'BYTES');
      return dest;
    },
    // Stand in for the real sharp-backed splitter: record the call and write
    // one file per requested label so the test can assert on folder + names.
    splitPanels: async (imagePath, outDir, labels) => {
      splits.push({ imagePath, outDir, labels });
      const { mkdir, writeFile: wf } = await import('node:fs/promises');
      await mkdir(outDir, { recursive: true });
      const out = [];
      for (const l of labels) { const p = path.join(outDir, `${l}.png`); await wf(p, 'PANEL'); out.push(p); }
      return out;
    },
  };
}

async function seedElement(root, name, sheet, id, promptText = 'a detailed prompt') {
  const { mkdir } = await import('node:fs/promises');
  await createElement(root, { type: 'characters', name });
  await writeStyleLock(root, 'characters', name, { palette: ['#f00'] });
  const pf = sheetPromptPath(root, 'characters', name, sheet, id);
  await mkdir(path.dirname(pf), { recursive: true });
  await writeFile(pf, promptText);
}

test('generateElementSheet saves output under sheets/<type>/<slug>/vNNN and logs it', async () => {
  await withTemp(async (root) => {
    await seedElement(root, 'cecilia', 'turnaround', 'winter');
    const d = deps();
    const res = await generateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'turnaround', id: 'winter', model: 'nano_banana',
    }, { runner: {}, ...d });

    assert.match(res.outputPath, /sheets\/turnaround\/winter\/v001\.png$/);
    assert.equal(res.sheetId, 'winter');
    assert.ok((await stat(res.outputPath)).isFile());

    const snap = path.join(path.dirname(res.outputPath), 'v001.prompt.md');
    assert.equal(await readFile(snap, 'utf8'), 'a detailed prompt');

    const log = JSON.parse(
      (await readFile(path.join(root, 'elements', 'characters', 'cecilia', 'generations.jsonl'), 'utf8')).trim());
    assert.equal(log.sheetType, 'turnaround');
    assert.equal(log.sheetId, 'winter');
    assert.equal(log.version, 'v001');
    assert.equal(log.jobId, 'job_1');
  });
});

test('generateElementSheet auto-splits a turnaround into a version-named panel folder', async () => {
  await withTemp(async (root) => {
    await seedElement(root, 'cecilia', 'turnaround', 'winter');
    const d = deps();
    const res = await generateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'turnaround', id: 'winter', model: 'nano_banana',
    }, { runner: {}, ...d });

    // Folder name matches the sheet name (v001.png -> v001/), sitting beside it.
    assert.equal(d.splits.length, 1);
    assert.equal(d.splits[0].imagePath, res.outputPath);
    assert.match(res.panelsDir, /sheets\/turnaround\/winter\/v001$/);
    assert.equal(res.panelsDir, path.join(path.dirname(res.outputPath), 'v001'));

    assert.deepEqual(
      (await readdir(res.panelsDir)).sort(),
      ['01-front.png', '02-three-quarter-front.png', '03-side.png',
        '04-three-quarter-rear.png', '05-rear.png', '06-face-closeup.png'],
    );
    assert.equal(res.panels.length, 6);

    // Panels are recorded in the generation log for downstream reference.
    const log = JSON.parse(
      (await readFile(path.join(root, 'elements', 'characters', 'cecilia', 'generations.jsonl'), 'utf8')).trim());
    assert.equal(log.panelsDir, res.panelsDir);
    assert.equal(log.panels.length, 6);
  });
});

test('generateElementSheet auto-splits a pose sheet with generic panel names', async () => {
  await withTemp(async (root) => {
    await seedElement(root, 'cecilia', 'pose', 'combat', 'pose prompt');
    const d = deps();
    const res = await generateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'pose', id: 'combat', model: 'nano_banana',
    }, { runner: {}, ...d });

    assert.equal(d.splits.length, 1);
    assert.match(res.panelsDir, /sheets\/pose\/combat\/v001$/);
    assert.deepEqual(
      (await readdir(res.panelsDir)).sort(),
      ['panel-1.png', 'panel-2.png', 'panel-3.png', 'panel-4.png', 'panel-5.png', 'panel-6.png'],
    );
    assert.equal(res.panels.length, 6);
  });
});

test('generateElementSheet leaves cycles sheets whole (no split)', async () => {
  await withTemp(async (root) => {
    await seedElement(root, 'cecilia', 'cycles', 'walk', 'cycle prompt');
    const d = deps();
    const res = await generateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'cycles', id: 'walk', model: 'nano_banana',
    }, { runner: {}, ...d });

    assert.equal(d.splits.length, 0);
    assert.equal(res.panelsDir, null);
    assert.equal(res.panels, null);
  });
});

test('generateElementSheet versions within an instance (reused slug -> v002)', async () => {
  await withTemp(async (root) => {
    await seedElement(root, 'cecilia', 'turnaround', 'winter');
    const d = deps();
    const spec = { type: 'characters', name: 'cecilia', sheet: 'turnaround', id: 'winter', model: 'nano_banana' };
    const a = await generateElementSheet(root, spec, { runner: {}, ...d });
    const b = await generateElementSheet(root, spec, { runner: {}, ...d });
    assert.match(a.outputPath, /winter\/v001\.png$/);
    assert.match(b.outputPath, /winter\/v002\.png$/);
  });
});

test('generateElementSheet resolves the canonical prompt and passes images', async () => {
  await withTemp(async (root) => {
    await seedElement(root, 'cecilia', 'pose', 'combat', 'pose prompt');
    const ref = path.join(root, 'ref.png');
    await writeFile(ref, 'x');
    const d = deps();
    await generateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'pose', id: 'combat', model: 'nano_banana',
      images: [ref],
    }, { runner: {}, ...d });
    assert.equal(deps._lastRequest.opts.prompt, 'pose prompt');
    assert.deepEqual(deps._lastRequest.opts.imageReferences, [ref]);
  });
});

test('generateElementSheet throws on a hard failure (missing element)', async () => {
  await withTemp(async (root) => {
    await assert.rejects(
      () => generateElementSheet(root, {
        type: 'characters', name: 'ghost', sheet: 'turnaround', id: 'x', model: 'nano_banana',
        prompt: 'p',
      }, { runner: {}, ...deps() }),
      /cannot generate.*element exists/i,
    );
  });
});

test('generateShotDraft reads the draft prompt.md and saves output', async () => {
  await withTemp(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    const { dir } = await newDraft(root, 's1');
    await writeFile(path.join(dir, 'prompt.md'), 'shot prompt');
    const d = deps();
    const res = await generateShotDraft(root, {
      shotId: 's1', version: 1, model: 'seedance_2_0_mini',
    }, { runner: {}, ...d });
    assert.equal(path.dirname(res.outputPath), dir);
    assert.match(res.outputPath, /drafts\/v001\/output\./);
    assert.equal(deps._lastRequest.opts.prompt, 'shot prompt');
  });
});

test('generateShotDraft throws when the draft prompt is empty', async () => {
  await withTemp(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    await newDraft(root, 's1');
    await writeFile(path.join(root, 'shots', 's1', 'drafts', 'v001', 'prompt.md'), '   ');
    await assert.rejects(
      () => generateShotDraft(root, { shotId: 's1', version: 1, model: 'm' }, { runner: {}, ...deps() }),
      /cannot generate.*empty/i,
    );
  });
});

test('generateShotDraft throws when the draft does not exist', async () => {
  await withTemp(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    await assert.rejects(
      () => generateShotDraft(root, { shotId: 's1', version: 5, model: 'm' }, { runner: {}, ...deps() }),
      /cannot generate.*draft exists/i,
    );
  });
});
