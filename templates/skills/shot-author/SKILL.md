---
name: shot-author
description: Author a Seedance video shot for this animation project — compose the prompt from a rough idea and reference images, verify, generate, critique, and promote. Use when creating or iterating on a shot, a talking/lip-sync shot, an action or loop shot, or any Seedance clip under shots/ (top-level, or episodes/<N>/shots/ in an episodic project).
---

# Shot Author

Turn a rough shot idea into a validated, generation-ready Seedance video take, and
iterate to a keeper. This is the shot-side parallel of `element-author`: it composes
the prompt with a worldbuilder director, runs the verify gate, generates, and drives
the critique → regenerate → promote loop. Keep it interactive — every generate is a
real credit cost (check `higgsfield account transactions`).

## Episode root (episodic projects)

If the project has a top-level `episodes/` folder, shots are organized **per
episode** under `episodes/<N>/shots/<id>/…`. Before doing anything else, **confirm
which episode** with the user (don't assume the latest). Then, on **every** `pipeline
shot …` and `pipeline verify shot …` command below, pass `--root episodes/<N>` — that
is what lands the shot's data (`shot.yaml`, drafts, final) under
`episodes/<N>/shots/…`. Wherever this skill writes a `shots/<id>/…` path, read it as
`episodes/<N>/shots/<id>/…`.

Two things stay **top-level and cwd-relative** regardless of episode:

- **Run every command from the project's top directory** (the one holding
  `episodes/` and `elements/`), never from inside an episode folder. `--root` only
  redirects where shot data is *written*; `--image`/`--speech-audio`/`--output`
  paths are resolved against the current directory.
- **Element references are shared across episodes** — `--image elements/…` refs (and
  `--output episodes/<N>/shots/…` on promote) are cwd-relative from that top
  directory. Elements live once at the top-level `elements/`; never duplicate them
  per episode.

`pipeline voice transcribe` needs **no** `--root` — its `.txt` sidecar is written
next to the `--audio` wav. If the project has **no** `episodes/` folder (flat
layout), omit `--root` everywhere and paths are the top-level `shots/<id>/…`.

## Inputs to gather and confirm (propose defaults, never assume silently)

- Episode (episodic projects only): which `episodes/<N>` this shot belongs to →
  threads `--root episodes/<N>` through the shot commands (see *Episode root*).
- Shot id (kebab-case slug, e.g. `art-talk-01`). If it doesn't exist yet, create it:
  `pipeline shot create --id <id> [--root episodes/<N>] [--duration <s>] [--mode <m>] [--description <d>]`.
- Creative intent for the shot (who/what, action, mood, setting).
- Style register → which worldbuilder director (see *Choosing the director*).
- Reference images: a pose/turnaround panel of each character (from the element's
  `sheets/.../<slug>/<panel>.png`), plus any environment plate. Passed as `--image`.
- Model (`seedance_2_5` for video — the current default; `seedance_2_0` still works).
  2.5 needs `--mode omni_reference` whenever you pass any reference (its default
  `t2v` rejects reference media) and has no `genre` knob.
- For a **talking shot**: the speech recording (`.wav`). See *Lip-sync shots*.
- Seedance knobs: `--resolution` (480p/720p on 2.5), `--duration` (s),
  `--aspect-ratio` (e.g. `3:4`), `--generate-audio` (`true`/`false`), and on 2.5
  `--mode omni_reference`.
- **Resolution: draft AND finish at 480p, then upscale.** 2.5's 720p carries
  little more real detail than its 480p but costs twice as much (2.0 vs 4.0 cr/s).
  Generate at `--resolution 480p`, then enlarge the promoted final to 1080p with
  `pipeline shot upscale` (step 11). Cheaper than generating at 720p, and higher
  resolution.

## Choosing the director

Compose the prompt with the worldbuilder skill that matches the project's style —
never hand-write the Seedance prompt from scratch:

- **`illustration-worldbuilder`** — illustrated / stylized / cartoon / anime shots.
- **`cinema-worldbuilder`** — photoreal / live-action-look shots.
- **`character-loop`** — a seamless 5s loop or cycle (idle, walk, run, wave, dance…)
  for a recurring character. Use this instead of the worldbuilders for loops.

## Procedure

1. **Confirm the episode** (episodic projects — see *Episode root*), then **ensure
   the shot exists** (`pipeline shot create … [--root episodes/<N>]` if not) and
   confirm `shots/<id>/shot.yaml` (`duration`, `mode`, `description`).
2. **Open a draft version:** `pipeline shot draft --id <id> [--root episodes/<N>]` →
   creates `shots/<id>/drafts/vNNN/`. Each iteration is a new version under the same
   shot.
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
   `pipeline verify shot --id <id> --version <n> [--root episodes/<N>] [--image <ref> …] [--speech-audio <wav>] [--resolution <r>] [--duration <s>] [--aspect-ratio <a>] [--generate-audio <b>]`
8. **Generate** (reads the canonical prompt from step 6):
   `pipeline shot generate --id <id> --version <n> --model seedance_2_5 --mode omni_reference [--root episodes/<N>] [--image <ref> …] [--speech-audio <wav>] --resolution 480p [--duration <s>] [--aspect-ratio <a>] [--generate-audio <b>]`
   Submissions can take >2 min (upload latency) — run submit+poll in the background.
   Draft at `--resolution 480p`; the crisp final comes from the upscale in step 11.
9. **Review with the user.** Watch `drafts/vNNN/output.mp4`. Log the
   accept/regenerate decision in `drafts/vNNN/notes.md`. To refine, go back to
   step 2 (new version); correct the prompt **surgically** — change only the clause
   that was wrong.
10. **Promote the keeper** to `shots/<id>/final/`. `--output` is the **source** file
    (copied verbatim — pass the full cwd-relative path to the draft's mp4, not a bare
    name; in an episodic project that path includes the `episodes/<N>/` prefix):
    `pipeline shot promote --id <id> --version <n> [--root episodes/<N>] --output episodes/<N>/shots/<id>/drafts/vNNN/output.mp4`
    The final clip is written as `shots/<id>/final/<id>-vNNN.<ext>` (e.g.
    `art-talk-01-v006.mp4`) — the filename **carries the promoted version**, so which
    draft is live is obvious at a glance. Promote also writes
    `shots/<id>/final/source-draft.txt` with that version as a machine-readable
    pointer. After promoting, log the promotion in that draft's `notes.md` so the
    chosen take is traceable from both ends.
11. **Upscale the final** (when drafting at 480p — the recommended path):
    `pipeline shot upscale --id <id> [--root episodes/<N>]`
    Enlarges the promoted final to 1080p and writes `shots/<id>/final/upscaled-1080p.mp4`
    beside it, with a `.json` sidecar recording model/job/source. `topaz_video` is
    the default and best preserves flat-2D line art; add `--resolution 2160p` for 4K,
    or `--model bytedance_video_upscale` for a cheaper (softer) pass. Needs `ffmpeg`.
    The upscaled file is the deliverable; the promoted 480p clip stays as the master.

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

### Long / drift-prone wavs (stutter, repeated or doubled words)

On longer lines (~7–10s+) the generated audio can stutter or repeat words. Fix in
this order:

1. **Simplify the prompt first — this is the primary fix.** A long, repetitive prompt
   is itself a cause of speech drift: a bloated 10s shot stuttered, and cutting the
   prompt to ~1/3 (lead with the exact line, then terse mouth / eyes / no-props /
   clean-green rules) produced a clean 10s take. Note that comparably long *Art* shots
   (9–14s) were clean with lean prompts — length alone isn't the problem, prompt bloat
   is. So hone the prompt before assuming the shot must be split. Keep the exact-words
   and "each word once, no repeats/doubles/stutters/echoes" guard, but drop the prose.
2. **Re-roll.** The stutter is somewhat nondeterministic; a fresh draw of the leaned
   prompt often lands clean.
3. **Segment-and-stitch (fallback, only if 1–2 fail).** Split the wav into two shorter
   phrases on a silence gap; generate phrase 1; pick a **resting-pose frame from
   phrase 1's tail** (after the mouth closes) and pass it as the **single image
   reference** to generate phrase 2 — a lone image reference becomes that shot's first
   frame, giving continuity. Then concatenate `p1[0:cut] + p2`, choosing the cut so the
   inter-phrase gap matches the original wav's gap (measure with `silencedetect`). To
   fix mouth-interior colors on phrase 2 (a closed-mouth start frame carries no
   open-mouth colors), add a second image reference: an **open-mouth frame** from
   phrase 1, and tell the prompt to use it *only* for mouth color, not pose.
   - **Seam pop:** the model repaints frame 1 in its own pass, so phrase 2's first
     frame is *not* pixel-identical to phrase 1's tail (~22 dB PSNR) — and Seedance's
     `start_image` param does **not** pixel-lock it either (tested: no better than a
     plain image reference). Hide the small residual jump with a 2–3 frame
     **crossfade** at the seam (the resting pose is static, so the dissolve is
     invisible); don't chase a pixel-perfect generation.

## Prompt structure (what the director produces)

A Seedance shot prompt has: **Style & Mood** (register + setting) · **Dynamic
Description** (the action/performance, timed to the reference) · **Static
Description** (fixed character/wardrobe/background, "carrying from the attached pose
reference image") · a **Reference video (speech)** line for talking shots · a
**Diegetic audio** line (the character's own voice / footsteps / room tone — *never*
music or lyrics). See `shots/*/drafts/*/prompt.md` (or
`episodes/*/shots/*/drafts/*/prompt.md` in an episodic project) for worked examples.

## Gotchas / common mistakes

- **Mid-gray, never black.** A blank **black** speech video trips a false-positive
  `nsfw` moderation flag (`status: nsfw`, no output). The helper fills `0x7f7f7f`.
  Treat `nsfw`/`moderated`/`rejected` as **terminal** when polling — a re-roll often
  passes (it's somewhat nondeterministic).
- **Seedance reference caps** (from `higgsfield model get <model>`, model-dependent):
  **2.5** — ≤30 image refs, ≤50 total, no video/audio sub-cap; **2.0** — ≤9 image,
  ≤3 video, ≤3 audio, ≤12 total. Audio refs need at least one image/video/start/end.
  `verify shot` enforces the caps for the model you pass via `--model` (defaults to
  2.0's tighter caps if omitted) — run it before generating.
- **Prompt drift.** If a take drifts from the reference image, suspect prompt length
  first. Confirm the reference was actually sent: `higgsfield generate get <jobId>
  --json` (check `input_images`).
- **No magically appearing props.** A gesture cue that *names an object* (e.g. "a
  casual sip-the-coffee beat") makes Seedance materialize the literal prop in-hand
  mid-shot — and a prop named in the *spoken line* can reinforce it. Keep gesture
  cues object-free (empty-handed motion only: shrug, open-handed gesture, flourish).
  When the line names props, add an explicit guard: hands stay empty the whole shot,
  no cup/mug/objects ever appear even though the line mentions them, nothing is picked
  up or conjured — the character only talks and gestures with empty hands.
- **Don't hand-write the prompt.** Always compose via the worldbuilder / character-loop
  director so the style stack stays consistent across shots.

## Verifying a lip-sync take

```
ffprobe -hide_banner output.mp4                               # has an audio stream
ffmpeg -i output.mp4 -af silencedetect=n=-30dB:d=0.2 -f null - # boundaries vs the wav
```
Speech-silence boundaries should match the source wav within ~1–2 frames.
