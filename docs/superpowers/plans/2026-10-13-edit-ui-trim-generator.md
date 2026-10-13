# Edit-UI Trim Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the edit-ui stub generator with a centered-trim targeted-edit backend that, per marked region, trims a ≥4s window (padding at source edges), runs an HF-draft Seedance edit preserving lip-sync, and records splice-back metadata.

**Architecture:** A pure windowing module (`windows.js`) plans merged, edge-padded windows from edit regions. A generator module (`trim-generator.js`) turns each window into trimmed/padded media + a prompt, submits it through the existing `createRunner()`+`runBatch`+`downloadTo` path with `--draft true`, and folds a `windows[]` array into the run manifest. Registered as the new default backend `seedance-draft`.

**Tech Stack:** Node ESM, `node --test`, ffmpeg/ffprobe (shelled), existing `src/cli.js` runner, `src/batch.js`, `src/download.js`, `src/transcribe.js`, `src/edit-ui/{runview,inputs}.js`.

**Spec:** [docs/superpowers/specs/2026-10-13-edit-ui-trim-generator-design.md](../specs/2026-10-13-edit-ui-trim-generator-design.md)

## Global Constraints

- Node ESM only (`import`), matching the repo; no new runtime dependencies (`sharp`, ffmpeg already present).
- All side-effecting deps in `trim-generator.js` are injectable (runner, runBatch, download, transcribe, ffmpeg, now) with real defaults — tests never hit network/GPU/ffmpeg.
- Window minimum duration = **4s** (`minWindow = 4`); times are **seconds** (floats); `ffmpeg` time args formatted to 3 decimals.
- Generation defaults, copied verbatim into `opts`: `resolution: '480p'`, `generateAudio: true`, `mode: 'omni_reference'`, `extraArgs: ['--draft', 'true']`; `aspectRatio` from `nearestAspect(width, height)`; `duration` = the window's `clipDuration`; `model: 'seedance_2_5'`.
- Manifest writes go through `updateRun(runDir, patch)` (merges, atomic).
- Workspace-relative paths in the manifest use `/` separators (match existing `rel()` in workspace.js/inputs.js).
- `DEFAULT_GENERATOR = 'seedance-draft'`; `stub` stays registered and selectable.

## Review Focus

- **Region exactly at `t=0` or `t=duration`:** window becomes fully one-sided; `pad.start` or `pad.end` == `minWindow/2` and `sourceSpan` is a zero-or-short span — must not produce a negative/zero `clipDuration` or an empty trim. (Task 1 tests.)
- **Two regions whose 4s windows merely touch** (`next.start === cur.end`): must merge into one window, not two adjacent ones. (Task 1 tests.)
- **`duration` shorter than `minWindow`** (e.g. a 2s clip): single window = whole clip with pads filling the remainder; no window longer than needed. (Task 1 tests.)
- **A window with no edited keyframe** (mark-only / text-pose): generator submits 2 stills (first/last), no middle pin, no crash from an empty pose list. (Task 4 tests.)
- **One window's generation fails** (runner throws / returns non-completed): that window records `status:'error'`; other windows still complete and the run still returns an output. (Task 4 tests.)

---

### Task 1: Pure windowing module (`windows.js`)

**Files:**
- Create: `src/edit-ui/windows.js`
- Test: `test/edit-ui-windows.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `planWindows({ regions, duration, fps, minWindow = 4 }) -> { windows }` where
  `regions` is `[{ kind: 'point'|'range', start, end }]` (seconds) and each window is
  `{ window: [W0, W1], sourceSpan: [s, e], pad: { start, end }, clipDuration, editCenters: number[], regions: [...] }`, ordered by `W0`.

- [ ] **Step 1: Write failing tests**

```javascript
// test/edit-ui-windows.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWindows } from '../src/edit-ui/windows.js';

const only = (r) => planWindows({ regions: r, duration: 10, fps: 24 }).windows;

test('a point region centers a 4s window on it', () => {
  const [w] = only([{ kind: 'point', start: 5, end: 5 }]);
  assert.deepEqual(w.window, [3, 7]);
  assert.deepEqual(w.sourceSpan, [3, 7]);
  assert.deepEqual(w.pad, { start: 0, end: 0 });
  assert.equal(w.clipDuration, 4);
  assert.deepEqual(w.editCenters, [5]);
});

test('a range wider than the minimum keeps its own width', () => {
  const [w] = only([{ kind: 'range', start: 2, end: 8 }]); // span 6 > 4
  assert.deepEqual(w.window, [2, 8]);
  assert.equal(w.clipDuration, 6);
});

