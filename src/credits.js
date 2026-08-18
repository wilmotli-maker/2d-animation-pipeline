import { readdir, readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { MODEL_CREDITS, creditsEstimateMode, ELEMENT_TYPES } from './config.js';
import { generationsLogPath, shotDir, shotDraftsDir } from './paths.js';

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
    const shotRoot = shotDir(root, shotId);
    for (const file of await readdir(shotRoot)) {
      if (!file.endsWith('.json') || !file.startsWith('upscaled-')) continue;
      const sidecarPath = path.join(shotRoot, file);
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
  const fromJsonl = [...await walkElementLogs(root), ...await walkShotJsonl(root)];
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
