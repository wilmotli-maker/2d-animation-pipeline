// src/edit-ui/trim-generator.js
// The edit-ui "seedance-draft" generator (name kept for the registry; now full-quality — HF
// removed the draft endpoint): per marked region, trim a centered >=4s window (padding at source
// edges), run a full-quality Seedance omni edit (start/end frames + speech-ref) that preserves
// lip-sync, and fold splice-back metadata into the run manifest. Phase 2 (splice-back) is separate.
// All side effects are injected so run() is testable without ffmpeg/network/GPU.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readRunView } from './runview.js';
import { planWindows } from './windows.js';
import { trimPadVideo, trimPadSpeech, extractFrame } from './trim-media.js';
import { buildTrimPrompt } from './trim-prompt.js';
import { nearestAspect } from './inputs.js';
import { updateRun } from './workspace.js';
import { hfBackend } from './backends.js';

function defaultFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}: ${err.slice(-300)}`))));
  });
}
async function defaultTranscribe(wav) {
  const { getTranscriber } = await import('../transcribe.js');
  const r = await getTranscriber('whisper').transcribe(wav);
  return (r && r.text) || '';
}
async function defaultRunner() { const { createRunner } = await import('../cli.js'); return createRunner(); }
async function defaultRunBatch(runner, items) { const { runBatch } = await import('../batch.js'); return runBatch(runner, items); }
async function defaultDownload(url, abs) { const { downloadTo } = await import('../download.js'); return downloadTo(url, abs); }

const pad2 = (n) => String(n).padStart(2, '0');

export function createTrimGenerator(deps = {}) {
  const backend = deps.backend || hfBackend();
  return {
    name: backend.name,
    async run({ root, runDir, run, request }) {
      // Resolve injected deps at call time (like `runner`) so tests can swap them per run.
      const ffmpeg = deps.ffmpeg || defaultFfmpeg;
      const transcribe = deps.transcribe || defaultTranscribe;
      const runBatch = deps.runBatch || defaultRunBatch;
      const download = deps.download || defaultDownload;
      const now = deps.now || (() => new Date().toISOString());
      // HF backend needs the project runner; MuAPI doesn't (it shells muapi-seedance.js).
      const runnerRef = deps.runner || (backend.name === 'hf' ? await defaultRunner() : null);
      const view = readRunView(root, run, { maxImages: 8 });
      const fps = (run.source && run.source.fps) || request.fps || 24;
      const duration = (run.source && run.source.duration)
        || (run.source && run.source.frames ? run.source.frames / fps : 0);
      const abs = (rel) => path.resolve(root, rel);
      const relOut = (p) => path.relative(root, p).split(path.sep).join('/');

      // Regions: edited keyframes + marks (annotations excluded this phase).
      const edited = (run.inputs || []).filter((i) => i.role === 'keyframe' && i.kind === 'edited')
        .map((k) => ({ time: k.time, path: abs(k.path) }));
      const regions = [
        ...edited.map((k) => ({ kind: 'point', start: k.time, end: k.time })),
        ...(run.marks || []).map((m) => (m.kind === 'range'
          ? { kind: 'range', start: m.start / fps, end: m.end / fps, anchor: m.anchor != null ? m.anchor / fps : undefined }
          : { kind: 'point', start: m.start / fps, end: m.start / fps })),
      ];

      let { windows } = planWindows({ regions, duration, fps });
      if (!windows.length) {
        windows = [{ window: [0, duration], sourceSpan: [0, duration], pad: { start: 0, end: 0 }, clipDuration: duration, editCenters: [], regions: [] }];
      }

      const aspect = nearestAspect(run.source && run.source.width, run.source && run.source.height);
      const styleLock = (request && request.styleLock) || '';
      // Raw per-mark prompt text for a window — NOT run.prompt.text, which is composePrompt's
      // blob (frame headers + a Dialogue block) and would pollute the gesture clause. Prefer the
      // prompts whose mark falls in the window; fall back to whole-video prompts (markId null).
      const markTime = (id) => {
        const m = (run.marks || []).find((x) => x.id === id);
        if (!m) return null;
        return (m.kind === 'range' ? (m.start + m.end) / 2 : m.start) / fps;
      };
      const windowPrompt = (w) => {
        const texts = (run.prompts || []).map((p) => ({ markId: p.markId, text: (p.text || '').trim() })).filter((p) => p.text);
        const inWin = texts.filter((p) => p.markId && (() => { const t = markTime(p.markId); return t != null && t >= w.window[0] && t <= w.window[1]; })());
        const global = texts.filter((p) => !p.markId);
        return (inWin.length ? inWin : global).map((p) => p.text).join(' ');
      };
      const results = [];
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        const wName = `w${pad2(i + 1)}`;
        const wDir = path.join(runDir, 'windows', wName);
        const entry = {
          name: wName, window: w.window, sourceSpan: w.sourceSpan, pad: w.pad,
          clipDuration: w.clipDuration, editCenters: w.editCenters, draft: false, status: 'pending', output: null,
        };
        try {
          await mkdir(wDir, { recursive: true });
          const trim = path.join(wDir, 'trim.mp4');
          const srTrim = path.join(wDir, 'speechref-trim.mp4');
          const first = path.join(wDir, 'first.png');
          const last = path.join(wDir, 'last.png');
          await trimPadVideo(ffmpeg, { input: view.source, output: trim, sourceSpan: w.sourceSpan, pad: w.pad });
          await extractFrame(ffmpeg, { input: trim, time: 0, output: first });
          await extractFrame(ffmpeg, { input: trim, time: Math.max(0, w.clipDuration - 0.05), output: last });

          let dialogue = '';
          if (view.speechref) {
            await trimPadSpeech(ffmpeg, { input: view.speechref, output: srTrim, sourceSpan: w.sourceSpan, pad: w.pad });
            const wav = path.join(wDir, 'speech-trim.wav');
            try {
              await ffmpeg(['-v', 'error', '-y', '-i', srTrim, '-vn', '-ac', '1', '-ar', '16000', wav]);
              dialogue = await transcribe(wav);
            } catch (e) { entry.note = `transcription unavailable: ${e.message}`; }
          }

          // Pose refs: edited keyframes inside this window, by time; cap first+poses+last at 8.
          const poses = edited.filter((k) => k.time >= w.sourceSpan[0] && k.time <= w.sourceSpan[1])
            .sort((a, b) => a.time - b.time)
            .map((k) => ({ offset: k.time - w.window[0], path: k.path }))
            .slice(0, 6);
          entry.keyframeCount = poses.length;

          const gestureOffset = w.editCenters.length ? w.editCenters[0] - w.window[0] : undefined;
          const prompt = buildTrimPrompt({ dialogue, clipDuration: w.clipDuration, poses, gesture: windowPrompt(w), gestureOffset, styleLock });
          const promptFile = path.join(wDir, 'prompt.md');
          await writeFile(promptFile, prompt + '\n');

          // Submit via the selected backend (hf or muapi). Seedance needs an INTEGER duration (>= 4);
          // clipDuration is frame math so round it (sub-frame vs the frame-accurate trim/de-pad).
          const r = await backend.submit({
            wName, wDir, promptFile, prompt, first, last,
            poses: poses.map((p) => p.path),
            speechRefPath: view.speechref ? srTrim : null,
            resolution: '480p', aspectRatio: aspect,
            duration: Math.max(4, Math.round(w.clipDuration)), generateAudio: true,
          }, { runner: runnerRef, runBatch, download });
          entry.output = relOut(r.output); entry.status = 'done'; entry.finishedAt = now();
        } catch (err) {
          entry.status = 'error'; entry.error = err.message;
        }
        entry.prompt = relOut(path.join(wDir, 'prompt.md'));
        results.push(entry);
      }

      await updateRun(runDir, { windows: results });
      const firstOk = results.find((w) => w.output);
      // Per-window failures are isolated, but a run where no window produced any output is a
      // failed run — throw so the server records it as 'error' instead of a done run with no clip.
      if (!firstOk) {
        const why = results.map((w) => w.error).filter(Boolean).join('; ') || 'no output produced';
        throw new Error(`all ${results.length} edit window(s) failed: ${why}`);
      }
      return { output: firstOk.output, windows: results };
    },
  };
}