test('a region near the start extends past 0 and pads the head, staying centered', () => {
  const [w] = only([{ kind: 'point', start: 1, end: 1 }]); // ideal [-1, 3]
  assert.deepEqual(w.window, [-1, 3]);
  assert.deepEqual(w.sourceSpan, [0, 3]);
  assert.deepEqual(w.pad, { start: 1, end: 0 });
  assert.equal(w.clipDuration, 4);
});

test('a region near the end pads the tail', () => {
  const [w] = only([{ kind: 'point', start: 9, end: 9 }]); // ideal [7, 11], duration 10
  assert.deepEqual(w.window, [7, 11]);
  assert.deepEqual(w.sourceSpan, [7, 10]);
  assert.deepEqual(w.pad, { start: 0, end: 1 });
});

test('overlapping windows merge and union their edit centers', () => {
  const ws = only([{ kind: 'point', start: 5, end: 5 }, { kind: 'point', start: 6, end: 6 }]);
  assert.equal(ws.length, 1);
  assert.deepEqual(ws[0].window, [3, 8]);
  assert.deepEqual(ws[0].editCenters, [5, 6]);
});

test('windows that merely touch still merge', () => {
  // [3,7] and [7,11] touch at 7
  const ws = only([{ kind: 'point', start: 5, end: 5 }, { kind: 'point', start: 9, end: 9 }]);
  assert.equal(ws.length, 1);
  assert.deepEqual(ws[0].window, [3, 11]);
});

test('non-overlapping windows stay separate, ordered by start', () => {
  const ws = only([{ kind: 'point', start: 8, end: 8 }, { kind: 'point', start: 2, end: 2 }]);
  assert.equal(ws.length, 2);
  assert.deepEqual(ws.map((w) => w.window), [[0, 4], [6, 10]]);
});

test('duration shorter than the minimum yields one whole-clip window with pads', () => {
  const ws = planWindows({ regions: [{ kind: 'point', start: 1, end: 1 }], duration: 2, fps: 24 }).windows;
  assert.equal(ws.length, 1);
  assert.deepEqual(ws[0].window, [-1, 3]);
  assert.deepEqual(ws[0].sourceSpan, [0, 2]);
  assert.deepEqual(ws[0].pad, { start: 1, end: 1 });
});

