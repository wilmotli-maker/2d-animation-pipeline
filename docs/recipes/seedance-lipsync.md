# Recipe: audio/video-driven lip-sync shots (Seedance 2.0)

How to make `pipeline shot generate` reproduce a speech recording's **exact words
and pacing** on a talking-character shot. Derived from the working `art-talk-01`
take (v6) in the ArtAI project.

## Command

```bash
pipeline shot generate --id art-talk-01 --version 7 --model seedance_2_0 \
  --image art-3q-pose.png \
  --speech-audio ART1.wav \
  --resolution 720p --duration 5 --aspect-ratio 3:4 --generate-audio true
```

`--speech-audio <wav>` is the key flag: the pipeline wraps the wav into a **blank
mid-gray video** (audio = the wav, length = the wav via `-shortest`) and passes it
as a Seedance **video reference**. Power users can still pass a prepared clip with
`--video <file>` and/or a bare `--audio <file>`.

## Why a video reference, not an audio reference

Seedance 2.0 only reproduces the input recording's exact words *and* pacing when the
speech arrives as a **video** reference:

| Approach | Result |
| --- | --- |
| `--audio-references <wav>` + `--generate-audio true` | Model invents *different words*, ~14–17% slower delivery. |
| `--generate-audio false` (silent render, mux wav after) | Real audio drifts vs. the model's lip timing. |
| **Blank video carrying the wav via `--video-references` + `--generate-audio true`** | Generated audio matches the wav's silence boundaries within ~1 frame; words correct. ✅ |

The prompt should also quote the exact transcript line and name the reference video
as the speech source. Get the exact transcript from the wav with:

```bash
pipeline voice transcribe --audio ART1.wav      # writes ART1.txt beside it
```

Then quote `ART1.txt`'s text **verbatim** in the prompt (e.g. `the character says,
"<transcript>"`). `voice transcribe` uses local whisper.cpp (`brew install
whisper-cpp` + a ggml model — it prints the exact download command if the model is
missing); `--dir references/voices` transcribes a whole folder at once and skips wavs
that already have a `.txt`.

## Gotchas

1. **Use mid-gray, never black.** A black blank frame trips a false-positive `nsfw`
   moderation flag (`status: "nsfw"`, no output). The helper fills with `0x7f7f7f`.
   `nsfw` is somewhat nondeterministic — a re-roll often passes.
2. **`nsfw` is a terminal failure.** The poller now recognizes moderation verdicts
   (`nsfw`/`moderated`/`rejected`) as terminal; previously such jobs polled for ~1h.
3. **Uploads can take >2 min.** The pipeline submits with `wait:false` then polls, so
   this is handled — but any wrapper that blocks on a synchronous submit should run
   in the background.
4. **Seedance reference caps** (`higgsfield model get seedance_2_0`): ≤9 image refs
   (incl. start/end), ≤3 video refs, ≤3 audio refs, ≤12 total; audio refs require at
   least one image/video/start/end; `mode: fast` supports only 480p/720p.
   `pipeline verify shot` enforces these.

## Verifying a take

Confirm the output has an audio stream whose speech-silence boundaries match the
source wav within ~1–2 frames:

```bash
ffprobe -hide_banner output.mp4                       # has an audio stream
ffmpeg -i output.mp4 -af silencedetect=n=-30dB:d=0.2 -f null -   # boundaries vs ART1.wav
```

## Requirements

`ffmpeg` (and `ffprobe`) on `PATH`. On macOS: `brew install ffmpeg`.
