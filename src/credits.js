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