test('no regions yields no windows', () => {
  assert.deepEqual(planWindows({ regions: [], duration: 10, fps: 24 }).windows, []);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/edit-ui-windows.test.js`
Expected: FAIL (`planWindows` is not exported / module missing).

- [ ] **Step 3: Implement `windows.js`**

```javascript
// src/edit-ui/windows.js
// Plan centered, edge-padded, merged edit windows from marked regions. Pure: no I/O.
// A region is { kind: 'point'|'range', start, end } in seconds (point: start===end).
// Each window is centered on its region(s); near a clip edge the window extends past
// 0 / past duration and the overflow becomes pad (filled with a freeze frame + silence
// by the generator), so the edit point stays at the window midpoint. Overlapping or
// touching windows merge; the splice step later uses sourceSpan + pad to reinsert.
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function idealWindow(region, minWindow) {
  if (region.kind === 'range') {
    const mid = (region.start + region.end) / 2;
    const w = Math.max(minWindow, region.end - region.start);
    return [mid - w / 2, mid + w / 2, mid];
  }
  const t = region.start;
  return [t - minWindow / 2, t + minWindow / 2, t];
}

export function planWindows({ regions = [], duration, fps, minWindow = 4 } = {}) {
  const items = regions
    .map((r) => { const [w0, w1, c] = idealWindow(r, minWindow); return { w0, w1, center: c, region: r }; })
    .sort((a, b) => a.w0 - b.w0);

  const merged = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (last && it.w0 <= last.w1) {
      last.w1 = Math.max(last.w1, it.w1);
      last.centers.push(it.center);
      last.regions.push(it.region);
    } else {
      merged.push({ w0: it.w0, w1: it.w1, centers: [it.center], regions: [it.region] });
    }
  }

  const windows = merged.map((m) => {
    const s = clamp(m.w0, 0, duration);
    const e = clamp(m.w1, 0, duration);
    return {
      window: [m.w0, m.w1],
      sourceSpan: [s, e],
      pad: { start: Math.max(0, -m.w0), end: Math.max(0, m.w1 - duration) },
      clipDuration: m.w1 - m.w0,
      editCenters: m.centers,
      regions: m.regions,
    };
  });
  return { windows };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test test/edit-ui-windows.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/edit-ui/windows.js test/edit-ui-windows.test.js
git commit -m "feat(edit-ui): pure windowing for trim generator"
```

---

### Task 2: Trim + pad media helpers (`trim-media.js`)

**Files:**
- Create: `src/edit-ui/trim-media.js`
- Test: `test/edit-ui-trim-media.test.js`

**Interfaces:**
- Consumes: an injected `ffmpeg(args) -> Promise<void>` runner (shells `ffmpeg -v error -y ...`).
- Produces:
  - `trimArgs({ input, output, start, span, padStart, padEnd, video, audio })` -> `string[]` (pure arg builder, so tests assert the command without running ffmpeg).
  - `async trimPadVideo(ffmpeg, { input, output, sourceSpan, pad })`
  - `async trimPadSpeech(ffmpeg, { input, output, sourceSpan, pad })`
  - `async extractFrame(ffmpeg, { input, time, output })`

- [ ] **Step 1: Write failing tests (pure arg builder + call recording)**

```javascript
// test/edit-ui-trim-media.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimArgs, trimPadVideo, trimPadSpeech, extractFrame } from '../src/edit-ui/trim-media.js';

test('trimArgs seeks, limits span, and pads a silent-video clip at both ends', () => {
  const args = trimArgs({ input: 'in.mp4', output: 'out.mp4', start: 7, span: 3, padStart: 0, padEnd: 1, video: true, audio: false });
  const s = args.join(' ');
  assert.match(s, /-ss 7\.000/);
  assert.match(s, /-t 3\.000/);
  assert.match(s, /-an/);
  assert.match(s, /tpad=.*stop_duration=1/); // tail pad 1s
  assert.match(s, /-c:v libx264/);
  assert.match(s, /out\.mp4$/);
});

test('trimArgs head-pads video and pads audio with silence for a speech clip', () => {
  const args = trimArgs({ input: 'sr.mp4', output: 'srt.mp4', start: 0, span: 3, padStart: 1, padEnd: 0, video: true, audio: true });
  const s = args.join(' ');
  assert.match(s, /tpad=start_duration=1/);     // head video pad
  assert.match(s, /adelay=1000/);               // 1s audio delay (head silence), ms
  assert.doesNotMatch(s, /-an/);
  assert.match(s, /-c:a aac/);
});

test('trimPadVideo invokes ffmpeg once with the built args', async () => {
  const calls = [];
  await trimPadVideo(async (a) => calls.push(a), { input: 'in.mp4', output: 'o.mp4', sourceSpan: [3, 7], pad: { start: 0, end: 0 } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].join(' '), /-ss 3\.000.*-t 4\.000/);
});

test('trimPadSpeech builds an audio-bearing padded clip', async () => {
  const calls = [];
  await trimPadSpeech(async (a) => calls.push(a), { input: 'sr.mp4', output: 'o.mp4', sourceSpan: [0, 3], pad: { start: 1, end: 0 } });
  assert.match(calls[0].join(' '), /adelay=1000/);
});

test('extractFrame grabs a single frame at a time', async () => {
  const calls = [];
  await extractFrame(async (a) => calls.push(a), { input: 'o.mp4', time: 0, output: 'first.png' });
  assert.match(calls[0].join(' '), /-ss 0\.000 -i o\.mp4 -frames:v 1 first\.png/);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/edit-ui-trim-media.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `trim-media.js`**

```javascript
// src/edit-ui/trim-media.js
// Build + run the ffmpeg commands that trim a window out of the source / speech-ref and
// pad the edges (freeze-frame video, silent audio) so the clip reaches its full centered
// duration. Arg building is a pure function so it can be asserted without running ffmpeg.
const t3 = (n) => Number(n).toFixed(3);

// span = sourceSpan length (real footage); padStart/padEnd = synthetic seconds to add.
export function trimArgs({ input, output, start, span, padStart = 0, padEnd = 0, video = true, audio = false }) {
  const vf = [];
  if (padStart > 0) vf.push(`tpad=start_duration=${t3(padStart)}:start_mode=clone`);
  if (padEnd > 0) vf.push(`tpad=stop_duration=${t3(padEnd)}:stop_mode=clone`);
  const args = ['-ss', t3(start), '-i', input, '-t', t3(span)];
  if (!audio) args.push('-an');
  if (vf.length) args.push('-vf', vf.join(','));
  if (audio) {
    const af = [];
    if (padStart > 0) af.push(`adelay=${Math.round(padStart * 1000)}:all=1`);
    if (padEnd > 0) af.push(`apad=pad_dur=${t3(padEnd)}`);
    if (af.length) args.push('-af', af.join(','));
    args.push('-c:a', 'aac');
  }
  args.push('-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', output);
  return args;
}

async function ffRun(ffmpeg, args) { await ffmpeg(['-v', 'error', '-y', ...args]); }

export async function trimPadVideo(ffmpeg, { input, output, sourceSpan, pad }) {
  const [s, e] = sourceSpan;
  await ffRun(ffmpeg, trimArgs({ input, output, start: s, span: e - s, padStart: pad.start, padEnd: pad.end, video: true, audio: false }));
  return output;
}

export async function trimPadSpeech(ffmpeg, { input, output, sourceSpan, pad }) {
  const [s, e] = sourceSpan;
  await ffRun(ffmpeg, trimArgs({ input, output, start: s, span: e - s, padStart: pad.start, padEnd: pad.end, video: true, audio: true }));
  return output;
}

export async function extractFrame(ffmpeg, { input, time, output }) {
  await ffRun(ffmpeg, ['-ss', t3(time), '-i', input, '-frames:v', '1', output]);
  return output;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test test/edit-ui-trim-media.test.js`
Expected: PASS (5 tests). Note: tests pass `ffmpeg` as a recording fake; the real default (shelling ffmpeg) is wired in Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/edit-ui/trim-media.js test/edit-ui-trim-media.test.js
git commit -m "feat(edit-ui): trim+pad ffmpeg helpers for windows"
```

---

### Task 3: Prompt builder (`trim-prompt.js`)

**Files:**
- Create: `src/edit-ui/trim-prompt.js`
- Test: `test/edit-ui-trim-prompt.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `buildTrimPrompt({ dialogue, clipDuration, poses, userPrompt }) -> string`, where
  `poses` is `[{ offset }]` (seconds within the clip, ascending) for edited keyframes; empty = text-pose.

- [ ] **Step 1: Write failing tests**

```javascript
// test/edit-ui-trim-prompt.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrimPrompt } from '../src/edit-ui/trim-prompt.js';

test('3kf prompt pins first, each pose at its offset, and last, scoping mouth to lip-sync', () => {
  const p = buildTrimPrompt({ dialogue: 'Hello there', clipDuration: 4, poses: [{ offset: 2 }], userPrompt: 'raise a fist' });
  assert.match(p, /@Video1/);
  assert.match(p, /"Hello there"/);
  assert.match(p, /@Image1 at 0\.0s/);
  assert.match(p, /@Image2 at 2\.0s/);
  assert.match(p, /@Image3 at 4\.0s/);
  assert.match(p, /BODY and EYES only/i);       // mouth keeps lip-syncing
  assert.match(p, /raise a fist/);              // user prompt folded in
});

test('text-pose prompt uses two stills and no middle pin', () => {
  const p = buildTrimPrompt({ dialogue: 'Hi', clipDuration: 4, poses: [], userPrompt: 'look surprised' });
  assert.match(p, /@Image1 at 0\.0s/);
  assert.match(p, /@Image2 at 4\.0s/);
  assert.doesNotMatch(p, /@Image3/);
  assert.match(p, /look surprised/);
});

test('empty dialogue still produces a valid prompt without an empty quote clause', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], userPrompt: '' });
  assert.doesNotMatch(p, /saying, ""/);
  assert.match(p, /@Image1 at 0\.0s/);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/edit-ui-trim-prompt.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `trim-prompt.js`**

```javascript
// src/edit-ui/trim-prompt.js
// Compose the targeted-edit prompt for one window: @-tag roles, full-clip lip-sync to
// @Video1, each still pinned to a timestamp (edited keyframes scope BODY+EYES so the mouth
// keeps lip-syncing), the trimmed dialogue quoted, and the UI's authored prompt folded in.
// Generalized from scaffold-muapi-trim.js (no hardcoded character design strings).
const s1 = (n) => Number(n).toFixed(1);

export function buildTrimPrompt({ dialogue = '', clipDuration, poses = [], userPrompt = '' } = {}) {
  const end = s1(clipDuration);
  const n = poses.length + 2;                       // first + poses + last
  const lastTag = `@Image${n}`;
  const imageTags = Array.from({ length: n }, (_, i) => `@Image${i + 1}`).join(', ');

  const lines = [];
  lines.push('Flat cartoon children’s-book illustration, a single continuous fully-animated talking performance. The character keeps the same framing and appearance as the reference images throughout.');

  const speech = [`@Video1 is the speech/lip-sync source.`];
  if (dialogue.trim()) speech.push(`The character speaks directly to camera, saying, "${dialogue.trim()}"`);
  speech.push(`Full lip-sync is REQUIRED for the ENTIRE ${end} seconds: the mouth moves continuously to match @Video1’s audio from the first frame to the last and NEVER holds or freezes. Take ONLY audio and speech timing from @Video1; take body pose, framing and appearance from the still reference images ${imageTags}.`);
  lines.push(speech.join(' '));

  const pins = [`@Image1 at 0.0s`];
  poses.forEach((p, i) => pins.push(`@Image${i + 2} at ${s1(p.offset)}s — at this instant the BODY reaches the keyframe pose; this keyframe sets the BODY and EYES only, the MOUTH ignores the reference image’s mouth and keeps lip-syncing to @Video1`));
  pins.push(`${lastTag} at ${end}s`);
  lines.push(`The clip is exactly ${end} seconds long. The still reference images are keyframes pinned to SPECIFIC times — pass smoothly THROUGH each at its timestamp with continuous motion and no held freezes: ${pins.join('; ')}.`);

  if (userPrompt.trim()) lines.push(userPrompt.trim());
  lines.push('Bold clean dark outlines of constant weight, flat color fills, minimal shading, no gradients, no photorealism, no 3D.');
  return lines.join('\n\n');
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test test/edit-ui-trim-prompt.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/edit-ui/trim-prompt.js test/edit-ui-trim-prompt.test.js
git commit -m "feat(edit-ui): targeted-edit prompt builder"
```

---

### Task 4: Trim generator (`trim-generator.js`)

**Files:**
- Create: `src/edit-ui/trim-generator.js`
- Test: `test/edit-ui-trim-generator.test.js`

**Interfaces:**
- Consumes: `planWindows` (Task 1); `trimPadVideo`/`trimPadSpeech`/`extractFrame` (Task 2); `buildTrimPrompt` (Task 3); `readRunView` (runview.js); `nearestAspect` (inputs.js); `updateRun` (workspace.js). Injected deps: `runner` (`{ upload, }`), `runBatch(runner, [{ ref, model, opts }]) -> [{ status, outputUrl, error, id }]`, `download(url, absPath)`, `transcribe(wavPath) -> Promise<string>`, `ffmpeg(args)`, `now()`.
- Produces: `createTrimGenerator(deps?) -> { name: 'seedance-draft', run(job) }`. `run` returns `{ output: <workspace-relative first-window output | null>, windows: [...] }`.

**Region derivation (document inside run()):** from the run manifest, build regions as
- each edited keyframe (`inputs[]` role `keyframe` kind `edited`): `{ kind:'point', start: time, end: time }`;
- each mark (`manifest.marks`): frame mark → `{ kind:'point', start: start/fps, end: start/fps }`; range mark → `{ kind:'range', start: start/fps, end: end/fps }`.
Annotations are excluded this phase. Pose refs for a window = edited keyframes whose `time` ∈ `sourceSpan`, ordered by time, offset = `time − W0`. Pose + first/last ref list is capped by `readRunView`'s default `maxImages` (keep first, last, then earliest poses).

- [ ] **Step 1: Write failing tests (injected fakes; no ffmpeg/network)**

```javascript
// test/edit-ui-trim-generator.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTrimGenerator } from '../src/edit-ui/trim-generator.js';

// Minimal run scaffold: workspace/<id>/runs/v001 with a manifest + prompt.txt + source.
async function scaffold(fn, { inputs, marks = [], duration = 10, fps = 24 }) {
  const ws = await mkdtemp(path.join(tmpdir(), 'trimgen-'));
  const id = 'abcdef0123456789';
  const runDir = path.join(ws, id, 'runs', 'v001');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(ws, id, 'source.mp4'), 'v');
  const manifest = {
    run: 'v001', kind: 'video', prompt: { text: 'raise a fist' }, settings: { fps },
    source: { id, file: 'source.mp4', duration, width: 1080, height: 1920, fps },
    marks, prompts: [{ markId: null, text: 'raise a fist' }], inputs, warnings: [],
  };
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));
  const deps = recordingDeps();
  const gen = createTrimGenerator(deps);
  const job = { root: ws, videoPath: path.join(ws, id, 'source.mp4'), outDir: path.join(ws, id),
    runDir, run: manifest, jobId: 'job1', request: { kind: 'video', marks, fps } };
  try { return await fn({ ws, runDir, gen, job, deps }); } finally { await rm(ws, { recursive: true, force: true }); }
}

function recordingDeps() {
  const submissions = [];
  return {
    submissions,
    ffmpeg: async () => {},                              // no-op; media assertions are separate
    transcribe: async () => 'Hello there',
    runner: { upload: async () => ({ id: 'vid-1' }) },
    runBatch: async (_r, items) => { submissions.push(...items); return items.map(() => ({ status: 'completed', outputUrl: 'http://x/out.mp4', id: 'j' })); },
    download: async (_url, abs) => { await writeFile(abs, 'clip'); },
    now: () => '2026-10-13T00:00:00.000Z',
  };
}
const editedKf = (frame, time) => ({ role: 'keyframe', kind: 'edited', frame, time, path: `abcdef0123456789/runs/v001/keyframes/edited/f${frame}.png` });
const baseInputs = [{ role: 'source', path: 'abcdef0123456789/source.mp4' }, { role: 'speechref', path: 'abcdef0123456789/runs/v001/speechref.mp4' }, { role: 'audio', path: 'abcdef0123456789/derived/audio.wav' }];

test('a single edited keyframe produces one window and one draft submission (3kf)', async () => {
  await scaffold(async ({ gen, job, deps, runDir }) => {
    const res = await gen.run(job);
    assert.equal(deps.submissions.length, 1);
    const { opts, model } = deps.submissions[0];
    assert.equal(model, 'seedance_2_5');
    assert.deepEqual(opts.extraArgs, ['--draft', 'true']);   // draft default
    assert.equal(opts.mode, 'omni_reference');
    assert.equal(opts.resolution, '480p');
    assert.equal(opts.aspectRatio, '9:16');                  // nearestAspect(1080,1920)
    assert.equal(opts.duration, 4);
    assert.ok(opts.startImage && opts.endImage);
    assert.equal(opts.imageReferences.length, 1);            // one pose => 3kf
    assert.deepEqual(opts.videoReferences, ['vid-1']);
    const m = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
    assert.equal(m.windows.length, 1);
    assert.deepEqual(m.windows[0].pad, { start: 0, end: 0 });
    assert.equal(m.windows[0].status, 'done');
    assert.match(res.output, /windows\/w01\/out\.mp4$/);
  }, { inputs: [...baseInputs, editedKf(120, 5)], duration: 10 });
});

test('a mark with no edited keyframe submits a 2kf text-pose job', async () => {
  await scaffold(async ({ gen, job, deps }) => {
    await gen.run(job);
    assert.equal(deps.submissions.length, 1);
    assert.equal(deps.submissions[0].opts.imageReferences.length, 0);  // text-pose => no middle
  }, { inputs: baseInputs, marks: [{ id: 'm1', kind: 'frame', start: 120, end: 120 }], duration: 10 });
});

test('two distant marks yield two windows and two submissions', async () => {
  await scaffold(async ({ gen, job, deps, runDir }) => {
    await gen.run(job);
    assert.equal(deps.submissions.length, 2);
    const m = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
    assert.equal(m.windows.length, 2);
  }, { inputs: baseInputs, marks: [{ id: 'a', kind: 'frame', start: 48, end: 48 }, { id: 'b', kind: 'frame', start: 216, end: 216 }], duration: 12 });
});

test('a failing window is isolated; other windows still complete and an output returns', async () => {
  await scaffold(async ({ gen, job, deps, runDir }) => {
    let call = 0;
    deps.runBatch = async (_r, items) => { call++; return items.map(() => (call === 1 ? { status: 'failed', error: 'boom' } : { status: 'completed', outputUrl: 'http://x/o.mp4' })); };
    const res = await gen.run(job);
    const m = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
    const statuses = m.windows.map((w) => w.status).sort();
    assert.deepEqual(statuses, ['done', 'error']);
    assert.ok(res.output);                                   // the good window still gives an output
  }, { inputs: baseInputs, marks: [{ id: 'a', kind: 'frame', start: 48, end: 48 }, { id: 'b', kind: 'frame', start: 216, end: 216 }], duration: 12 });
});

test('no regions falls back to one whole-clip window', async () => {
  await scaffold(async ({ gen, job, deps }) => {
    await gen.run(job);
    assert.equal(deps.submissions.length, 1);
    assert.equal(deps.submissions[0].opts.duration, 10);     // whole clip
  }, { inputs: baseInputs, marks: [], duration: 10 });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/edit-ui-trim-generator.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `trim-generator.js`**

```javascript
// src/edit-ui/trim-generator.js
// The edit-ui "seedance-draft" generator: per marked region, trim a centered >=4s window
// (padding at source edges), run an HF-draft Seedance edit that preserves lip-sync, and
// fold splice-back metadata into the run manifest. Phase 2 (splice-back) is separate.
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

function defaultFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}: ${err.slice(-300)}`))));
  });
}
async function defaultTranscribe(wav) {
  const { transcribeAudio } = await import('../transcribe.js');
  const r = await transcribeAudio(wav); return (r && r.text) || '';
}
async function defaultRunner() { const { createRunner } = await import('../cli.js'); return createRunner(); }
async function defaultRunBatch(runner, items) { const { runBatch } = await import('../batch.js'); return runBatch(runner, items); }
async function defaultDownload(url, abs) { const { downloadTo } = await import('../download.js'); return downloadTo(url, abs); }

