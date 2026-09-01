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
npm install                              # installs deps + auto-downloads model weights (~1.3 GB) into models/
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

**Model weights:** `voice transcribe` (whisper.cpp ggml) and `shot matte` (ONNX
mattes — `fast`/isnet and `best`/BiRefNet) need local model files. They are large
(~1.3 GB total) and gitignored, so `npm install` downloads them into `models/` via
a `postinstall` hook. Set `SKIP_MODEL_DOWNLOAD=1` to skip it (e.g. on CI), and run
`npm run fetch-models` later to fetch them on demand — `--only whisper|fast|best`
to limit the set, `--force` to re-fetch. A postinstall download failure won't break
`npm install`; matte/transcribe still print a manual `curl` hint when a file is
missing. Upscaling needs no local model (it runs server-side via Higgsfield). To
reuse models you already have elsewhere (e.g. rembg's `~/.u2net`), point at them
with `MATTE_MODEL_DIR` / `WHISPER_CPP_MODEL` instead.

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
pipeline element upscale --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> [--version <n|latest>] [--model topaz_image|bytedance_image_upscale] [--scale 2|4] [--input <file>]
pipeline image upscale  --input <file> [--model topaz_image|bytedance_image_upscale] [--scale 2|4] [--out <dir>]
pipeline review shots   --slug <name> [--match <re>] [--exclude <re>] [--characters a,b] [--episode N,M] [--layout side-by-side|stacked] [--update] [--out <dir>]
pipeline review images  --slug <name> [--match <re>] [--exclude <re>] [--characters a,b] [--sheets turnaround,pose,cycles] [--update] [--out <dir>]
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

### Review pages

`pipeline review shots` and `pipeline review images` build a self-contained
static HTML page for browsing generated shots or element sheets — open its
`index.html` directly in a browser, no server needed. Pages are written to a
`web/<slug>/` folder off the project root by default (created if missing); pass
`--out <dir>` to write them somewhere else.

- `review shots` covers shot clips (episodic or flat projects); `review
  images` covers element sheets (turnaround/pose/cycles).
- Filters combine as an intersection: e.g. `--characters a,b --episode 2` on
  `review shots` narrows to shots featuring both characters *and* in episode
  2. `--exclude <re>` then drops any id/slug matching a regex (e.g.
  `--match '^art-' --exclude 'candidates|assembled'`).
- Each shot/sheet shows its available versions side by side (or stacked, via
  `--layout`) for quick comparison.
- Re-run with `--update` to refresh a page in place after new generations,
  rather than rebuilding it from scratch.
- Vendored media referenced by the page lives under `web/<slug>/assets/`,
  which is gitignored — review pages are local artifacts, not committed
  deliverables (only the generated `index.html`/`review.json` are trackable).

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
