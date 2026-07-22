// ⚠️ ASSUMPTION LAYER — verify against real CLI output (sanity check 5).
// The Higgsfield CLI's exact stdout shape is unconfirmed. Everything the rest
// of the pipeline believes about that shape is decided *here* and nowhere else.
// If the real output differs, fix these functions + their test only.

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

export function parseJobId(stdout) {
  const objs = parseJsonObjects(stdout);
  // Prefer the LAST object carrying an id — the final result line wins over
  // earlier progress lines.
  for (let i = objs.length - 1; i >= 0; i--) {
    const id = coerceId(objs[i].id);
    if (id != null) return id;
  }
  // Last resort: a bare quoted "id" anywhere in the text.
  const m = stdout.match(/"id"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

export function parseJobResult(stdout) {
  const objs = parseJsonObjects(stdout);
  // The authoritative result is the last object that looks like a job payload.
  const obj =
    [...objs].reverse().find(
      (o) => 'status' in o || 'results' in o || 'url' in o || 'id' in o,
    ) || {};
  let outputUrl = null;
  if (Array.isArray(obj.results) && obj.results[0] && typeof obj.results[0].url === 'string') {
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