const pad2 = (n) => String(n).padStart(2, '0');

export function createTrimGenerator(deps = {}) {
  const {
    ffmpeg = defaultFfmpeg, transcribe = defaultTranscribe, runBatch = defaultRunBatch,
    download = defaultDownload, now = () => new Date().toISOString(),
  } = deps;

  return {
    name: 'seedance-draft',
    async run({ root, runDir, run, request }) {
      const runnerRef = deps.runner || (await defaultRunner());
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
          ? { kind: 'range', start: m.start / fps, end: m.end / fps }
          : { kind: 'point', start: m.start / fps, end: m.start / fps })),
      ];

      let { windows } = planWindows({ regions, duration, fps });
      if (!windows.length) {
        windows = [{ window: [0, duration], sourceSpan: [0, duration], pad: { start: 0, end: 0 }, clipDuration: duration, editCenters: [], regions: [] }];
      }

      const aspect = nearestAspect(run.source && run.source.width, run.source && run.source.height);
      const userPrompt = (run.prompt && run.prompt.text) || '';
      const results = [];
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        const wName = `w${pad2(i + 1)}`;
        const wDir = path.join(runDir, 'windows', wName);
        const entry = { name: wName, window: w.window, sourceSpan: w.sourceSpan, pad: w.pad,
          clipDuration: w.clipDuration, editCenters: w.editCenters, draft: true, status: 'pending', output: null };
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
            try { await ffmpeg(['-v', 'error', '-y', '-i', srTrim, '-vn', '-ac', '1', '-ar', '16000', wav]); dialogue = await transcribe(wav); }
            catch (e) { entry.note = `transcription unavailable: ${e.message}`; }
          }

          // Pose refs: edited keyframes inside this window, by time; cap first+poses+last at 8.
          const poses = edited.filter((k) => k.time >= w.sourceSpan[0] && k.time <= w.sourceSpan[1])
            .sort((a, b) => a.time - b.time)
            .map((k) => ({ offset: k.time - w.window[0], path: k.path }))
            .slice(0, 6);
          entry.keyframeCount = poses.length;

          const prompt = buildTrimPrompt({ dialogue, clipDuration: w.clipDuration, poses, userPrompt });
          await writeFile(path.join(wDir, 'prompt.md'), prompt + '\n');

          const opts = {
            prompt, startImage: first, endImage: last,
            imageReferences: poses.map((p) => p.path),
            resolution: '480p', aspectRatio: aspect, duration: w.clipDuration,
            generateAudio: true, mode: 'omni_reference', extraArgs: ['--draft', 'true'],
          };
          if (view.speechref && srTrim) { const up = await runnerRef.upload(srTrim); opts.videoReferences = [up.id]; }

          const [r] = await runBatch(runnerRef, [{ ref: wName, model: 'seedance_2_5', opts }]);
          if (r && r.status === 'completed' && r.outputUrl) {
            const out = path.join(wDir, 'out.mp4');
            await download(r.outputUrl, out);
            entry.output = relOut(out); entry.status = 'done'; entry.finishedAt = now();
          } else {
            entry.status = 'error'; entry.error = (r && r.error) || `generation ${r && r.status}`;
          }
        } catch (err) {
          entry.status = 'error'; entry.error = err.message;
        }
        entry.prompt = relOut(path.join(wDir, 'prompt.md'));
        results.push(entry);
      }

      await updateRun(runDir, { windows: results });
      const firstOk = results.find((w) => w.output);
      return { output: firstOk ? firstOk.output : null, windows: results };
    },
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test test/edit-ui-trim-generator.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/edit-ui/trim-generator.js test/edit-ui-trim-generator.test.js
git commit -m "feat(edit-ui): seedance-draft trim generator"
```

---

### Task 5: Register as default backend + CLI help

**Files:**
- Modify: `src/edit-ui/generators.js`
- Modify: `test/edit-ui-generators.test.js`
- Modify: `bin/pipeline.js` (help line for `edit-ui`)

**Interfaces:**
- Consumes: `createTrimGenerator` (Task 4), `createStubGenerator` (generator.js).
- Produces: `generatorNames()` includes `seedance-draft` and `stub`; `DEFAULT_GENERATOR === 'seedance-draft'`.

- [ ] **Step 1: Update the registry test (RED)**

Add to `test/edit-ui-generators.test.js`:

```javascript
test('seedance-draft is registered and is the default', () => {
  assert.ok(generatorNames().includes('seedance-draft'));
  assert.equal(resolveGenerator().name, 'seedance-draft');
});
```

And change the existing default-stub test to assert explicit selection instead:

```javascript
test('stub is still selectable by name', () => {
  assert.equal(resolveGenerator('stub').name, 'stub');
});
```
(Delete the old "defaults to stub" assertions in the `resolveGenerator defaults to stub` test — replace that test with the two above.)

- [ ] **Step 2: Run, verify the new default test fails**

Run: `node --test test/edit-ui-generators.test.js`
Expected: FAIL (`seedance-draft` not registered; default still stub).

- [ ] **Step 3: Register + flip default**

In `src/edit-ui/generators.js`:

```javascript
import { createStubGenerator } from './generator.js';
import { createTrimGenerator } from './trim-generator.js';

