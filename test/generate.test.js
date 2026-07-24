import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement } from '../src/element.js';
import { createShot, newDraft } from '../src/shot.js';
import { generateElementSheet, generateShotDraft } from '../src/generate.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gen-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// Deps double: batch returns a completed job; download writes a marker file.
function deps() {
  const downloaded = [];
  return {
    downloaded,
    runBatch: async (_runner, requests) =>
      requests.map((r) => ({ ref: r.ref, id: 'job_1', status: 'completed',
        outputUrl: 'https://cdn/job_1.png' })),
    downloadTo: async (url, dest) => {
      downloaded.push({ url, dest });
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, 'BYTES');
      return dest;
    },
  };
}

test('generateElementSheet saves output under sheets/<type>/vNNN and logs it', async () => {
  await withTemp(async (root) => {
    await createElement(root, { type: 'characters', name: 'cecilia' });
    const d = deps();
    const res = await generateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'turnaround',
      model: 'nano_banana', prompt: 'turnaround of cecilia',
    }, { runner: {}, ...d });

    // File landed under the element's sheets/turnaround dir, versioned.
    assert.match(res.outputPath, /elements\/characters\/cecilia\/sheets\/turnaround\/v001\./);
    assert.ok((await stat(res.outputPath)).isFile());

    // generations.jsonl got an entry with the job id + model + output path.
    const log = await readFile(
      path.join(root, 'elements', 'characters', 'cecilia', 'generations.jsonl'), 'utf8');
    const entry = JSON.parse(log.trim());
    assert.equal(entry.jobId, 'job_1');
    assert.equal(entry.model, 'nano_banana');
    assert.equal(entry.sheet, 'turnaround');
    assert.ok(entry.output.endsWith(path.basename(res.outputPath)));
  });
});

test('generateElementSheet passes reference images through as imageReferences', async () => {
  await withTemp(async (root) => {
    await createElement(root, { type: 'characters', name: 'cecilia' });
    const d = deps();
    let captured;
    const runBatch = async (runner, requests) => {
      captured = requests[0];
      return d.runBatch(runner, requests);
    };
    await generateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'pose',
      model: 'nano_banana', prompt: 'poses',
      images: ['/ref/drawing.png', '/ref/turnaround.png'],
    }, { runner: {}, runBatch, downloadTo: d.downloadTo });
    assert.deepEqual(captured.opts.imageReferences, ['/ref/drawing.png', '/ref/turnaround.png']);
  });
});

test('generateElementSheet omits imageReferences when no images are given', async () => {
  await withTemp(async (root) => {
    await createElement(root, { type: 'characters', name: 'cecilia' });
    const d = deps();
    let captured;
    const runBatch = async (runner, requests) => {
      captured = requests[0];
      return d.runBatch(runner, requests);
    };
    await generateElementSheet(root, {
      type: 'characters', name: 'cecilia', sheet: 'turnaround',
      model: 'nano_banana', prompt: 'x',
    }, { runner: {}, runBatch, downloadTo: d.downloadTo });
    assert.equal('imageReferences' in captured.opts, false);
  });
});

test('generateShotDraft saves output into the draft dir', async () => {
  await withTemp(async (root) => {
    await createShot(root, { shotId: 's1', elements: [] });
    const { dir } = await newDraft(root, 's1');
    const d = deps();
    const res = await generateShotDraft(root, {
      shotId: 's1', version: 1, model: 'seedance_2_0_mini', prompt: 'a shot',
    }, { runner: {}, ...d });
    assert.equal(path.dirname(res.outputPath), dir);
    assert.match(res.outputPath, /drafts\/v001\/output\./);
    assert.ok((await stat(res.outputPath)).isFile());
  });
});
