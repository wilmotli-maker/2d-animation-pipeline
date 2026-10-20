// src/edit-ui/colour-conform.js
// Colour-conform a generated clip toward a source reference before splicing, so the regenerated
// window matches the surrounding source colour/exposure and the seam is less visible. The transfer
// (Reinhard LAB mean/std) is done by python/colour_conform.py (cv2); this module builds the
// invocation and shares the flow-morph python toolchain (cv2 + numpy via uv / FLOW_MORPH_PYTHON).
import { flowMorphRunner, colourConformScriptPath, FLOW_MORPH_DEPS } from '../config.js';
import { streamingExec } from '../matte.js';

// Pure arg builder so the invocation is unit-testable without spawning anything.
export function colourConformArgs({ input, reference, out, strength = 1, minDrift = 1 }) {
  return ['--input', input, '--reference', reference, '--out', out,
    '--strength', String(strength), '--min-drift', String(minDrift)];
}

function parseReport(stdout) {
  const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
  try { return JSON.parse(line); } catch { throw new Error(`colour-conform produced no JSON report: ${stdout.slice(-300)}`); }
}

// Conform `input` toward `reference` into `out`. Returns { out, frames, driftBefore, driftAfter }.
// `exec`/`runner`/`script` are injectable (mirrors flowMorphJoin) so the missing-runtime and
// non-zero-exit paths are testable without a cv2 install.
export async function colourConform({
  input, reference, out, strength = 1, minDrift = 1,
  runner = flowMorphRunner(), script = colourConformScriptPath(), exec = streamingExec,
} = {}) {
  const args = [...runner.prefixArgs, script, ...colourConformArgs({ input, reference, out, strength, minDrift })];
  const { code, stdout, stderr } = await exec(runner.bin, args);
  if (code !== 0) {
    if (/ENOENT|not found|no such file/i.test(stderr) && /spawn|uv|python/i.test(stderr)) {
      throw new Error(
        `"${runner.bin}" not found — install uv (\`brew install uv\`), or set ` +
        `FLOW_MORPH_PYTHON to a python with ${FLOW_MORPH_DEPS.join(', ')} installed.`);
    }
    throw new Error(`colour-conform failed (exit ${code}): ${stderr.trim()}`);
  }
  const report = parseReport(stdout);
  return { out, frames: report.frames, skipped: !!report.skipped, driftBefore: report.driftBefore, driftAfter: report.driftAfter };
}
