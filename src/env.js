import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './config.js';

// Load private API keys from a gitignored `.env` at the repo root into
// process.env. This is the one place provider credentials live (Runway now,
// others later) — one KEY=value per line. The file is the tool's own secrets,
// not per-project user data, so it sits beside package.json.
//
// Design choices:
//   - Zero dependencies: a small hand-parser, not dotenv. Keeps the install
//     surface unchanged.
//   - SHELL WINS: a variable already present in process.env is never
//     overwritten, so `export RUNWAY_API_KEY=...` (or CI-injected secrets)
//     always take precedence over the file. Predictable regardless of Node's
//     built-in --env-file behavior.
//   - Missing file is not an error: returns {} so code paths that don't need a
//     key (e.g. --dry-run) run untouched.
//
// Returns a map of the keys this call actually set (those not already in the
// environment), for logging/tests.
export function loadEnv(root = REPO_ROOT) {
  const file = path.join(root, '.env');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }

  const loaded = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue; // ignore malformed lines rather than crashing
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    // Strip one layer of matching surrounding quotes, if present.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
      loaded[key] = true;
    }
  }
  return loaded;
}
