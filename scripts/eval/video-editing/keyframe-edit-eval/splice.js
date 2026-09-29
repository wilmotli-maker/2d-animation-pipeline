#!/usr/bin/env node
// Splice each generated edit back into its source clip using splice-match.js, with the seam
// mode set by the edit position. Runs only on cases whose generation output exists. No credits.
//
//   node splice.js [--shot <name>] [--only <caseId>] [--blend 0]
//
// first-frame edit -> seam head (keep original tail); last -> seam tail (keep original head);
// middle -> seam mid (keep both). Windows are derived from the shot duration.

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MATCH = path.join(here, '..', 'splice-match.js');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : (process.argv[i + 1] ?? true); };
const ONLY = arg('only'); const SHOT = arg('shot'); const BLEND = arg('blend') ?? '0';

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

for (const c of C.cases()) {
  if (ONLY && c.id !== ONLY) continue;
  if (SHOT && c.shot !== SHOT) continue;
  const orig = path.join(C.EVAL_ROOT, 'sources', `${c.shot}.mp4`);
  const gen = path.join(C.SCRATCH, 'shots', c.id, 'drafts', 'v001', 'output.mp4');
  const caseDir = C.caseDir(C.EVAL_ROOT, c.shot, c.variant, c.position);
  const out = path.join(caseDir, 'spliced.mp4');
  if (!(await exists(gen))) { console.log(`skip ${c.id} (no generation output yet)`); continue; }
  const D = await dur(orig);
  const a = [MATCH, '--orig', orig, '--gen', gen, '--out', out, '--seam', c.seam,
    '--retime', '--align', 'trs', '--blend', String(BLEND), '--report', path.join(caseDir, 'splice.json')];
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
