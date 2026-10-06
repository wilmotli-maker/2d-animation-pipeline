#!/usr/bin/env node
// Splice each generated edit back into its source clip using splice-match.js, with the seam
// mode set by the edit position. Runs only on cases whose generation output exists. No credits.
//
//   node splice.js [--shot <name>] [--only <caseId>] [--blend 0] [--lipsync | --lipsync2]
//
// first-frame edit -> seam head (keep original tail); last -> seam tail (keep original head);
// middle -> seam mid (keep both). Windows are derived from the shot duration.
//
// --lipsync: splice the lip-sync variant instead (kf5/middle __lipsync cases). The regenerated
// middle now carries the same lip sync as the untouched head/tail, so the seams stay
// lip-consistent. Output -> spliced-lipsync.mp4 / splice-lipsync.json (does not clobber the
// silent variant's spliced.mp4).

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MATCH = path.join(here, '..', 'splice-match.js');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : (process.argv[i + 1] ?? true); };
const ONLY = arg('only'); const SHOT = arg('shot'); const BLEND = arg('blend') ?? '0';
const LIPSYNC = process.argv.includes('--lipsync');
const LIPSYNC2 = process.argv.includes('--lipsync2');

// lip-sync variants: synthetic kf5/middle cases with an id suffix (seam always mid).
// --lipsync  = single-pass variant (__lipsync)        -> spliced-lipsync.mp4
// --lipsync2 = two-stage video_edit variant (__lipsync2) -> spliced-lipsync2.mp4
const lipsyncCases = (suffix, outName, reportName) => C.SHOTS.map((s) => ({
  id: `${s.shot}__kf5__middle__${suffix}`, shot: s.shot, variant: 'kf5', position: 'middle',
  seam: 'mid', outName, reportName,
}));
const chosen = LIPSYNC2
  ? lipsyncCases('lipsync2', 'spliced-lipsync2.mp4', 'splice-lipsync2.json')
  : LIPSYNC
    ? lipsyncCases('lipsync', 'spliced-lipsync.mp4', 'splice-lipsync.json')
    : C.cases();
const CASES = chosen.map((c) => ({ outName: 'spliced.mp4', reportName: 'splice.json', ...c }));

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
function run(bin, args) {
  return new Promise((res) => {
    const c = spawn(bin, args, { stdio: 'inherit' });
    c.on('close', (code) => res(code));
  });
}
async function dur(f) {
  return new Promise((res) => {
    const c = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => res(Number(o.trim())));
  });
}

for (const c of CASES) {
  if (ONLY && c.id !== ONLY) continue;
  if (SHOT && c.shot !== SHOT) continue;
  const orig = path.join(C.EVAL_ROOT, 'sources', `${c.shot}.mp4`);
  const gen = path.join(C.SCRATCH, 'shots', c.id, 'drafts', 'v001', 'output.mp4');
  const caseDir = C.caseDir(C.EVAL_ROOT, c.shot, c.variant, c.position);
  const out = path.join(caseDir, c.outName);
  if (!(await exists(gen))) { console.log(`skip ${c.id} (no generation output yet)`); continue; }
  const D = await dur(orig);
  const a = [MATCH, '--orig', orig, '--gen', gen, '--out', out, '--seam', c.seam,
    '--retime', '--align', 'trs', '--blend', String(BLEND), '--report', path.join(caseDir, c.reportName)];
  if (c.seam === 'mid') {
    const e = 0.5 * D;
    a.push('--edit', e.toFixed(2), '--in-lo', (0.15 * D).toFixed(2), '--in-hi', (0.45 * D).toFixed(2),
      '--out-lo', (0.55 * D).toFixed(2), '--out-hi', (0.85 * D).toFixed(2),
      '--gen-in-hi', e.toFixed(2), '--gen-out-lo', e.toFixed(2));
  } else if (c.seam === 'head') {
    a.push('--edit', '0', '--out-lo', (0.40 * D).toFixed(2), '--out-hi', (0.90 * D).toFixed(2));
  } else { // tail
    a.push('--edit', D.toFixed(2), '--in-lo', (0.10 * D).toFixed(2), '--in-hi', (0.60 * D).toFixed(2));
  }
  console.log(`\n=== splice ${c.id} (seam ${c.seam})`);
  await run('node', a);
}
