# Plan: teach `pipeline shot generate` to do audio/video-driven lip-sync shots

**Repo:** `~/Projects/2d-animation-pipeline`
**Status:** ready to implement (self-contained handoff)
**Origin:** derived from shot `art-talk-01` in the ArtAI project, where we hand-drove the Higgsfield CLI to land a working lip-sync take (v6). This plan bakes that working recipe into the pipeline so `pipeline shot generate` can produce it directly.

---

## 1. Goal

Today `pipeline shot generate` can only send a **prompt + image references** to a model. For talking-character video shots (Seedance 2.0) we also need to control **audio/speech input, resolution, duration, aspect ratio, and audio generation** — none of which are plumbed. As a result the ArtAI session had to bypass the pipeline and call the Higgsfield CLI directly for every take.

Add first-class support so a single command reproduces the proven lip-sync recipe.

### Target UX

```
pipeline shot generate --id art-talk-01 --version 6 --model seedance_2_0 \
  --image art-3q-pose.png \
  --speech-audio ART1.wav \
  --resolution 720p --duration 5 --aspect-ratio 3:4 --generate-audio true
```

`--speech-audio <wav>` is the headline addition: the pipeline wraps the wav into a **blank mid-gray 3:4 video** and passes it as a Seedance **video reference** (the trick that produced exact-pacing lip-sync — see §3). Power users can still pass a prepared clip via `--video <file>` / `--audio <file>`.

---

## 2. The proven recipe (what v6 actually did — capture this exactly)

Seedance 2.0 (`job_type: seedance_2_0`) reproduces an input speech recording's **exact words AND pacing** only when the speech is supplied as a **video reference**, not a bare audio reference:

- **Bare `--audio-references <wav>` + `--generate-audio true`** → model invents *different words* and a *slower* delivery (v2/v3/v4: ~14–17% slower than the recording).
- **`--generate-audio false`** → silent render (lip-synced to the ref); muxing the real wav afterward drifts vs the model's lip timing (v1/v5).
- **Blank video carrying the wav via `--video-references` + `--generate-audio true`** → generated audio matched the original `ART1.wav` silence boundaries within ~1 frame at every boundary, and words were correct (v6). ✅

The exact winning CLI call (for reference in tests):

```bash
HB=~/Projects/2d-animation-pipeline/node_modules/.bin/higgsfield
# blank speech video: mid-gray 3:4, audio = the wav, length = wav length
ffmpeg -y -f lavfi -i color=c=0x7f7f7f:s=720x960:r=24 -i ART1.wav \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest art1-speech-blank.mp4

"$HB" generate create seedance_2_0 --prompt "$PROMPT" \
  --resolution 720p --duration 5 --generate-audio true --aspect-ratio 3:4 \
  --video-references art1-speech-blank.mp4 \
  --image-references art-3q-pose.png --json
```

