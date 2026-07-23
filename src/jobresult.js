// ASSUMPTION LAYER — partially VERIFIED against real CLI output (sanity check 5).
// Confirmed: `generate get <id> --json` returns a single object with top-level
// `id`, `status`, and `result_url` (plus a `min_result_url` low-res preview).
// Plain `generate create --wait` prints only the bare result URL, whose
// `hf_<date>_<time>_<uuid>.<ext>` filename embeds the job id — hence the UUID
// fallback below. Async `generate create --json` (no --wait) prints a JSON
// ARRAY of job-id strings (verified in sanity check 6).
// Everything the pipeline believes about CLI stdout is decided *here*.

// Collect every top-level JSON object in stdout, in order. Handles a single
// (possibly pretty-printed) object AND a stream of one-object-per-line
// progress/result lines, which is common when a job runs with --wait.
function parseJsonObjects(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const whole = JSON.parse(trimmed);
    return whole && typeof whole === 'object' && !Array.isArray(whole) ? [whole] : [];
  } catch {}
  const objs = [];
  for (const line of trimmed.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{') || !s.endsWith('}')) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && !Array.isArray(o)) objs.push(o);
    } catch {}
  }
  return objs;
}

function coerceId(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function parseJobId(stdout) {
  // Async submission shape (verified in sanity check 6): `generate create
  // --json` without --wait prints an array of job-id strings.
  try {
    const whole = JSON.parse(stdout.trim());
    if (Array.isArray(whole) && typeof whole[0] === 'string' && whole[0]) {
      return whole[0];
    }
  } catch {}
  const objs = parseJsonObjects(stdout);
  // Prefer the LAST object carrying an id — the final result line wins over
  // earlier progress lines.
  for (let i = objs.length - 1; i >= 0; i--) {
    const id = coerceId(objs[i].id);
    if (id != null) return id;
  }
  // A bare quoted "id" anywhere in the text.
  const m = stdout.match(/"id"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  // Last resort (verified real behavior): plain `create --wait` prints just the
  // result URL, whose filename embeds the job UUID. Input-media UUIDs can
  // appear earlier in verbose output, so take the LAST one.
  const uuids = stdout.match(UUID_RE);
  return uuids ? uuids[uuids.length - 1] : null;
}

export function parseJobResult(stdout) {
  const objs = parseJsonObjects(stdout);
  // The authoritative result is the last object that looks like a job payload.
  const obj =
    [...objs].reverse().find(
      (o) => 'status' in o || 'result_url' in o || 'results' in o || 'url' in o || 'id' in o,
    ) || {};
  let outputUrl = null;
  if (typeof obj.result_url === 'string') {
    outputUrl = obj.result_url; // real CLI field (verified via `generate get --json`)
  } else if (Array.isArray(obj.results) && obj.results[0] && typeof obj.results[0].url === 'string') {
    outputUrl = obj.results[0].url;
  } else if (typeof obj.url === 'string') {
    outputUrl = obj.url;
  }
  return {
    id: coerceId(obj.id) ?? parseJobId(stdout),
    status: typeof obj.status === 'string' ? obj.status : 'unknown',
    outputUrl,
    raw: stdout,
  };
}
