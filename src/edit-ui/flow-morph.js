// src/edit-ui/flow-morph.js
// Dense optical-flow seam morph for the edit-ui splice, used in place of ffmpeg's minterpolate join.
// Given two already-rendered segment clips (left, right) that meet at a seam, it inserts N transition
// frames that warp one side's boundary frame into the other's along the computed flow — a pure
// geometry ramp (no cross-dissolve), which avoids minterpolate's block halos and the dissolve's
// ghosting. The heavy lifting is python/flow_morph.py (cv2); this module just builds the invocation.
//
// mode picks which side carries the warp so the GEN side stays pristine:
//   one-sided-left  — warp the left clip's tail into the right (use when left is the source head)
//   one-sided-right — warp the right clip's head back from the left (use when right is the source tail)
//   balanced        — split the warp across both sides (generic fallback)
import { flowMorphRunner, flowMorphScriptPath, FLOW_MORPH_DEPS } from '../config.js';
import { streamingExec } from '../matte.js';

export const FLOW_MORPH_MODES = ['one-sided-left', 'one-sided-right', 'balanced'];

// Pure arg builder so the invocation is unit-testable without spawning anything.
export function flowMorphArgs({ left, right, out, frames, fps, mode = 'one-sided-left', flow = 'farneback' }) {
  if (!FLOW_MORPH_MODES.includes(mode)) throw new Error(`unknown flow-morph mode: ${mode}`);
  return [
    '--left', left, '--right', right, '--out', out,
    '--frames', String(frames), '--fps', String(fps),
    '--mode', mode, '--flow', flow,
  ];
}

function parseReport(stdout) {
  const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
  try { return JSON.parse(line); } catch { throw new Error(`flow-morph produced no JSON report: ${stdout.slice(-300)}`); }
}

// Join `left` + `right` into `out` with an N-frame flow morph at the seam. Returns { out, frames }.
// `exec`/`runner`/`script` are injectable so the missing-runtime and non-zero-exit paths are testable
// without a cv2 install (mirrors matteEngine).
export async function flowMorphJoin(left, right, {
  out, frames, fps, mode = 'one-sided-left', flow = 'farneback',
  runner = flowMorphRunner(), script = flowMorphScriptPath(), exec = streamingExec,
} = {}) {
  const args = [...runner.prefixArgs, script, ...flowMorphArgs({ left, right, out, frames, fps, mode, flow })];
  const { code, stdout, stderr } = await exec(runner.bin, args);
  if (code !== 0) {
    if (/ENOENT|not found|no such file/i.test(stderr) && /spawn|uv|python/i.test(stderr)) {
      throw new Error(
        `"${runner.bin}" not found — install uv (\`brew install uv\`), or set ` +
        `FLOW_MORPH_PYTHON to a python with ${FLOW_MORPH_DEPS.join(', ')} installed ` +
        '(or set EDIT_UI_MORPH=minterpolate to use the ffmpeg joiner instead)');
    }
    throw new Error(`flow-morph failed (exit ${code}): ${stderr.trim()}`);
  }
  const report = parseReport(stdout);
  return { out, frames: report.frames };
}
