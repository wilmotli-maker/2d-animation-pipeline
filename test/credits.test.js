import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseTransactions,
  parseTransactionsJson,
  estimateCredits,
  collectLogEntries,
  reportFromLogs,
  formatReportTable,
  reconcile,
  tagCredits,
  resolveTask,
  backfillCredits,
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

const TX_JSON = [
  { action: 'spend', created_at: '2026-08-17T12:00:00.000Z', credits: -2, display_name: 'Nano Banana Pro' },
  { action: 'spend', created_at: '2026-08-17T13:00:00.000Z', credits: -2, display_name: 'Nano Banana Pro' },
  { action: 'spend', created_at: '2026-08-16T12:00:00.000Z', credits: -2, display_name: 'Nano Banana Pro' },
];

test('parseTransactionsJson extracts created_at, display_name, credits', () => {
  const rows = parseTransactionsJson(TX_JSON);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].model, 'Nano Banana Pro');
  assert.equal(rows[0].credits, -2);
});

test('parseTransactionsJson reads the live `items` payload shape', () => {
  // The real `account transactions --json` wraps rows under `items`.
  const rows = parseTransactionsJson({ cursor: '5', items: TX_JSON });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].model, 'Nano Banana Pro');
});

test('reconcile compares logged estimates to billed transactions', async () => {
  await withTemp(async (root) => {
    const elDir = path.join(root, 'elements', 'characters', 'cecilia');
    await mkdir(elDir, { recursive: true });
    const log = path.join(elDir, 'generations.jsonl');
    await appendFile(log, JSON.stringify({
      ts: '2026-08-17T10:00:00.000Z', jobId: 'j1', model: 'nano_banana_pro',
      credits: 2, status: 'generated',
    }) + '\n');
    await appendFile(log, JSON.stringify({
      ts: '2026-08-17T11:00:00.000Z', jobId: 'j2', model: 'nano_banana_pro',
      credits: 2, status: 'failed', failurePhase: 'generation', billedLikely: true,
    }) + '\n');

    const runner = {
      async fetchTransactions() {
        // Live API shape: rows under `items`, next cursor under `cursor`.
        return { items: TX_JSON, cursor: null };
      },
    };

    const report = await reconcile(root, {
      since: '2026-08-17T00:00:00.000Z',
      until: '2026-08-17T23:59:59.999Z',
      runner,
    });

    const row = report.rows.find((r) => r.model === 'nano_banana_pro');
    assert.ok(row);
    assert.equal(row.loggedAll, 4);
    assert.equal(row.loggedSaved, 2);
    assert.equal(row.billed, 4);
    assert.equal(row.gap, 0);
    assert.equal(row.gapSaved, 2);
  });
});

test('reconcile exclude-unbilled omits pre-submit failures from logged sum', async () => {
  await withTemp(async (root) => {
    const elDir = path.join(root, 'elements', 'characters', 'cecilia');
    await mkdir(elDir, { recursive: true });
    await appendFile(path.join(elDir, 'generations.jsonl'), JSON.stringify({
      ts: '2026-08-17T10:00:00.000Z', jobId: null, model: 'nano_banana_pro',
      credits: 2, status: 'failed', billedLikely: false,
    }) + '\n');
    await appendFile(path.join(elDir, 'generations.jsonl'), JSON.stringify({
      ts: '2026-08-17T11:00:00.000Z', jobId: 'j1', model: 'nano_banana_pro',
      credits: 2, status: 'generated',
    }) + '\n');

    const runner = {
      async fetchTransactions() {
        return { items: [TX_JSON[0]], cursor: null };
      },
    };

    const report = await reconcile(root, {
      since: '2026-08-17T00:00:00.000Z',
      until: '2026-08-17T23:59:59.999Z',
      excludeUnbilled: true,
      runner,
    });

    const row = report.rows.find((r) => r.model === 'nano_banana_pro');
    assert.equal(row.loggedAll, 2);
    assert.equal(row.billed, 2);
    assert.equal(row.gap, 0);
  });
});

test('reconcile counts entries with no estimate so gap is not misread', async () => {
  await withTemp(async (root) => {
    const shotDir = path.join(root, 'shots', 's1');
    await mkdir(shotDir, { recursive: true });
    // A video gen that billed but whose estimate was null (API miss/timeout):
    // logged stays 0, billed shows the spend — reconcile must flag the gap as
    // "no estimate", not silently imply untracked overhead.
    await appendFile(path.join(shotDir, 'generations.jsonl'), JSON.stringify({
      ts: '2026-08-17T10:00:00.000Z', jobId: 'v1', model: 'seedance_2_5',
      credits: null, status: 'generated', kind: 'shot',
    }) + '\n');

    const runner = {
      async fetchTransactions() {
        return {
          items: [{ action: 'spend', created_at: '2026-08-17T10:00:05.000Z', credits: -5, display_name: 'seedance_2_5' }],
          cursor: null,
        };
      },
    };

    const report = await reconcile(root, {
      since: '2026-08-17T00:00:00.000Z',
      until: '2026-08-17T23:59:59.999Z',
      runner,
    });

    const row = report.rows.find((r) => r.model === 'seedance_2_5');
    assert.ok(row);
    assert.equal(row.loggedAll, 0);
    assert.equal(row.billed, 5);
    assert.equal(row.gap, 5);
    assert.equal(row.unknownEstimates, 1);
  });
});

