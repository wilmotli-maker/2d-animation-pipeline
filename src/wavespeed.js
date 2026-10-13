import { readFileSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
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

// --- VACE video joiner client -----------------------------------------------------------------
// Native Node client for WaveSpeed's hosted Wan VACE Video Joiner (~$0.20/join), so edit-ui can
// join seam clips the same way the other runners call their APIs: key from .env (resolveWavespeedKey),
// injectable fetch. Mirrors the 3 calls vace_join.py makes — upload each clip, submit the join, poll.
const WAVESPEED_API = 'https://api.wavespeed.ai/api/v3';

export class WavespeedError extends Error {
  constructor(message) { super(message); this.name = 'WavespeedError'; }
}

// Parse a WaveSpeed JSON response and surface a non-2xx `code` (e.g. 400 insufficient credits).
function checkJson(j, what) {
  if (j && j.code != null && j.code !== 200) throw new WavespeedError(`${what}: ${j.message || JSON.stringify(j).slice(0, 300)}`);
  return j;
}

async function uploadBinary(file, { apiKey, fetchImpl, readFile }) {
  const buf = await readFile(file);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(file));
  const j = checkJson(await (await fetchImpl(`${WAVESPEED_API}/media/upload/binary`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
  })).json(), `upload ${path.basename(file)}`);
  const url = j && j.data && j.data.download_url;
  if (!url) throw new WavespeedError(`upload gave no URL: ${JSON.stringify(j).slice(0, 300)}`);
  return url;
}

// Join 2-4 local clips into one. Returns { id, outputUrl, raw }. No --pushin (same-framing seams).
export async function vaceJoin(clips, {
  apiKey = resolveWavespeedKey(), fetchImpl = fetch, readFile = fsReadFile,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 3000, timeoutMs = 1800000, now = Date.now,
} = {}) {
  if (!apiKey) throw new WavespeedError('no WaveSpeed key: set WAVESPEED_API_KEY (.env or shell) or save it in ~/.wavespeed/key');
  if (!Array.isArray(clips) || clips.length < 2 || clips.length > 4) throw new WavespeedError('vaceJoin needs 2 to 4 clips');
  const urls = [];
  for (const c of clips) urls.push(await uploadBinary(c, { apiKey, fetchImpl, readFile }));
  const sub = checkJson(await (await fetchImpl(`${WAVESPEED_API}/wavespeed-ai/vace-video-joiner`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ videos: urls }),
  })).json(), 'join submit');
  const id = sub && sub.data && sub.data.id;
  if (!id) throw new WavespeedError(`join submit returned no job id: ${JSON.stringify(sub).slice(0, 300)}`);
  const t0 = now();
  for (;;) {
    await sleep(pollMs);
    const res = (checkJson(await (await fetchImpl(`${WAVESPEED_API}/predictions/${id}/result`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })).json(), 'join result').data) || {};
    if (res.status === 'completed') return { id, outputUrl: res.outputs && res.outputs[0], raw: res };
    if (['failed', 'cancelled', 'timeout', 'deleted'].includes(res.status)) throw new WavespeedError(`join ${res.status}: ${res.error || ''}`);
    if (now() - t0 > timeoutMs) throw new WavespeedError('join timed out after 30 min');
  }
}
