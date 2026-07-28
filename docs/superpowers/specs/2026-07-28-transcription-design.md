# Speech Transcription (STT) — Design

**Date:** 2026-07-28
**Status:** Approved (design, revised for whisper.cpp + rebased on lip-sync work); pending implementation

## Problem

Some shots lip-sync a character to a **user-provided speech recording** (e.g.
`references/voices/ART1.wav`). For fidelity, the **exact transcript** of that recording
must appear in the Seedance prompt. Today there is no way to produce that transcript
inside the pipeline, so it is transcribed by hand — error-prone and easy to get subtly
wrong.

The lip-sync *generation* path already exists (added in PR #39): `pipeline shot
generate --speech-audio <wav>` wraps the wav into a blank mid-gray video and passes it
as a Seedance video reference. Its recipe (`docs/recipes/seedance-lipsync.md`)
explicitly defers the transcript step:

> The prompt should also quote the exact transcript line … *(Auto-quoting the
> transcript from a script file is a separate, not-yet-built feature; author the prompt
> by hand for now.)*

**This feature builds that missing piece:** produce the exact transcript so prompt
authoring can quote it verbatim. An earlier idea — matching a WAV to a line in a
hand-maintained `script.txt` by filename convention — was rejected as too brittle. The
user prefers real speech-to-text (STT).

## Decisions (from brainstorming)

1. **STT engine:** local **whisper.cpp**, behind a **swappable transcriber seam**. The
   pipeline shells out to a `whisper-cli` binary (mirroring how it shells out to the
   Higgsfield CLI), so it is offline, free per clip, and has no native npm build. A
   `higgsfield` engine stays registered but errors clearly ("not supported by the CLI
   yet"); it can become real when Higgsfield lifts the block.
2. **Command scope:** a **standalone** `pipeline voice transcribe` on **arbitrary audio
   paths** (single file or a directory), not tied to the `elements/`/`shots/` tree —
   it works directly on `references/voices/*.wav`.
3. **Prompt hookup:** **guidance only.** The lip-sync recipe and `element-author` flow
   read the transcript **sidecar** and quote it verbatim. No `shot.yaml` change, no
   auto-injection into `prompt.md`.

## Key finding (why not Higgsfield)

Verified against the installed CLI **and the latest release**: `generate create
speech2text` (a `data`-type model) is rejected on both **1.1.19** and **1.1.20**
(built 2026-07-27):

```
$ higgsfield generate create speech2text --audio-references ART1.wav
Error: Model type "data" is not supported by generate create yet.
```

The earlier "Missing required params: audio_references" message is only argument
validation that fires *before* the model-type gate. There is no `generate workflow`
transcription workflow either. So Higgsfield STT is **not callable through the CLI
today** — hence whisper.cpp as the first real engine, which is also the user's stated
long-term direction.

## Already in place (from parallel PRs — do NOT rebuild)

- **#37** added `audioReferences` / `videoReferences` → `--audio-references` /
  `--video-references` passthrough in `buildGenerateArgs` (`src/cli.js`). The spec's
  earlier planned `cli.js` change is therefore **dropped**.
- **#39** added `src/speechclip.js` (`makeBlankSpeechVideo`), `--speech-audio` on
  `shot generate`/`verify`, moderation-terminal handling, and
  `docs/recipes/seedance-lipsync.md`.

## Architecture

Three layers, each independently testable, mirroring the existing `runner` /
`defaultExec` seam in `src/cli.js`.

### 1. Transcriber seam (`src/transcribe.js`)

Interface: `transcribe(audioPath) -> { text, raw }` (`text` trimmed exact transcript;
`raw` kept for debugging).

**First implementation — `whisperTranscriber({ bin, model, exec })`:**
- Runs `whisper-cli -m <model> -f <audioPath> -nt` via an **injected `exec`** (default
  a `child_process.execFile` wrapper, exactly like `defaultExec`), capturing stdout.
- `extractTranscript(stdout)` pulls the transcript string out of whisper.cpp's output.
- A missing binary (ENOENT) becomes an actionable error naming
  `brew install whisper-cpp`; a missing model file errors with the exact model download
  command. Never writes an empty sidecar silently.
- Injecting `exec` means unit tests spawn no real whisper — a fake `exec` returns
  canned stdout.

### 2. `extractTranscript(stdout)`

whisper.cpp prints the transcription to stdout; with `-nt` it is plain text, but
without it each line is prefixed `[HH:MM:SS.mmm --> HH:MM:SS.mmm]`. The extractor is
lenient: per line, strip a leading `[..-->..]` timestamp token if present, trim, drop
empty lines, and join the remainder with single spaces. Empty result → throw
`could not extract a transcript from whisper output`.

### 3. Engine selection + command driver

- `getTranscriber(engine, opts)` — `whisper` (default) → `whisperTranscriber`;
  `higgsfield` → a stub whose `transcribe` throws "Higgsfield speech2text is not
  callable via the CLI yet (data jobs unsupported)"; unknown → clear error.
- `transcribeInputs(spec, { transcriber })` — resolves inputs, skips sources whose
  sidecar exists (unless `--force`), calls the transcriber, writes each sidecar,
  returns one record per source (`{ audio, sidecar, status: 'transcribed'|'skipped' }`).

`bin/pipeline.js` → **`pipeline voice transcribe`**:

```
pipeline voice transcribe --audio <file> [--audio <file> ...] [--out <file>]
pipeline voice transcribe --dir <folder>
   [--engine whisper] [--model-file <path>] [--force]
```

- **Inputs:** repeatable `--audio <file>` and/or `--dir <folder>` (audio files directly
  inside it — `.wav`, `.mp3`, `.m4a`, `.flac`, `.ogg`, case-insensitive). At least one
  required.
- **Sidecar:** for `X.wav` write `X.txt` in the same directory (UTF-8, exact
  transcript, single trailing newline). `--out` allowed only for the single-`--audio`,
  no-`--dir` case.
- **Idempotency:** skip a source whose sidecar exists unless `--force`.
- **Output:** per-file summary (`+ <sidecar>` / `= <sidecar> (exists)`), then
  `transcribed N, skipped M`.

### 4. Binary + model resolution (`src/config.js`)

- `whisperBin()` — `WHISPER_CPP_BIN` env, else `whisper-cli` (resolved on PATH by the
  OS; ENOENT is handled with an install hint).
- `whisperModelPath(explicit)` — explicit `--model-file` > `WHISPER_CPP_MODEL` env >
  default `<REPO_ROOT>/models/ggml-base.en.bin`.
- Model files are **not** auto-downloaded (keeps file downloads user-initiated); a
  missing model errors with the exact `curl` command to fetch it from the whisper.cpp
  model repo.

## Storage convention

Sidecar = same directory + same basename + `.txt` as the source audio. Co-located, so
it travels with the file and works under `references/voices/`, an element's
`inputs/speech-samples/`, or a shot's `inputs/`. No central index.

## Prompt hookup (docs only)

- Update `docs/recipes/seedance-lipsync.md`: replace the "not-yet-built … author by
  hand" note with the `pipeline voice transcribe` step and quoting the sidecar.
- Update `templates/skills/element-author/SKILL.md` (+ pointer in `templates/CLAUDE.md`):
  for a lip-sync shot, run `voice transcribe` on the wav, then quote the sidecar's text
  verbatim in the Seedance prompt, and still pass the wav via `--speech-audio`.
- No `shot.yaml` field.

## Testing

Unit tests (`test/transcribe.test.js`), all with a **fake `exec` / fake transcriber** —
no whisper binary, no network:
- `extractTranscript`: plain `-nt` stdout; timestamped stdout (strips `[..-->..]`);
  multi-line joined; empty → throws.
- `whisperTranscriber`: builds the right `whisper-cli` args (`-m model -f audio -nt`),
  returns extracted text; ENOENT → install-hint error; missing model → download-hint
  error.
- `getTranscriber`: default `whisper`; `higgsfield` throws the deferred-engine error;
  unknown engine errors.
- Sidecar path derivation (`X.wav`→`X.txt`; `--out`; `--out`+`--dir` rejected).
- Skip-existing vs `--force`.
- `--dir` enumeration (only recognized audio extensions; ignores `.txt`/others).
- `config.js`: `whisperModelPath` precedence (flag > env > default).

**Live verification (manual, not CI):** once whisper.cpp + a model are installed,
transcribe one real `references/voices/*.wav` and confirm the sidecar text.

## Files touched

- `src/transcribe.js` — **new**: seam, `whisperTranscriber`, `extractTranscript`,
  `getTranscriber`, `transcribeInputs`, audio-dir enumeration.
- `src/config.js` — `whisperBin`, `whisperModelPath`.
- `bin/pipeline.js` — `voice transcribe` command + usage.
- `docs/recipes/seedance-lipsync.md`, `templates/skills/element-author/SKILL.md`,
  `templates/CLAUDE.md` — transcribe step + prompt-hookup guidance.
- `test/transcribe.test.js` — **new**.
- No new npm dependency; no `src/cli.js` change (#37 already did it).

## Out of scope (YAGNI)

- Higgsfield engine implementation (blocked at the CLI — only the deferred stub).
- Auto-download / auto-build of the whisper.cpp binary or model files.
- `shot.yaml` integration / auto-injection into `prompt.md`.
- Element/shot-aware wrappers (standalone path-based command only).
- Word/segment-level timing (only the full transcript string).

## Delivery

Ships as its **own PR** off the current `main` (with #37/#39); merge only after the
user confirms. See `pipeline-changes-via-pr` in project memory.
