// ⚠️ ASSUMPTION LAYER — verify against real CLI output (sanity check 5).
// The Higgsfield CLI's exact stdout shape is unconfirmed. Everything the rest
// of the pipeline believes about that shape is decided *here* and nowhere else.
// If the real output differs, fix these two functions + their test only.

// Try strict JSON.parse first; if the CLI wraps JSON in log lines, fall back to
// extracting the first {...} block, then a bare "id":"..." regex.
function tryParseJson(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace) {
    try {
      return JSON.parse(brace[0]);
    } catch {}
  }
  return null;
}

export function parseJobId(stdout) {
  const obj = tryParseJson(stdout);
  if (obj && typeof obj.id === 'string') return obj.id;
  const m = stdout.match(/"id"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

export function parseJobResult(stdout) {
  const obj = tryParseJson(stdout) || {};
  let outputUrl = null;
  if (Array.isArray(obj.results) && obj.results[0] && typeof obj.results[0].url === 'string') {
    outputUrl = obj.results[0].url;
  } else if (typeof obj.url === 'string') {
    outputUrl = obj.url;
  }
  return {
    id: typeof obj.id === 'string' ? obj.id : parseJobId(stdout),
    status: typeof obj.status === 'string' ? obj.status : 'unknown',
    outputUrl,
    raw: stdout,
  };
}
