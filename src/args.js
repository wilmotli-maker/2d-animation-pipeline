// Minimal --key value flag parsing shared by the bin/pipeline.js leaf commands.
// These throw on malformed input; bin/pipeline.js's top-level `main().catch`
// turns the throw into a clean one-line error + non-zero exit. Kept here (rather
// than inline in the executable) so they can be unit-tested without importing the
// CLI entrypoint, which runs main() on load.

// Parse `--flag value --flag value ...` into a plain object. Every token at an
// even index must be a --flag AND must be followed by a value. A trailing flag
// with no value (e.g. `--name` at the end) previously stored `undefined`, which
// then flowed into path builders and silently created dirs like `undefined/` — it
// is now a hard error. Bare boolean flags must be filtered out of `args` by the
// caller before calling this (see --force/--json/--saved-only in bin/pipeline.js).
export function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!key.startsWith('--')) throw new Error(`expected --flag, got "${key}"`);
    if (i + 1 >= args.length) throw new Error(`flag "${key}" is missing a value`);
    out[key.slice(2)] = args[i + 1];
  }
  return out;
}

// Collect every value for a repeatable flag (e.g. --image a --image b -> [a, b]).
// Steps in lockstep with parseFlags: with well-formed --flag/value pairs a
// repeatable flag always lands on an even index.
export function collectFlag(args, key) {
  const flag = `--${key}`;
  const vals = [];
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === flag && args[i + 1] != null) vals.push(args[i + 1]);
  }
  return vals;
}