test('reconcile ignores entries with no timestamp (cannot be windowed)', async () => {
  await withTemp(async (root) => {
    const shotDir = path.join(root, 'shots', 's1', 'drafts', 'v001');
    await mkdir(shotDir, { recursive: true });
    // Legacy output.json with no ts and a credit value must not leak into an
    // unrelated reconcile window.
    await writeFile(path.join(shotDir, 'output.json'), JSON.stringify({
      jobId: 'legacy', model: 'nano_banana_pro', credits: 2, output: 'x.mp4',
    }) + '\n');

    const runner = { async fetchTransactions() { return { items: [], cursor: null }; } };
    const report = await reconcile(root, {
      since: '2026-08-17T00:00:00.000Z',
      until: '2026-08-17T23:59:59.999Z',
      runner,
    });
    assert.equal(report.rows.length, 0);
  });
});

test('resolveTask prefers spec.task over PIPELINE_TASK env', () => {
  const prev = process.env.PIPELINE_TASK;
  process.env.PIPELINE_TASK = 'from-env';
  try {
    assert.equal(resolveTask({ task: 'from-spec' }), 'from-spec');
    assert.equal(resolveTask({}), 'from-env');
    assert.equal(resolveTask(), 'from-env');
  } finally {
    if (prev == null) delete process.env.PIPELINE_TASK;
    else process.env.PIPELINE_TASK = prev;
  }
});

test('tagCredits rewrites matching jsonl lines and is idempotent', async () => {
  await withTemp(async (root) => {
    const elDir = path.join(root, 'elements', 'characters', 'cecilia');
    await mkdir(elDir, { recursive: true });
    const log = path.join(elDir, 'generations.jsonl');
    await appendFile(log, JSON.stringify({
      ts: '2026-08-17T10:00:00.000Z', jobId: 'j1', model: 'nano_banana_pro',
      credits: 2, status: 'generated', sheetType: 'turnaround', sheetId: 'winter',
    }) + '\n');
    await appendFile(log, JSON.stringify({
      ts: '2026-08-17T11:00:00.000Z', jobId: 'j2', model: 'nano_banana_pro',
      credits: 2, status: 'generated', task: 'existing',
    }) + '\n');

    const first = await tagCredits(root, {
      task: 'ep2-emotion-sheets',
      since: '2026-08-17T00:00:00.000Z',
      until: '2026-08-17T23:59:59.999Z',
    });
    assert.equal(first.tagged, 1);

    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(JSON.parse(lines[0]).task, 'ep2-emotion-sheets');
    assert.equal(JSON.parse(lines[1]).task, 'existing');

    const second = await tagCredits(root, {
      task: 'ep2-emotion-sheets',
      since: '2026-08-17T00:00:00.000Z',
    });
    assert.equal(second.tagged, 0);

    const report = await reportFromLogs(root, { task: 'ep2-emotion-sheets' });
    assert.equal(report.entryCount, 1);
  });
});

test('backfillCredits fills missing flat-rate credits and is idempotent', async () => {
  await withTemp(async (root) => {
    const elDir = path.join(root, 'elements', 'characters', 'cecilia');
    await mkdir(elDir, { recursive: true });
    const log = path.join(elDir, 'generations.jsonl');
    await appendFile(log, JSON.stringify({
      ts: '2026-08-17T10:00:00.000Z', jobId: 'j1', model: 'nano_banana_pro',
      status: 'generated',
    }) + '\n');
    await appendFile(log, JSON.stringify({
      ts: '2026-08-17T11:00:00.000Z', jobId: 'j2', model: 'seedance_2_0',
      status: 'generated',
    }) + '\n');

    const first = await backfillCredits(root);
    assert.equal(first.updated, 1);
    assert.equal(first.skipped, 1);

    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(JSON.parse(lines[0]).credits, 2);
    assert.equal(JSON.parse(lines[0]).creditsSource, 'table');
    assert.equal(JSON.parse(lines[1]).credits, undefined);

    const second = await backfillCredits(root);
    assert.equal(second.updated, 0);
    assert.equal(second.skipped, 2);
  });
});
