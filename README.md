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
npm install                              # installs the Higgsfield CLI locally (not globally) + deps
npm run higgsfield -- auth login         # browser OAuth; session persists
npm run higgsfield -- workspace list     # find your workspace id
npm run higgsfield -- workspace set <id> # REQUIRED: selects the billing workspace
npm run check-auth                       # preflight: verifies auth + workspace + Claude access
```

`workspace set` is mandatory — generation fails with "No workspace selected"
until it's run once, even for the default private workspace. For prompt direction
and the critique loop you also need Claude Code (or an `ANTHROPIC_API_KEY`).

**Where data is written:** commands write `elements/` and `shots/` under
`--root <dir>` if given, else `$ANIMATION_PIPELINE_ROOT`, else the current
directory. One install can serve many projects — run it from each project's folder.

## Usage

```
pipeline element create --type <characters|props|scenes|other> --name <name>
pipeline element sheet  --type <t> --name <n> --sheet <turnaround|pose|cycles> --model <m> --prompt <p> [--image <file>]
pipeline shot create    --id <shotId> [--duration <s>] [--mode <m>] [--description <d>]
pipeline shot draft     --id <shotId>
pipeline shot generate  --id <shotId> --version <n> --model <m> --prompt <p> [--image <file>]
pipeline shot promote   --id <shotId> --version <n> --output <file>
```

Run any command via `node bin/pipeline.js <...>` or `npm run pipeline -- <...>`.
All commands accept `--root <dir>`. `--image` feeds a local reference image
(auto-uploaded); the correct flag is model-dependent, so check a model's inputs
with `npm run higgsfield -- model get <model>`. List models with
`npm run higgsfield -- model list` (e.g. `nano_banana` for images,
`seedance_2_0` / `seedance_2_0_mini` for video).

## Example: a character and a shot

```bash
# 1. Create a character element, then generate a turnaround sheet for it.
node bin/pipeline.js element create --type characters --name cecilia
node bin/pipeline.js element sheet \
  --type characters --name cecilia --sheet turnaround \
  --model nano_banana \
  --prompt "flat cartoon character turnaround, front/side/back, plain background"
# -> saved v001: elements/characters/cecilia/sheets/turnaround/v001.png

# 2. Create a shot and open its first low-res draft.
node bin/pipeline.js shot create --id s010_kitchen --duration 6 --mode narrative \
  --description "Cecilia walks into the kitchen"
node bin/pipeline.js shot draft --id s010_kitchen

# 3. Generate the draft's output (low-res model to save credits).
node bin/pipeline.js shot generate --id s010_kitchen --version 1 \
  --model seedance_2_0_mini --prompt "Cecilia walks into a sunlit kitchen"
# -> saved: shots/s010_kitchen/drafts/v001/output.mp4

# 4. Claude reviews the draft against style-lock.yaml. If it drifts, note it in
#    the draft's notes.md, open a new draft (shot draft ...), and regenerate.
#    When a draft is good, promote it to final:
node bin/pipeline.js shot promote --id s010_kitchen --version 1 \
  --output shots/s010_kitchen/drafts/v001/output.mp4
# -> promoted to final: shots/s010_kitchen/final/output.mp4
```

Upscaling `final/` to production resolution is a separate step (not yet a built
command) — iterate and promote at low resolution first, then upscale the locked shot.

## Costs

Generation draws credits from your own Higgsfield account. The authoritative
record of spend is `npm run higgsfield -- account transactions` (the balance
field is cached and lags). Observed: **image ≈ 2 credits, video ≈ 22.5 credits** —
hence low-res iteration and a single final upscale.

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
