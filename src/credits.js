import { readdir, readFile, access, appendFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { MODEL_CREDITS, creditsEstimateMode, ELEMENT_TYPES, MODEL_DISPLAY_NAME } from './config.js';
import { generationsLogPath, imageGenerationsLogPath, shotDir, shotDraftsDir, shotGenerationsLogPath, taskStatePath } from './paths.js';
import { appendGeneration } from './element.js';

const ESTIMATE_TIMEOUT_MS = 5000;

// Parse the `higgsfield account transactions` table — the authoritative record
// of credit spend (the account/workspace `credits` balance field is cached and
// unreliable, per sanity check 4). Columns: DATE(YYYY-MM-DD HH:MM) MODEL CREDITS
// ACTION, whitespace-separated with a multi-word MODEL in the middle.
const ROW_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(.+?)\s+(-?\d+(?:\.\d+)?)\s+(\S+)\s*$/;

export function parseTransactions(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    const m = ROW_RE.exec(line);
    if (!m) continue; // header, blanks, and malformed lines skipped
    rows.push({ date: m[1], model: m[2].trim(), credits: Number(m[3]), action: m[4] });
  }
  return rows;
}

/** Parse `account transactions --json` rows. */
export function parseTransactionsJson(data) {
  // Live API wraps rows under `items` (next cursor under `cursor`); older mocks
  // used `transactions`/`rows`. Accept all so reconcile works against the real
  // CLI, not just fixtures.
  const list = Array.isArray(data)
    ? data
    : (data?.items ?? data?.transactions ?? data?.rows ?? []);
  return list.map((row) => ({
    createdAt: row.created_at ?? row.createdAt ?? row.date,
    model: row.display_name ?? row.model ?? '',
    credits: Number(row.credits ?? 0),
    action: row.action ?? 'spend',
  })).filter((row) => row.createdAt && row.model);
}

const TX_PAGE_SIZE = 100;
const TX_MAX_PAGES = 500; // safety cap: never walk forever on a stable cursor

async function fetchAllTransactions(runner, { since } = {}) {
  const rows = [];
  let cursor = null;
  const sinceMs = since ? Date.parse(since) : null;

  for (let page = 0; page < TX_MAX_PAGES; page++) {
    const resp = await runner.fetchTransactions({ size: TX_PAGE_SIZE, cursor });
    const batch = parseTransactionsJson(resp);
    if (!batch.length) break;
    rows.push(...batch);

    const oldest = batch.reduce((min, r) => {
      const t = Date.parse(r.createdAt);
      return t < min ? t : min;
    }, Infinity);

    const nextCursor = resp?.next_cursor ?? resp?.cursor ?? null;
    // Stop on: no cursor, a cursor that didn't advance (would loop), a short
    // final page, or once we've paged past the requested window.
    if (!nextCursor || nextCursor === cursor) break;
    if (batch.length < TX_PAGE_SIZE) break;
    if (sinceMs != null && oldest <= sinceMs) break;
    cursor = nextCursor;
  }

  return rows;
}

function modelDisplayToSlug(displayName, displayMap = MODEL_DISPLAY_NAME) {
  for (const [slug, name] of Object.entries(displayMap)) {
    if (name === displayName) return slug;
  }
  return displayName;
}

