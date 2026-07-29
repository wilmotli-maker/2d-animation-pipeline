---
name: shot-author
description: Author a Seedance video shot for this animation project — compose the prompt from a rough idea and reference images, verify, generate, critique, and promote. Use when creating or iterating on a shot, a talking/lip-sync shot, an action or loop shot, or any Seedance clip under shots/.
---

# Shot Author

Turn a rough shot idea into a validated, generation-ready Seedance video take, and
iterate to a keeper. This is the shot-side parallel of `element-author`: it composes
the prompt with a worldbuilder director, runs the verify gate, generates, and drives
the critique → regenerate → promote loop. Keep it interactive — every generate is a
real credit cost (check `higgsfield account transactions`).

## Inputs to gather and confirm (propose defaults, never assume silently)

- Shot id (kebab-case slug, e.g. `art-talk-01`). If it doesn't exist yet, create it:
  `pipeline shot create --id <id> [--duration <s>] [--mode <m>] [--description <d>]`.
- Creative intent for the shot (who/what, action, mood, setting).
- Style register → which worldbuilder director (see *Choosing the director*).
- Reference images: a pose/turnaround panel of each character (from the element's
  `sheets/.../<slug>/<panel>.png`), plus any environment plate. Passed as `--image`.
- Model (`seedance_2_0` for video).
- For a **talking shot**: the speech recording (`.wav`). See *Lip-sync shots*.
- Seedance knobs: `--resolution` (480p/720p), `--duration` (s), `--aspect-ratio`
  (e.g. `3:4`), `--generate-audio` (`true`/`false`).

## Choosing the director

Compose the prompt with the worldbuilder skill that matches the project's style —
never hand-write the Seedance prompt from scratch:

- **`illustration-worldbuilder`** — illustrated / stylized / cartoon / anime shots.
- **`cinema-worldbuilder`** — photoreal / live-action-look shots.
- **`character-loop`** — a seamless 5s loop or cycle (idle, walk, run, wave, dance…)
  for a recurring character. Use this instead of the worldbuilders for loops.

## Procedure

1. **Ensure the shot exists** (`pipeline shot create …` if not) and confirm
   `shots/<id>/shot.yaml` (`duration`, `mode`, `description`).
2. **Open a draft version:** `pipeline shot draft --id <id>` → creates
   `shots/<id>/drafts/vNNN/`. Each iteration is a new version under the same shot.
3. **For a talking shot, transcribe first** (see *Lip-sync shots* — do this before
   composing so the exact line goes into the prompt).
4. **Compose the prompt.** Invoke the chosen director skill on the reference
   image(s) + intent to write the Seedance prompt (see *Prompt structure*). Keep it
   lean when strong reference images carry the look — over-prescription makes the
   model drift from the refs.
5. **Iterate** with the user on the prompt text (1–2 rounds).
6. **Write** the finalized prompt to the canonical path:
   `shots/<id>/drafts/vNNN/prompt.md`.
7. **Verify** — run and resolve any ✗ before spending credits (it enforces the
   Seedance reference caps in *Gotchas*):
   `pipeline verify shot --id <id> --version <n> [--image <ref> …] [--speech-audio <wav>] [--resolution <r>] [--duration <s>] [--aspect-ratio <a>] [--generate-audio <b>]`
8. **Generate** (reads the canonical prompt from step 6):
   `pipeline shot generate --id <id> --version <n> --model seedance_2_0 [--image <ref> …] [--speech-audio <wav>] [--resolution <r>] [--duration <s>] [--aspect-ratio <a>] [--generate-audio <b>]`
   Submissions can take >2 min (upload latency) — run submit+poll in the background.
9. **Review with the user.** Watch `drafts/vNNN/output.mp4`. Log the
   accept/regenerate decision in `drafts/vNNN/notes.md`. To refine, go back to
   step 2 (new version); correct the prompt **surgically** — change only the clause
   that was wrong.
10. **Promote the keeper** to `shots/<id>/final/`:
    `pipeline shot promote --id <id> --version <n> --output output.mp4`

## Lip-sync shots (talking characters) — the load-bearing recipe

To make Seedance reproduce a speech recording's **exact words AND snappy pacing**:

1. **Transcribe the wav** for the exact line:
   `pipeline voice transcribe --audio <wav>` → writes a `<wav>.txt` sidecar (local
   whisper.cpp; `--dir <folder>` does a whole folder and skips wavs already done).
2. **Quote the sidecar verbatim** in the prompt — `the character says, "<exact
   transcript>"` — do not paraphrase or re-capitalize. On a fast line that nearly
   fills the shot, also add *"say exactly and only this line, no added words, mouth
   closes and holds after the last word"* — otherwise the model can append a couple
   of hallucinated trailing words past the end of the audio.
3. **Feed the speech as a video reference, via `--speech-audio <wav>`:**
   `pipeline shot generate … --speech-audio <wav> --generate-audio true`
   The pipeline wraps the wav into a blank **mid-gray** video (length = the wav) and
   passes it as a Seedance **video reference**. Describe the character's mouth/jaw
   mechanism in the prompt so lip-sync has something to drive.

**Why a video reference, not an audio reference:** `--audio-references` + generate-audio
makes the model invent *different words* at a ~14–17% slower pace; generate-audio
`false` renders silent (muxing the wav after drifts vs. the model's lip timing). The
blank-video-carrying-the-wav anchors both content and timing — generated-audio silence
boundaries match the source wav within ~1 frame. Full writeup:
`docs/recipes/seedance-lipsync.md`.

## Prompt structure (what the director produces)

A Seedance shot prompt has: **Style & Mood** (register + setting) · **Dynamic
Description** (the action/performance, timed to the reference) · **Static
Description** (fixed character/wardrobe/background, "carrying from the attached pose
reference image") · a **Reference video (speech)** line for talking shots · a
**Diegetic audio** line (the character's own voice / footsteps / room tone — *never*
music or lyrics). See `shots/*/drafts/*/prompt.md` for worked examples.

## Gotchas / common mistakes

- **Mid-gray, never black.** A blank **black** speech video trips a false-positive
  `nsfw` moderation flag (`status: nsfw`, no output). The helper fills `0x7f7f7f`.
  Treat `nsfw`/`moderated`/`rejected` as **terminal** when polling — a re-roll often
  passes (it's somewhat nondeterministic).
- **Seedance reference caps** (from `higgsfield model get seedance_2_0`): ≤9 image
  refs (incl. start/end), ≤3 video refs, ≤3 audio refs, ≤12 total; audio refs need at
  least one image/video/start/end; `mode: fast` supports only 480p/720p. `verify
  shot` enforces these — run it before generating.
- **Prompt drift.** If a take drifts from the reference image, suspect prompt length
  first. Confirm the reference was actually sent: `higgsfield generate get <jobId>
  --json` (check `input_images`).
- **Don't hand-write the prompt.** Always compose via the worldbuilder / character-loop
  director so the style stack stays consistent across shots.

## Verifying a lip-sync take

```
ffprobe -hide_banner output.mp4                               # has an audio stream
ffmpeg -i output.mp4 -af silencedetect=n=-30dB:d=0.2 -f null - # boundaries vs the wav
```
Speech-silence boundaries should match the source wav within ~1–2 frames.
