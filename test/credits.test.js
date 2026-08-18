import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseTransactions,
  estimateCredits,
  collectLogEntries,
  reportFromLogs,
  formatReportTable,
} from '../src/credits.js';

const SAMPLE = [
  'DATE              MODEL            CREDITS  ACTION',
  '2026-07-23 00:24  Nano Banana Pro  -2       spend',
  '2026-07-16 21:49  Seedance 2.0     -22.5    spend',
].join('\n');

test('parseTransactions extracts date, model, credits, action rows', () => {
  const rows = parseTransactions(SAMPLE);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    date: '2026-07-23 00:24', model: 'Nano Banana Pro', credits: -2, action: 'spend',
  });
  assert.equal(rows[1].model, 'Seedance 2.0');
  assert.equal(rows[1].credits, -22.5);
});

test('parseTransactions ignores the header and blank lines', () => {
  assert.equal(parseTransactions('\n' + SAMPLE + '\n').length, 2);
  assert.equal(parseTransactions('').length, 0);
});

test('estimateCredits returns table hit for flat-rate models in auto mode', async () => {
  const prev = process.env.PIPELINE_CREDITS_ESTIMATE_MODE;
  process.env.PIPELINE_CREDITS_ESTIMATE_MODE = 'auto';
  try {
    const res = await estimateCredits({ runner: {}, model: 'nano_banana_pro', prompt: 'x' });
    assert.deepEqual(res, { credits: 2, source: 'table' });
  } finally {
    if (prev == null) delete process.env.PIPELINE_CREDITS_ESTIMATE_MODE;
    else process.env.PIPELINE_CREDITS_ESTIMATE_MODE = prev;
  }
});

test('estimateCredits uses API fallback when table misses in auto mode', async () => {
  const prev = process.env.PIPELINE_CREDITS_ESTIMATE_MODE;
  process.env.PIPELINE_CREDITS_ESTIMATE_MODE = 'auto';
  try {
    const runner = { estimateCost: async () => 22.5 };
    const res = await estimateCredits({ runner, model: 'seedance_2_0', prompt: 'x' });
    assert.deepEqual(res, { credits: 22.5, source: 'api' });
  } finally {
    if (prev == null) delete process.env.PIPELINE_CREDITS_ESTIMATE_MODE;
    else process.env.PIPELINE_CREDITS_ESTIMATE_MODE = prev;
  }
});

test('estimateCredits returns unknown on API failure', async () => {
  const prev = process.env.PIPELINE_CREDITS_ESTIMATE_MODE;
  process.env.PIPELINE_CREDITS_ESTIMATE_MODE = 'api';
  try {
    const runner = { estimateCost: async () => { throw new Error('fail'); } };
    const res = await estimateCredits({ runner, model: 'seedance_2_0', prompt: 'x' });
    assert.deepEqual(res, { credits: null, source: 'unknown' });
  } finally {
    if (prev == null) delete process.env.PIPELINE_CREDITS_ESTIMATE_MODE;
    else process.env.PIPELINE_CREDITS_ESTIMATE_MODE = prev;
  }
});

test('estimateCredits table mode returns null for unknown models', async () => {
  const prev = process.env.PIPELINE_CREDITS_ESTIMATE_MODE;
  process.env.PIPELINE_CREDITS_ESTIMATE_MODE = 'table';
  try {
    const res = await estimateCredits({ runner: {}, model: 'seedance_2_0', prompt: 'x' });
    assert.deepEqual(res, { credits: null, source: 'unknown' });
  } finally {
    if (prev == null) delete process.env.PIPELINE_CREDITS_ESTIMATE_MODE;
    else process.env.PIPELINE_CREDITS_ESTIMATE_MODE = prev;
  }
});

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'credits-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('collectLogEntries dedupes legacy output.json when jsonl has same jobId', async () => {
  await withTemp(async (root) => {
    const elDir = path.join(root, 'elements', 'characters', 'cecilia');
    await mkdir(elDir, { recursive: true });
    await appendFile(path.join(elDir, 'generations.jsonl'),
      JSON.stringify({ ts: '2026-08-17T00:00:00.000Z', jobId: 'job_a', model: 'nano_banana_pro',
        credits: 2, status: 'generated', sheetType: 'turnaround', sheetId: 'winter' }) + '\n');

    const shotDir = path.join(root, 'shots', 's1', 'drafts', 'v001');
    await mkdir(shotDir, { recursive: true });
    await writeFile(path.join(shotDir, 'output.json'), JSON.stringify({
      jobId: 'job_a', model: 'seedance_2_0', credits: 99,
    }));

    const entries = await collectLogEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].jobId, 'job_a');
    assert.equal(entries[0].credits, 2);
  });
});

test('reportFromLogs aggregates by sheet and counts unknown credits', async () => {
  await withTemp(async (root) => {
    const elDir = path.join(root, 'elements', 'characters', 'cecilia');
    await mkdir(elDir, { recursive: true });
    const log = path.join(elDir, 'generations.jsonl');
    await appendFile(log, JSON.stringify({
      ts: '2026-08-17T10:00:00.000Z', jobId: 'j1', model: 'nano_banana_pro',
      credits: 2, status: 'generated', sheetType: 'turnaround', sheetId: 'winter',
    }) + '\n');
    await appendFile(log, JSON.stringify({
      ts: '2026-08-17T11:00:00.000Z', jobId: 'j2', model: 'seedance_2_0',
      status: 'generated', sheetType: 'turnaround', sheetId: 'winter',
    }) + '\n');

    const report = await reportFromLogs(root, { by: 'sheet' });
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].key, 'cecilia/turnaround/winter');
    assert.equal(report.rows[0].saved, 2);
    assert.equal(report.rows[0].creditsAll, 2);
    assert.equal(report.unknownCount, 1);
    assert.match(formatReportTable(report), /cecilia\/turnaround\/winter/);
  });
});

test('reportFromLogs falls back to kind grouping when shots are present', async () => {
  await withTemp(async (root) => {
    const shotDir = path.join(root, 'shots', 's1', 'drafts', 'v001');
    await mkdir(shotDir, { recursive: true });
    await writeFile(path.join(shotDir, 'output.json'), JSON.stringify({
      jobId: 'j3', model: 'seedance_2_0', credits: 10, kind: 'shot',
      ts: '2026-08-17T12:00:00.000Z',
    }));

    const report = await reportFromLogs(root, { by: 'sheet' });
    assert.equal(report.by, 'kind');
    assert.ok(report.rows.some((r) => r.key === 'shot'));
  });
});

test('reportFromLogs filters by since/until', async () => {
  await withTemp(async (root) => {
    const elDir = path.join(root, 'elements', 'characters', 'cecilia');
    await mkdir(elDir, { recursive: true });
    const log = path.join(elDir, 'generations.jsonl');
    await appendFile(log, JSON.stringify({
      ts: '2026-08-16T10:00:00.000Z', jobId: 'old', credits: 2, status: 'generated',
      sheetType: 'turnaround', sheetId: 'winter', model: 'nano_banana_pro',
    }) + '\n');
    await appendFile(log, JSON.stringify({
      ts: '2026-08-17T10:00:00.000Z', jobId: 'new', credits: 2, status: 'generated',
      sheetType: 'turnaround', sheetId: 'winter', model: 'nano_banana_pro',
    }) + '\n');

    const report = await reportFromLogs(root, {
      since: '2026-08-17T00:00:00.000Z',
      until: '2026-08-17T23:59:59.999Z',
    });
    assert.equal(report.entryCount, 1);
    assert.equal(report.totalAll, 2);
  });
});