/** Compare logged estimates to billed account transactions for a time window. */
export async function reconcile(root, {
  since, until, excludeUnbilled = false, runner,
} = {}) {
  if (!runner?.fetchTransactions) {
    throw new Error('reconcile requires a runner with fetchTransactions()');
  }

  const sinceMs = since ? Date.parse(since) : null;
  const untilMs = until ? Date.parse(until) : null;

  let entries = await collectLogEntries(root);
  // Reconcile is strictly windowed — an entry with no parseable timestamp can't
  // be placed against billed rows, so drop it rather than counting it in every
  // window (report keeps them; reconcile must not).
  entries = entries.filter((e) => {
    if (!e.ts) return false;
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) return false;
    if (sinceMs != null && t < sinceMs) return false;
    if (untilMs != null && t > untilMs) return false;
    return true;
  });
  if (excludeUnbilled) {
    entries = entries.filter((e) => e.billedLikely !== false);
  }

  const txRows = await fetchAllTransactions(runner, { since });
  const billedRows = txRows.filter((row) => {
    const t = Date.parse(row.createdAt);
    if (Number.isNaN(t)) return false;
    if (sinceMs != null && t < sinceMs) return false;
    if (untilMs != null && t > untilMs) return false;
    return row.action === 'spend' || row.credits < 0;
  });

  const loggedByModel = new Map();
  const loggedSavedByModel = new Map();
  const unknownByModel = new Map(); // entries with no credit estimate (credits == null)

  for (const e of entries) {
    const key = e.model || '—';
    if (!loggedByModel.has(key)) loggedByModel.set(key, 0);
    loggedByModel.set(key, loggedByModel.get(key) + (e.credits ?? 0));

    if (e.credits == null) {
      unknownByModel.set(key, (unknownByModel.get(key) ?? 0) + 1);
    }

    if (e.status !== 'failed') {
      if (!loggedSavedByModel.has(key)) loggedSavedByModel.set(key, 0);
      loggedSavedByModel.set(key, loggedSavedByModel.get(key) + (e.credits ?? 0));
    }
  }

  const billedBySlug = new Map();
  for (const row of billedRows) {
    const slug = modelDisplayToSlug(row.model);
    const amount = Math.abs(row.credits);
    billedBySlug.set(slug, (billedBySlug.get(slug) ?? 0) + amount);
  }

  const models = new Set([
    ...loggedByModel.keys(),
    ...loggedSavedByModel.keys(),
    ...billedBySlug.keys(),
  ]);

  const rows = [];
  for (const model of [...models].sort()) {
    const loggedAll = loggedByModel.get(model) ?? 0;
    const loggedSaved = loggedSavedByModel.get(model) ?? 0;
    const billed = billedBySlug.get(model) ?? 0;
    rows.push({
      model,
      loggedSaved,
      loggedAll,
      billed,
      gap: billed - loggedAll,
      gapSaved: billed - loggedSaved,
      unknownEstimates: unknownByModel.get(model) ?? 0,
    });
  }

  return { rows, since, until, excludeUnbilled };
}

export function formatReconcileTable(report) {
  const lines = [];
  lines.push(`${'MODEL'.padEnd(20)} LOGGED_SAVED  LOGGED_ALL  BILLED  GAP`);
  for (const row of report.rows) {
    // A gap next to un-estimated entries is likely missing estimates, not
    // untracked spend — flag it so the two aren't conflated.
    const note = row.unknownEstimates ? `  (${row.unknownEstimates} w/o estimate)` : '';
    lines.push(
      `${row.model.padEnd(20)} ${String(row.loggedSaved).padEnd(13)} ${String(row.loggedAll).padEnd(11)} ${String(row.billed).padEnd(7)} ${row.gap}${note}`,
    );
  }
  return lines.join('\n');
}

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export function resolveTask(spec = {}) {
  return spec.task ?? process.env.PIPELINE_TASK ?? null;
}

/** Read the project's active task label (set by `pipeline task set`), or null. */
export async function readTaskState(root) {
  try {
    const label = (await readFile(taskStatePath(root), 'utf8')).trim();
    return label || null;
  } catch {
    return null;
  }
}

/** Persist the project's active task label. */
export async function setTaskState(root, label) {
  const trimmed = String(label ?? '').trim();
  if (!trimmed) throw new Error('task label is required');
  const p = taskStatePath(root);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, trimmed + '\n');
  return trimmed;
}

