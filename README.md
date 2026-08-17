# 2d-animation-pipeline

A local, scriptable pipeline for producing 2D animation with [Higgsfield](https://higgsfield.ai)
image/video models. You build reusable **elements** (characters, props, scenes),
then assemble short **shots** from them — iterating cheaply at low resolution
before committing to a final. Claude (via Claude Code) directs prompts and
reviews output; generation runs through the official Higgsfield CLI, not the web UI.

This repository is **infrastructure**. Your actual project data — elements,
shots, style-locks, and generated media — is *your* data: it's written to disk
(under the current directory by default) and is gitignored, never committed here.

## Concepts

- **Element** — a persistent story asset: a `character`, `prop`, `scene`, or
  `other`. Each lives at `elements/<type>/<name>/` with its creation inputs, a
  `style-lock.yaml` (the locked look — palette, line weight, wardrobe, etc.),
  versioned `sheets/` (turnaround / pose / cycles), and an append-only
  `generations.jsonl` log. See [docs/style-lock-schema.md](docs/style-lock-schema.md).
- **Shot** — a 2–10s clip built from elements, at `shots/<shotId>/`. You iterate
  low-resolution `drafts/vNNN/`, then promote the chosen draft to `final/`.
  Iterate cheap, finalize once (a video costs ~10× an image — see Costs below).
- **Interactive critique** — after each draft, Claude reviews the output against
  the element's `style-lock.yaml` and decides accept or regenerate. That judgment
  is a human/Claude-in-the-loop step in Claude Code, not an automated script.

## Setup

Each user runs everything under their own accounts; no credentials are shared.

```bash
npm install                              # installs the Higgsfield CLI locally + deps
npm link                                 # one-time: put `pipeline` on your PATH (symlinks the bin)
npm run higgsfield -- auth login         # browser OAuth; session persists
npm run higgsfield -- workspace list     # find your workspace id
npm run higgsfield -- workspace set <id> # REQUIRED: selects the billing workspace
npm run check-auth                       # preflight: auth + workspace + Claude access

pipeline init ~/anim/my-project          # scaffold a project folder (CLAUDE.md + skill)
cd ~/anim/my-project                      # run Claude Code from here so CLAUDE.md auto-loads
```

`workspace set` is mandatory — generation fails with "No workspace selected"
until it's run once, even for the default private workspace. For prompt direction
and the critique loop you also need Claude Code (or an `ANTHROPIC_API_KEY`).

**Where data is written:** commands write `elements/` and `shots/` under
`--root <dir>` if given, else `$ANIMATION_PIPELINE_ROOT`, else the current
directory. One install can serve many projects — run it from each project's folder.

## Usage

```
pipeline init <dir>
pipeline sync-skills    [--root <dir>]   # refresh a project's .claude/skills/ after the tool updates
pipeline element create --type <characters|props|scenes|other> --name <name>
pipeline element sheet  --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> --model <m> [--prompt-file <f> | --prompt <p>] [--image <file> ...]
pipeline verify element --type <t> --name <n> --sheet <s> --id <slug> [--image <file> ...]
pipeline shot create    --id <shotId> [--duration <s>] [--mode <m>] [--description <d>]
pipeline shot draft     --id <shotId>
pipeline shot generate  --id <shotId> --version <n> --model <m> [--prompt-file <f> | --prompt <p>] [--image <file> ...] [--speech-audio <wav>] [--video <file> ...] [--audio <file> ...] [--resolution <r>] [--duration <s>] [--aspect-ratio <a>] [--generate-audio <true|false>] [--mode <m>]
pipeline verify shot    --id <shotId> --version <n> [--model <m>]
pipeline shot promote   --id <shotId> --version <n> --output <file>
pipeline shot upscale   --id <shotId> [--version <n|final>] [--model topaz_video|bytedance_video_upscale] [--resolution <r>] [--aspect-ratio <a>] [--input <file>]
```

Run any command via `node bin/pipeline.js <...>` or `npm run pipeline -- <...>`.
All commands accept `--root <dir>`. `--image` feeds a local reference image
(auto-uploaded); the correct flag is model-dependent, so check a model's inputs
with `npm run higgsfield -- model get <model>`. List models with
`npm run higgsfield -- model list` (e.g. `nano_banana` for images,
`seedance_2_5` / `seedance_2_0` for video).

For talking-character (Seedance) shots, pass the speech recording via
`--speech-audio <wav>`: the pipeline wraps it into a blank mid-gray video and
sends it as a video reference, which reproduces the recording's exact words and
pacing. Needs `ffmpeg` on `PATH`. See
[docs/recipes/seedance-lipsync.md](docs/recipes/seedance-lipsync.md).

**Seedance 2.5** is the recommended video model. Unlike 2.0 it needs
`--mode omni_reference` whenever you pass any reference (its default `t2v`
rejects reference media), and it has no `genre` knob. It caps at 720p — but its
720p carries little more real detail than its 480p, so the cheapest path to a
crisp final is to **draft and finish at 480p, then upscale** (below) rather than
generate at 720p.

### Draft at 480p, finish with an upscale

`pipeline shot upscale` enlarges a finalized clip to 1080p or higher via a
dedicated upscaler, so generation only ever pays for 480p:

```bash
pipeline shot upscale --id mayor-mono-03            # promoted final -> upscaled-1080p.mp4 beside it
pipeline shot upscale --id mayor-mono-03 --version 3 --resolution 2160p
```

`topaz_video` (the default) preserves line weight and paper texture on flat
2D art; `bytedance_video_upscale` is cheaper but smooths fine detail. The result
lands next to the source as `upscaled-<res>.mp4` with a JSON sidecar recording
how it was made. Needs `ffmpeg` on `PATH`.

## Example

The prompt-authoring happens in Claude Code via the **element-author** skill; the pipeline generates and preserves the result.

```bash
# From your project folder (CLAUDE.md auto-loaded):
pipeline element create --type characters --name cecilia
cp ~/Downloads/cecilia-drawing.png elements/characters/cecilia/inputs/reference-images/ref.png
```

Then, in Claude Code: *"use element-author to make a turnaround for cecilia from that reference."* The skill authors `style-lock.yaml`, composes the detailed prompt (a real multi-angle turnaround, not a single figure), writes it to `sheets/turnaround/<slug>/prompt.md`, runs `pipeline verify`, and then:

```bash
pipeline element sheet --type characters --name cecilia --sheet turnaround --id default --model nano_banana \
  --image elements/characters/cecilia/inputs/reference-images/ref.png
# -> saved v001: .../sheets/turnaround/default/v001.png
```

Iterate (new version under the same slug) or start another instance (`--id summer-outfit`). Chain a finished sheet as an `--image` reference for pose sheets. Each render keeps its exact prompt in `vNNN.prompt.md`.

## Costs

Generation draws credits from your own Higgsfield account. The authoritative
record of spend is `npm run higgsfield -- account transactions` (the balance
field is cached and lags; it also only returns a recent window, so trust
per-job charges over any running total it reports).

Measured video rates (per second of output, 2026-08):

| model / path | rate | notes |
|---|---|---|
| Seedance 2.0 @ 720p | 4.5 cr/s | flat, no per-job overhead |
| Seedance 2.5 @ 720p | ~4.0 cr/s | ~11% cheaper than 2.0 |
| **Seedance 2.5 @ 480p** | **2.0 cr/s** | half the 720p rate |
| Topaz upscale → 1080p | ~2.3 cr + 0.18/s | e.g. 4s ≈ 3 cr, 15s ≈ 5 cr; `high` bitrate is free |
| Bytedance upscale → 1080p | ~0.8 cr / 4s | cheaper, softer result |

Images are near-free by comparison (Nano Banana Pro ≈ 2 cr, Flux Kontext ≈ 1.5).

**Draft at 480p, upscale the final.** For a 44s set of shots, generating at 480p
and finishing with Topaz costs roughly half of generating at 720p natively — and
delivers 1080p instead. Video dominates the bill, so this is the single biggest
lever on cost.

## Development

```bash
npm test        # runs the unit suite (node --test); no credits, no network
```

The pipeline is layered: a thin wrapper over the Higgsfield CLI (`src/cli.js`),
an async submit-all/poll-all batch engine (`src/batch.js`, exploiting the
parallel backend), download + credit parsing, and high-level generate ops wired
to the element/shot layout. Design notes and the verified CLI behavior live in
[animation-automation-handoff.md](animation-automation-handoff.md); implementation
plans are under [docs/superpowers/plans/](docs/superpowers/plans/).