const REGISTRY = {
  'seedance-draft': createTrimGenerator,
  stub: createStubGenerator,
};

export const DEFAULT_GENERATOR = 'seedance-draft';
```

(Leave `generatorNames`/`resolveGenerator` bodies unchanged.)

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test test/edit-ui-generators.test.js`
Expected: PASS.

- [ ] **Step 5: Update CLI help + startup copy**

In `bin/pipeline.js`, change the `edit-ui` help line's `[--generator <stub>]` to `[--generator <seedance-draft|stub>]`. (The startup log already prints `generator.name` dynamically — no change needed.)

- [ ] **Step 6: Commit**

```bash
git add src/edit-ui/generators.js test/edit-ui-generators.test.js bin/pipeline.js
git commit -m "feat(edit-ui): default to seedance-draft generator"
```

---

### Task 6: Full-suite green + doc pointer

**Files:**
- Modify: `docs/recipes/targeted-edit-backend.md` (add a short "edit-ui wiring" note), optional.

- [ ] **Step 1: Run the whole suite**

Run: `node --test`
Expected: all pass (previous baseline 472 + new tests), 0 fail. Fix any regressions in the code, not the tests.

- [ ] **Step 2: Append an edit-ui note to the backend recipe**

Add a short paragraph under the recipe's intro noting that `pipeline edit-ui` now drives this workflow via the `seedance-draft` generator (`src/edit-ui/trim-generator.js`), windows planned by `src/edit-ui/windows.js`, splice-back deferred to phase 2.

- [ ] **Step 3: Commit**

```bash
git add docs/recipes/targeted-edit-backend.md
git commit -m "docs(edit-ui): note the seedance-draft generator wiring"
```

---

## Notes for the executor

- `runBatch` item shape is `{ ref, model, opts }` and results are `[{ status, outputUrl, error, id }]` — confirm against `src/batch.js` and `hf-textpose.js` before Task 4 Step 3; adjust `opts` field names (`startImage`/`endImage`/`videoReferences`/`imageReferences`/`extraArgs`) to whatever `buildGenerateArgs` in `src/cli.js` actually consumes. The tests assert the field names this plan uses; if the real runner differs, update both the implementation and the test's assertions together (they must still prove draft-on, 3kf-vs-2kf, duration, aspect).
- `transcribeAudio`'s real export name/return shape in `src/transcribe.js` must be confirmed in Task 4 Step 3; the injected fake in tests sidesteps it, and `defaultTranscribe` is only exercised in real runs.
- Do not touch `server.js`/`workspace.js`/`inputs.js`/`runview.js`.