**Prompt requirement (feature #2, cross-reference):** the prompt must **quote the exact transcript line** and name the reference video as the speech source. v6's prompt lives at `ArtAI/shots/art-talk-01/drafts/v006/prompt.md`. Auto-quoting the transcript is a *separate* feature (WAV→script-line matcher); this plan only plumbs the generation flags. Keep the prompt authoring in the skill for now.

### Critical gotchas (must handle)

1. **Black blank video trips a false-positive `nsfw` moderation flag** (job ends `status: "nsfw"`, no output). Use **mid-gray** (`0x7f7f7f`). `nsfw` is somewhat nondeterministic — a re-roll often passes.
2. **`nsfw` is a terminal status the poller currently does NOT recognize** → infinite poll. Fix required (see §4, batch.js).
3. **Uploads can take >2 min.** The pipeline already submits with `wait:false` then polls (good), so this is fine — but any wrapper script that blocks on a single synchronous submit should run in the background.
4. Seedance model rules (from `higgsfield model get seedance_2_0`): ≤9 image refs (incl. start/end image), ≤3 video refs, ≤3 audio refs, ≤12 refs total; `audio_references` require at least one image/video/start/end; `mode: fast` supports only 480p/720p.

---

## 3. Current state of the code (precise)

- **`bin/pipeline.js`** — CLI entry. `shot generate` branch at **lines 96–109** builds the spec `{ shotId, version, model, prompt, promptFile, images: collectFlag(rest,'image') }` and calls `generateShotDraft(...)`.
  - **`parseFlags(rest)` (lines 29–36) steps by 2 (strict `--key value` pairs).** It cannot handle valueless boolean flags — a lone `--no-generate-audio` would misalign every following flag. **Therefore add value-style flags only** (`--generate-audio true|false`), or refactor the parser. `collectFlag` (lines 39–46) also steps by 2 to gather a repeatable flag.
- **`src/generate.js`** — `generateShotDraft(root, spec, {runner, runBatch, downloadTo})` at **lines 62–82**. Builds `opts = { prompt: v.promptText }` and only adds `opts.imageReferences = images`. Calls `runBatch(runner, [{ ref, model, opts }])`. Downloads `result.outputUrl` → `shots/<id>/drafts/vNNN/output.mp4`. **No audio/video/resolution/duration handling. Does not write a prompt copy or generation-log entry** (unlike `generateElementSheet`).
- **`src/cli.js`** — `buildGenerateArgs(model, opts)` (lines 43–58) already maps `MEDIA_FLAGS = { image:'--image', startImage:'--start-image', endImage:'--end-image', video:'--video', audio:'--audio', sketch:'--sketch' }`, plus `imageReferences` → repeated `--image-references`, plus `extraArgs` passthrough and `--json`/`--wait`. **Missing:** `videoReferences`/`audioReferences` arrays, and scalar model params (`resolution`, `duration`, `generate_audio`, `aspect_ratio`, `mode`, `bitrate_mode`, `genre`).
- **`src/batch.js`** — `runBatch` submits (`wait:false`) then polls `runner.get(id)` until `isTerminalStatus`. **`isTerminalStatus` (lines ~7–11) uses `FAILURE_RE = /fail|error|cancel/i` + `=== 'completed'`. `nsfw`/`moderated`/`rejected` are NOT terminal → the job polls until `maxPolls` (900 × 4 s ≈ 1 h).** Pending is `status === 'submitted'`; interim `waiting`/`in_progress` correctly stay pending.
- **`src/validate.js`** — `validateShotGenerate` (lines 71–91) checks shot/draft existence, resolves the prompt, and checks each `--image` exists. Extend to also check `--speech-audio`/`--video`/`--audio` files exist and enforce the Seedance ref-count rules.
- **`src/paths.js`** — `shotDraftDir(root, shotId, version)` and `shotDir(...)`. Add an inputs location if we persist generated blank videos (e.g. `shots/<id>/inputs/`).

---

## 4. Implementation steps

Work in small, verifiable commits.

### Step A — Fix the moderation terminal-status bug (`src/batch.js`)
- Extend `isTerminalStatus` so `nsfw`, `moderated`, `rejected`, `content_moderation` (case-insensitive) are terminal failures. Simplest: broaden `FAILURE_RE` to `/fail|error|cancel|nsfw|moder|reject/i`.
- In `generateShotDraft`/`generateElementSheet` error message, surface the status verbatim so `nsfw` is obvious (already does `result.status` — verify it reads clearly, e.g. `did not complete: nsfw`).
- **Test:** unit test `isTerminalStatus('nsfw') === true`.

### Step B — Pass model params through the runner (`src/cli.js`)
- In `buildGenerateArgs`, after the media flags, emit scalar params when present:
  `resolution, duration, generateAudio (→ --generate-audio), aspectRatio (→ --aspect-ratio), mode, bitrateMode, genre`.
  Map camelCase opt → kebab CLI flag; stringify booleans (`--generate-audio false`).
- Add `videoReferences` / `audioReferences` array handling mirroring `imageReferences` (repeat `--video-references` / `--audio-references`). Keep the scalar `--video`/`--audio` aliases working too.
- **Test:** extend the existing `buildGenerateArgs` unit tests (this function is exported specifically for that) — assert the arg array for a Seedance call.

### Step C — `--speech-audio` → blank video helper (`src/` new util, e.g. `src/speechclip.js`)
- `makeBlankSpeechVideo(wavPath, outPath, { aspect='3:4', fps=24 }) → Promise<outPath>`:
  compute the wav duration (ffprobe), pick WxH for the aspect (3:4 → 720×960, 16:9 → 1280×720, 9:16 → 720×1280), run:
  `ffmpeg -y -f lavfi -i color=c=0x7f7f7f:s=WxH:r=FPS -i <wav> -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest <out>`.
- Persist the generated clip at `shots/<id>/drafts/vNNN/speech-ref.mp4` (or `shots/<id>/inputs/`) so runs are reproducible.
- Require `ffmpeg`/`ffprobe` on PATH; fail with a clear message if absent.
- **Note:** default the color to mid-gray (0x7f7f7f) — do NOT use black (see §2 gotcha #1).

### Step D — Plumb the new spec through (`bin/pipeline.js` + `src/generate.js`)
- `bin/pipeline.js` `shot generate` branch: read new flags via `parseFlags`/`collectFlag`:
  `--speech-audio <wav>` (scalar), `--video`/`--audio` (repeatable → arrays), `--resolution`, `--duration`, `--aspect-ratio`, `--generate-audio`, `--mode`. Update the usage strings (lines 98–99 and the bottom help block 147).
  - Keep everything value-style (no valueless booleans) to respect `parseFlags`. If you'd rather support `--flag` booleans, refactor `parseFlags` first (separate commit) — otherwise leave it.
- `src/generate.js` `generateShotDraft`: accept the new spec fields; if `speechAudio` is set, call `makeBlankSpeechVideo(...)` and push the result into `videoReferences`. Assemble `opts` with `prompt, imageReferences, videoReferences, audioReferences, resolution, duration, generateAudio, aspectRatio, mode`. Pass to `runBatch`.
- Consider writing a small `output.json`/`vNNN.meta.json` next to `output.mp4` recording model + params + jobId (parity with element-sheet bookkeeping). Optional but nice.

### Step E — Validation (`src/validate.js`)
- In `validateShotGenerate`, add existence checks for `--speech-audio`, each `--video`, each `--audio`.
- Enforce Seedance ref-count rules (≤9 images incl. start/end, ≤3 video, ≤3 audio, ≤12 total; audio refs need an accompanying image/video/start/end). Emit `fail` checks with clear details.
- Validate `--resolution` ∈ {480p,720p,1080p,4k}, `--aspect-ratio` ∈ enum, `--generate-audio` ∈ {true,false}, `--duration` a positive integer. Model-specific: warn (don't hard-fail) so other video models still work.

### Step F — Docs
- Update the bottom-of-file usage block in `bin/pipeline.js` and any README/skill notes.
- Note the recipe + gotchas in the repo docs so the skill can reference it.

---

## 5. Testing / verification

- **Unit:** `buildGenerateArgs` arg construction (Step B), `isTerminalStatus('nsfw')` (Step A), validation rules (Step E). These are pure functions — no network.
- **Integration (mock runner):** `runBatch`/`generateShotDraft` already accept an injected `runner`/`runBatch`/`downloadTo` — write a fake runner returning `completed` + a fake URL, assert the blank video was built and the opts carried resolution/duration/generateAudio/videoReferences.
- **Live smoke (costs credits):** reproduce v6 —
  `pipeline shot generate --id art-talk-01 --version 7 --model seedance_2_0 --image <pose> --speech-audio <ART1.wav> --resolution 720p --duration 5 --aspect-ratio 3:4 --generate-audio true`
  Then verify with ffprobe/silencedetect that the output has an audio stream whose speech-silence boundaries match `ART1.wav` within ~1–2 frames (the objective check used in the ArtAI session).

---

## 6. Out of scope (separate follow-ups)

- **WAV→transcript-line matcher** (auto-quote the spoken line into the prompt from a transcript file like `references/voices/ART VS AI.txt`, keyed by naming convention `ART1.wav` = ART's 1st line). This is feature #2; this plan assumes the prompt already quotes the line.
- **In-pipeline transcription** — Higgsfield's `generate create` currently rejects `data`-type jobs (`speech2text`: "Model type 'data' is not supported by generate create yet"), and there's no local whisper. Revisit if/when the CLI supports data jobs or a local STT is added.
- Non-Seedance video models: keep param passthrough generic so they don't break, but don't special-case them here.

---

## 7. Reference artifacts (in the ArtAI project)

- Working take: `shots/art-talk-01/drafts/v006/output.mp4` + its `prompt.md`.
- Pose reference (cropped ¾-front from the turnaround): `shots/art-talk-01/inputs/art-3q-pose.png`.
- Blank speech video (mid-gray): `shots/art-talk-01/inputs/art1-speech-blank.mp4`.
- Transcript: `references/voices/ART VS AI.txt`; speech wavs named `<SPEAKER><line#>.wav`.
- Session memories: `seedance-lipsync-blank-video-audio`, `pipeline-shot-generate-no-audio-flag`.
