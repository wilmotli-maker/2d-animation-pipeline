// test/studio-matte-preview.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PREVIEW_BGS, buildPreviewArgs, previewRelPath, createPreviewer, runFfmpeg,
} from '../src/studio/matte-preview.js';

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-mpv-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function seedAlpha(root, rel) {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), 'alpha');
}
// Fake ffmpeg: records calls, writes the output file (last arg) after a tick.
function fakeRun({ fail = false } = {}) {
  const calls = []; let active = 0; let maxActive = 0;
  const run = async (args) => {
    calls.push(args); active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    if (fail) throw new Error('ffmpeg exit 1: boom');
    await writeFile(args[args.length - 1], 'mp4');
  };
  return { run, calls, max: () => maxActive };
}

test('PREVIEW_BGS: the standard background set', () => {
  assert.deepEqual(Object.keys(PREVIEW_BGS), ['checker', 'white', 'black', 'gray', 'green']);
});

test('buildPreviewArgs: checker uses geq; solid uses drawbox color; webm forces libvpx decoder', () => {
  const c = buildPreviewArgs('/p/alpha.mov', '/o.mp4', 'checker');
  const graph = c[c.indexOf('-filter_complex') + 1];
  assert.match(graph, /geq=lum=/);
  assert.match(graph, /overlay=format=auto/);
  assert.ok(!c.includes('libvpx-vp9'));
  assert.equal(c[c.length - 1], '/o.mp4');
  const g = buildPreviewArgs('/p/alpha.webm', '/o.mp4', 'green');
  assert.match(g[g.indexOf('-filter_complex') + 1], /drawbox=.*color=0x00B140/);
  assert.ok(g.indexOf('libvpx-vp9') < g.indexOf('-i'), 'decoder flag must precede -i');
  assert.throws(() => buildPreviewArgs('/p/a.mov', '/o.mp4', 'plaid'), /unknown bg/);
});

test('previewRelPath mirrors the source under .pipeline/studio/previews', () => {
  assert.equal(previewRelPath('shots/a/drafts/v001/alpha.mov', 'checker'),
    path.join('.pipeline', 'studio', 'previews', 'shots', 'a', 'drafts', 'v001', 'alpha.checker.mp4'));
});

test('previewer: pending -> dedupes in-flight -> ready; re-renders when source is newer', async () => {
  await withTempRoot(async (root) => {
    const rel = 'shots/a/drafts/v001/alpha.mov';
    await seedAlpha(root, rel);
    const f = fakeRun();
    const pv = createPreviewer({ root, run: f.run });
    assert.deepEqual(await pv.request(rel, 'checker'), { state: 'pending' });
    assert.deepEqual(await pv.request(rel, 'checker'), { state: 'pending' });
    await pv.drain();
    assert.equal(f.calls.length, 1);
    const ready = await pv.request(rel, 'checker');
    assert.equal(ready.state, 'ready');
    assert.equal(ready.url, '/media/.pipeline/studio/previews/shots/a/drafts/v001/alpha.checker.mp4');
    assert.ok((await stat(path.join(root, previewRelPath(rel, 'checker')))).isFile());
    // Re-pulled matte: source mtime moves past the preview's.
    const future = new Date(Date.now() + 60_000);
    await utimes(path.join(root, rel), future, future);
    assert.deepEqual(await pv.request(rel, 'checker'), { state: 'pending' });
    await pv.drain();
    assert.equal(f.calls.length, 2);
  });
});

test('previewer: concurrency limit, failures are sticky per source version, missing source', async () => {
  await withTempRoot(async (root) => {
    const rels = ['a', 'b', 'c', 'd'].map((s) => `shots/${s}/drafts/v001/alpha.mov`);
    for (const r of rels) await seedAlpha(root, r);
    const f = fakeRun();
    const pv = createPreviewer({ root, run: f.run, concurrency: 2 });
    for (const r of rels) await pv.request(r, 'white');
    await pv.drain();
    assert.equal(f.max(), 2);

    const bad = fakeRun({ fail: true });
    const pv2 = createPreviewer({ root, run: bad.run });
    await pv2.request(rels[0], 'black');
    await pv2.drain();
    const err = await pv2.request(rels[0], 'black');
    assert.equal(err.state, 'error');
    assert.match(err.error, /boom/);
    assert.equal(bad.calls.length, 1, 'no retry loop until the source changes');

    assert.deepEqual(await pv.request('shots/zzz/alpha.mov', 'checker'), { state: 'error', error: 'source not found' });
    await assert.rejects(pv.request(rels[0], 'plaid'), /unknown bg/);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('previewer + real ffmpeg: ProRes 4444 alpha composites to an mp4', { skip: !hasFfmpeg && 'ffmpeg not on PATH' }, async () => {
  await withTempRoot(async (root) => {
    const rel = 'shots/a/drafts/v001/alpha.mov';
    await mkdir(path.join(root, 'shots/a/drafts/v001'), { recursive: true });
    const src = "color=c=red:s=64x48:d=0.2,format=rgba,geq=r=255:g=0:b=0:a='if(lt(X,32),255,0)'";
    assert.equal(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', src,
      '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', path.join(root, rel)]).status, 0);
    const pv = createPreviewer({ root, run: runFfmpeg });
    await pv.request(rel, 'checker');
    await pv.drain();
    const r = await pv.request(rel, 'checker');
    assert.equal(r.state, 'ready', JSON.stringify(r));
    assert.ok((await stat(path.join(root, previewRelPath(rel, 'checker')))).size > 0);
  });
});
