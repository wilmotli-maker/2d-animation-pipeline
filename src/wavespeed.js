import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WaveSpeed API key discovery for the seedance-stitch skill's VACE video joiner
// (templates/skills/seedance-stitch/scripts/vace_join.py, ~$0.20/join in WaveSpeed
// cash — not Higgsfield/MuAPI credits).
//
// Resolution order (shell/.env wins, matching env.js):
//   1. process.env.WAVESPEED_API_KEY  — set in the shell or loaded from .env by loadEnv()
//   2. ~/.wavespeed/key               — the single-line file Jordie's script has always used
//   3. null                            — no key configured
//
// The joiner script is self-contained Python and does the actual WaveSpeed API calls; this
// module is the pipeline-side source of truth for *where the key lives*, so the same two
// locations are documented and checkable from JS. Keep the two in lockstep: vace_join.py's
// key() mirrors this order.

export const WAVESPEED_KEY_FILE = path.join(os.homedir(), '.wavespeed', 'key');

function readKeyFile(file) {
  try {
    const k = readFileSync(file, 'utf8').trim();
    return k || null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Return the WaveSpeed key, or null if none is configured.
export function resolveWavespeedKey({ env = process.env, keyFile = WAVESPEED_KEY_FILE } = {}) {
  const fromEnv = (env.WAVESPEED_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return readKeyFile(keyFile);
}

// Diagnostics: where the key came from, without exposing its value.
export function wavespeedKeyStatus({ env = process.env, keyFile = WAVESPEED_KEY_FILE } = {}) {
  if ((env.WAVESPEED_API_KEY || '').trim()) return { configured: true, source: 'env', keyFile };
  if (readKeyFile(keyFile)) return { configured: true, source: 'file', keyFile };
  return { configured: false, source: null, keyFile };
}
