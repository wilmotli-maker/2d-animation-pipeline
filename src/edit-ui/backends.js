// src/edit-ui/backends.js
// Submission backends for the edit-ui trim generator. The generator does all the window/trim/
// prompt work; a backend only takes a prepped window (frames + speech-ref + prompt) and returns the
// generated clip. Two backends:
//   hf    — Higgsfield Seedance via the project runner (runBatch). Full quality, start/end frames +
//           speech-ref. Fast/native but HF moderation false-positives `nsfw` on lip-sync (no draft
//           bypass since the api.higgsfield.ai migration), so it is unreliable for talking shots.
//   muapi — MuAPI (muapi.ai) Seedance 2.5 omni-reference, which has NO moderation on this recipe.
//           Shells the proven scripts/eval/.../muapi-seedance.js (uploads local refs to fal). The
//           default, because it actually completes. Needs MUAPI_KEY + FAL_KEY (read from .env).
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { copyFile, access } from 'node:fs/promises';
import { REPO_ROOT } from '../config.js';

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
function runProc(spawnImpl, bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

// HF (Higgsfield) backend. Builds the omni_reference opts and submits via runBatch; `runner`,
// `runBatch`, `download` are passed in by the generator (injectable for tests).
export function hfBackend() {
  return {
    name: 'hf',
    async submit(w, { runner, runBatch, download }) {
      const opts = {
        prompt: w.prompt, startImage: w.first, endImage: w.last, imageReferences: w.poses,
        resolution: w.resolution, aspectRatio: w.aspectRatio, duration: w.duration,
        generateAudio: w.generateAudio, mode: 'omni_reference',
      };
      if (w.speechRefPath) { const up = await runner.upload(w.speechRefPath); opts.videoReferences = [up.id]; }
      const [r] = await runBatch(runner, [{ ref: w.wName, model: 'seedance_2_5', opts }]);
      if (r && r.status === 'completed' && r.outputUrl) {
        const out = path.join(w.wDir, 'out.mp4');
        await download(r.outputUrl, out);
        return { output: out };
      }
      throw new Error((r && r.error) || `generation ${r && r.status}`);
    },
  };
}

const scriptDir = (root = REPO_ROOT) => path.join(root, 'scripts', 'eval', 'video-editing', 'keyframe-edit-eval');
export function muapiScriptPath(root = REPO_ROOT) { return path.join(scriptDir(root), 'muapi-seedance.js'); }
export function falScriptPath(root = REPO_ROOT) { return path.join(scriptDir(root), 'fal-seedance.js'); }

// Shared backend for the external Seedance CLIs (muapi-seedance.js / fal-seedance.js). Both take the
// same flags (--prompt-file / repeated --image / --video / --resolution / --aspect-ratio / --duration
// / --generate-audio / --out) and write <out>/output.mp4. Image order: start, end, then pose refs.
// `name` is the subdir + label; `spawn`/`script` are injectable for tests.
function cliBackend({ name, script, spawn = nodeSpawn }) {
  return {
    name,
    buildArgs(w) {
      const outDir = path.join(w.wDir, name);
      const args = ['--prompt-file', w.promptFile, '--image', w.first, '--image', w.last];
      for (const p of w.poses || []) args.push('--image', p);
      if (w.speechRefPath) args.push('--video', w.speechRefPath);
      args.push('--resolution', w.resolution, '--aspect-ratio', w.aspectRatio,
        '--duration', String(w.duration), '--generate-audio', String(w.generateAudio !== false), '--out', outDir);
      return args;
    },
    async submit(w) {
      const r = await runProc(spawn, 'node', [script, ...this.buildArgs(w)], { cwd: REPO_ROOT });
      const produced = path.join(w.wDir, name, 'output.mp4');
      if (r.code === 0 && (await exists(produced))) {
        const out = path.join(w.wDir, 'out.mp4');
        await copyFile(produced, out);
        return { output: out };
      }
      throw new Error(`${name} generation failed (exit ${r.code}): ${(r.err || r.out).slice(-240)}`);
    },
  };
}

// MuAPI Seedance (no moderation). Image/audio refs billed on total reference+output duration.
export function muapiBackend({ spawn = nodeSpawn, script = muapiScriptPath() } = {}) {
  return cliBackend({ name: 'muapi', script, spawn });
}
// Direct fal.ai Seedance 2.5 (no moderation; image/audio refs free, video refs billed). Usually
// cheaper than MuAPI at 480p. Needs FAL_KEY (.env).
export function falBackend({ spawn = nodeSpawn, script = falScriptPath() } = {}) {
  return cliBackend({ name: 'fal', script, spawn });
}