/** Clear the project's active task. Returns true if one was set. */
export async function clearTaskState(root) {
  try {
    await rm(taskStatePath(root));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the task for a generation: explicit --task, then PIPELINE_TASK env,
 * then the project's persisted active task. Env still overrides the state file
 * so a one-off `PIPELINE_TASK=… pipeline …` wins for that command.
 */
export async function resolveActiveTask(root, spec = {}) {
  return resolveTask(spec) ?? await readTaskState(root);
}

/** Estimate credits for a generation attempt. Never throws — returns null on failure. */
export async function estimateCredits({ runner, model, prompt, images, ...opts } = {}) {
  const mode = creditsEstimateMode();
  const tableHit = MODEL_CREDITS[model];

  if (mode === 'table' || (mode === 'auto' && tableHit != null)) {
    if (tableHit != null) return { credits: tableHit, source: 'table' };
    return { credits: null, source: 'unknown' };
  }

  if (mode === 'api' || mode === 'auto') {
    try {
      const genOpts = { prompt, ...opts };
      if (images?.length) genOpts.imageReferences = images;
      const result = await withTimeout(
        runner.estimateCost(model, genOpts),
        ESTIMATE_TIMEOUT_MS,
      );
      if (result == null) return { credits: null, source: 'unknown' };
      return { credits: result, source: 'api' };
    } catch {
      return { credits: null, source: 'unknown' };
    }
  }

  return { credits: null, source: 'unknown' };
}

export async function appendShotGeneration(root, shotId, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  await appendFile(shotGenerationsLogPath(root, shotId), line);
}

export async function appendImageGeneration(root, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  await mkdir(path.dirname(imageGenerationsLogPath(root)), { recursive: true });
  await appendFile(imageGenerationsLogPath(root), line);
}

/** Write a credit log entry to the correct store for element, shot, or upscale. */
export async function recordCreditAttempt(root, location, entry) {
  if (location.kind === 'element') {
    await appendGeneration(root, location.type, location.name, entry);
    return;
  }
  if (location.kind === 'shot' || location.kind === 'upscale') {
    await appendShotGeneration(root, location.shotId, entry);
    return;
  }
  if (location.kind === 'image') {
    await appendImageGeneration(root, entry);
    return;
  }
  throw new Error(`unknown credit log location kind: ${location.kind}`);
}

function normalizeEntry(raw, meta = {}) {
  return {
    ts: raw.ts || null,
    model: raw.model || null,
    jobId: raw.jobId || null,
    credits: raw.credits ?? null,
    creditsSource: raw.creditsSource || null,
    status: raw.status || 'generated',
    kind: raw.kind || meta.kind || null,
    sheetType: raw.sheetType || null,
    sheetId: raw.sheetId || null,
    elementType: meta.elementType || null,
    elementName: meta.elementName || null,
    shotId: meta.shotId || null,
    task: raw.task || null,
    billedLikely: raw.billedLikely ?? null,
    failurePhase: raw.failurePhase || null,
    error: raw.error || null,
  };
}

async function readJsonl(filePath) {
  if (!await exists(filePath)) return [];
  const text = await readFile(filePath, 'utf8');
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

async function walkElementLogs(root) {
  const entries = [];
  for (const type of ELEMENT_TYPES) {
    const typeDir = path.join(root, 'elements', type);
    if (!await exists(typeDir)) continue;
    for (const name of await readdir(typeDir)) {
      const logPath = generationsLogPath(root, type, name);
      for (const raw of await readJsonl(logPath)) {
        entries.push(normalizeEntry(raw, {
          kind: raw.kind || 'element',
          elementType: type,
          elementName: name,
        }));
      }
    }
  }
  return entries;
}

async function walkShotJsonl(root) {
  const entries = [];
  const shotsRoot = path.join(root, 'shots');
  if (!await exists(shotsRoot)) return entries;
  for (const shotId of await readdir(shotsRoot)) {
    const logPath = path.join(shotDir(root, shotId), 'generations.jsonl');
    for (const raw of await readJsonl(logPath)) {
      entries.push(normalizeEntry(raw, { shotId, kind: raw.kind || 'shot' }));
    }
  }
  return entries;
}

async function walkImageJsonl(root) {
  const file = imageGenerationsLogPath(root);
  const entries = [];
  for (const raw of await readJsonl(file)) {
    entries.push(normalizeEntry(raw, { kind: raw.kind || 'upscale' }));
  }
  return entries;
}

async function walkLegacyOutputs(root) {
  const entries = [];
  const shotsRoot = path.join(root, 'shots');
  if (!await exists(shotsRoot)) return entries;
  for (const shotId of await readdir(shotsRoot)) {
    const draftsDir = shotDraftsDir(root, shotId);
    if (!await exists(draftsDir)) continue;
    for (const draft of await readdir(draftsDir)) {
      const outputJson = path.join(draftsDir, draft, 'output.json');
      if (!await exists(outputJson)) continue;
      try {
        const raw = JSON.parse(await readFile(outputJson, 'utf8'));
        entries.push(normalizeEntry({
          ...raw,
          status: 'generated',
          ts: raw.ts || null,
        }, { shotId, kind: 'shot' }));
      } catch {
        // skip
      }
    }
    // Upscale sidecars live beside the clip they enlarged — final/ or
    // drafts/vN/ (never directly under shots/<id>/), so only those dirs are
    // scanned. New upscales also write generations.jsonl; collectLogEntries
    // dedupes the two by jobId.
    const shotRoot = shotDir(root, shotId);
    for (const sub of ['final', ...await readdir(draftsDir).catch(() => [])]) {
      const subDir = path.join(shotRoot, sub === 'final' ? 'final' : path.join('drafts', sub));
      if (!await exists(subDir)) continue;
      for (const file of await readdir(subDir)) {
        if (!file.endsWith('.json') || !file.startsWith('upscaled-')) continue;
        const sidecarPath = path.join(subDir, file);
        try {
          const raw = JSON.parse(await readFile(sidecarPath, 'utf8'));
          entries.push(normalizeEntry({
            ...raw,
            status: 'generated',
            ts: raw.upscaledAt || null,
          }, { shotId, kind: 'upscale' }));
        } catch {
          // skip
        }
      }
    }
  }
  return entries;
}

/** Collect all credit log entries, deduping legacy output.json by jobId when jsonl exists. */
export async function collectLogEntries(root) {
  const fromJsonl = [
    ...await walkElementLogs(root),
    ...await walkShotJsonl(root),
    ...await walkImageJsonl(root),
  ];
  const jsonlJobIds = new Set(fromJsonl.map((e) => e.jobId).filter(Boolean));
  const legacy = (await walkLegacyOutputs(root)).filter(
    (e) => !e.jobId || !jsonlJobIds.has(e.jobId),
  );
  return [...fromJsonl, ...legacy];
}

function entryInWindow(entry, since, until) {
  if (!entry.ts) return true;
  const t = Date.parse(entry.ts);
  if (Number.isNaN(t)) return true;
  if (since && t < Date.parse(since)) return false;
  if (until && t > Date.parse(until)) return false;
  return true;
}

function groupKey(entry, by) {
  switch (by) {
    case 'element':
      return entry.elementName ? `${entry.elementType}/${entry.elementName}` : '—';
    case 'sheet':
      if (entry.sheetType && entry.sheetId && entry.elementName) {
        return `${entry.elementName}/${entry.sheetType}/${entry.sheetId}`;
      }
      return '—';
    case 'shot':
      return entry.shotId || '—';
    case 'day':
      return entry.ts ? entry.ts.slice(0, 10) : '—';
    case 'model':
      return entry.model || '—';
    case 'task':
      return entry.task || '—';
    case 'kind':
      return entry.kind || '—';
    default:
      return '—';
  }
}

function sumCredits(entries) {
  let total = 0;
  let unknown = 0;
  for (const e of entries) {
    if (e.credits == null) { unknown++; continue; }
    total += e.credits;
  }
  return { total, unknown };
}

/** Aggregate logged credit estimates from project files. */
export async function reportFromLogs(root, {
  type, name, sheet, since, until, task, by = 'sheet', savedOnly = false,
} = {}) {
  let entries = await collectLogEntries(root);

  if (type) entries = entries.filter((e) => e.elementType === type);
  if (name) entries = entries.filter((e) => e.elementName === name);
  if (sheet) entries = entries.filter((e) => e.sheetType === sheet || e.sheetId === sheet);
  if (task) entries = entries.filter((e) => e.task === task);
  if (since || until) entries = entries.filter((e) => entryInWindow(e, since, until));
  if (savedOnly) entries = entries.filter((e) => e.status !== 'failed');

  const hasNonSheet = entries.some((e) => !e.sheetType || !e.sheetId);
  const effectiveBy = by === 'sheet' && hasNonSheet ? 'kind' : by;

  const groups = new Map();
  for (const e of entries) {
    const key = groupKey(e, effectiveBy);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const rows = [];
  for (const [key, groupEntries] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const saved = groupEntries.filter((e) => e.status !== 'failed');
    const failed = groupEntries.filter((e) => e.status === 'failed');
    const savedSum = sumCredits(saved);
    const allSum = sumCredits(groupEntries);
    rows.push({
      key,
      saved: saved.length,
      failed: failed.length,
      creditsSaved: savedSum.total,
      creditsAll: allSum.total,
      unknownCredits: allSum.unknown,
    });
  }

  const allSaved = entries.filter((e) => e.status !== 'failed');
  const savedTotals = sumCredits(allSaved);
  const allTotals = sumCredits(entries);

  return {
    by: effectiveBy,
    rows,
    totalSaved: savedTotals.total,
    totalAll: allTotals.total,
    unknownCount: allTotals.unknown,
    entryCount: entries.length,
  };
}

export function formatReportTable(report) {
  const lines = [];
  const hdr = `${report.by.toUpperCase().padEnd(30)} SAVED  FAILED  CREDITS`;
  lines.push(hdr);
  for (const row of report.rows) {
    const credits = row.creditsAll != null && row.unknownCredits === 0
      ? String(row.creditsAll)
      : row.unknownCredits > 0 ? `${row.creditsAll}+?` : '?';
    lines.push(`${row.key.padEnd(30)} ${String(row.saved).padEnd(6)} ${String(row.failed).padEnd(7)} ${credits}`);
  }
  lines.push(`TOTAL (saved)${' '.repeat(30)}${report.totalSaved}`);
  lines.push(`TOTAL (incl. failed)${' '.repeat(23)}${report.totalAll}${report.unknownCount ? ` (+${report.unknownCount} unknown)` : ''}`);
  return lines.join('\n');
}

function entryMatchesTagFilters(entry, { since, until, sheet, type, name }) {
  if (!entryInWindow(entry, since, until)) return false;
  if (type && entry.elementType !== type) return false;
  if (name && entry.elementName !== name) return false;
  if (sheet && entry.sheetType !== sheet && entry.sheetId !== sheet) return false;
  return true;
}

async function tagJsonlFile(filePath, { task, since, until, sheet, type, name, meta = {} }) {
  if (!await exists(filePath)) return 0;
  const rawText = await readFile(filePath, 'utf8');
  let tagged = 0;
  const out = [];
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      out.push(line);
      continue;
    }
    const normalized = normalizeEntry(entry, meta);
    if (!entry.task && entryMatchesTagFilters(normalized, { since, until, sheet, type, name })) {
      entry.task = task;
      tagged++;
    }
    out.push(JSON.stringify(entry));
  }
  if (tagged > 0) {
    await writeFile(filePath, out.join('\n') + (out.length ? '\n' : ''));
  }
  return tagged;
}

/** Retro-label existing jsonl entries that match filters and lack a task. */
export async function tagCredits(root, {
  task, since, until, sheet, type, name,
} = {}) {
  if (!task) throw new Error('tag requires --task <label>');
  let tagged = 0;

  for (const elType of ELEMENT_TYPES) {
    const typeDir = path.join(root, 'elements', elType);
    if (!await exists(typeDir)) continue;
    for (const elName of await readdir(typeDir)) {
      if (type && elType !== type) continue;
      if (name && elName !== name) continue;
      tagged += await tagJsonlFile(generationsLogPath(root, elType, elName), {
        task, since, until, sheet, type: elType, name: elName,
        meta: { kind: 'element', elementType: elType, elementName: elName },
      });
    }
  }

  const shotsRoot = path.join(root, 'shots');
  if (await exists(shotsRoot)) {
    for (const shotId of await readdir(shotsRoot)) {
      tagged += await tagJsonlFile(shotGenerationsLogPath(root, shotId), {
        task, since, until, sheet, type, name,
        meta: { shotId, kind: 'shot' },
      });
    }
  }

  return { tagged, task };
}

async function backfillJsonlFile(filePath, { type, name, sheet, since, until, meta = {} }) {
  if (!await exists(filePath)) return { updated: 0, skipped: 0 };
  const rawText = await readFile(filePath, 'utf8');
  let updated = 0;
  let skipped = 0;
  const out = [];
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      out.push(line);
      continue;
    }
    const normalized = normalizeEntry(entry, meta);
    if (!entryMatchesTagFilters(normalized, { since, until, sheet, type, name })) {
      out.push(JSON.stringify(entry));
      continue;
    }
    if (entry.credits != null) {
      skipped++;
      out.push(JSON.stringify(entry));
      continue;
    }
    const tableHit = MODEL_CREDITS[entry.model];
    if (tableHit == null) {
      skipped++;
      out.push(JSON.stringify(entry));
      continue;
    }
    entry.credits = tableHit;
    entry.creditsSource = 'table';
    updated++;
    out.push(JSON.stringify(entry));
  }
  if (updated > 0) {
    await writeFile(filePath, out.join('\n') + (out.length ? '\n' : ''));
  }
  return { updated, skipped };
}

/** Fill missing flat-rate credits on existing jsonl entries from MODEL_CREDITS. */
export async function backfillCredits(root, {
  type, name, sheet, since, until,
} = {}) {
  let updated = 0;
  let skipped = 0;

  for (const elType of ELEMENT_TYPES) {
    const typeDir = path.join(root, 'elements', elType);
    if (!await exists(typeDir)) continue;
    for (const elName of await readdir(typeDir)) {
      if (type && elType !== type) continue;
      if (name && elName !== name) continue;
      const res = await backfillJsonlFile(generationsLogPath(root, elType, elName), {
        type: elType, name: elName, sheet, since, until,
        meta: { kind: 'element', elementType: elType, elementName: elName },
      });
      updated += res.updated;
      skipped += res.skipped;
    }
  }

  const shotsRoot = path.join(root, 'shots');
  if (await exists(shotsRoot)) {
    for (const shotId of await readdir(shotsRoot)) {
      const res = await backfillJsonlFile(shotGenerationsLogPath(root, shotId), {
        type, name, sheet, since, until,
        meta: { shotId, kind: 'shot' },
      });
      updated += res.updated;
      skipped += res.skipped;
    }
  }

  return { updated, skipped };
}
