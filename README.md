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
Apple Silicon Mac assumed. Work through the steps in order — each one tells you
what to do if it fails.

**Step 1 — Get the code.**

```bash
git clone https://github.com/wilmotli-maker/2d-animation-pipeline.git ~/anim-pipeline
cd ~/anim-pipeline
```

- The repo is **public**, so no GitHub login or token is needed.
- **If `git` isn't installed:** macOS pops up a "command line developer tools"
  dialog the first time you run `git` — click **Install**, wait for it to finish,
  then run the `git clone` again. (Or trigger it yourself first with
  `xcode-select --install`.)

**Step 2 — Run the installer.** It does all the machine setup: installs the
system tools (`node`, `ffmpeg`, `uv`, whisper-cpp via Homebrew), runs
`npm install`, links `pipeline` onto your PATH, and downloads the ~1.3 GB model
weights into `models/`.

```bash
./scripts/install.sh
```

- `install.sh` is **idempotent** — safe to re-run any time. If a step fails, fix
  the cause below and just run it again; it picks up where it left off.
- **If it says "Homebrew not found":** install Homebrew, add it to your PATH, then
  re-run the installer:

  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"   # puts brew on PATH (Apple Silicon)
  ./scripts/install.sh                          # re-run
  ```

- **If `pipeline` isn't found afterward:** open a new terminal (so the freshly
  linked command is on PATH), or use `npm run pipeline -- <...>` in the meantime.
- Flags: `--skip-brew`, `--skip-models`, `--yes` (non-interactive). Run it from
  inside the repo — it locates the workspace from its own path.

**Step 3 — Authenticate** (interactive, so the installer can't do it for you):

```bash
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

> Prefer to set up by hand? `install.sh` just automates the steps above:
> `npm install` (deps + model weights) then `npm link` (puts `pipeline` on your PATH).

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

### A typical session

Work from inside an initialized project so `CLAUDE.md` auto-loads the
**element-author**, **build-element**, and **shot-author** skills. Two ways to
start: `cd` into the project and run `claude` in the terminal, or open **Claude
Desktop**, start a session, and select the project folder as the working folder.
The Desktop app is often nicer here because it renders some generated results
(sheets, shots) inline in the chat as they're produced. A normal end-to-end pass
looks like this — you direct in plain language, Claude authors the prompts and
calls the pipeline, and you judge the output at each gate:

1. **Build a character from references.** Drop one or more reference drawings into
   the character's `inputs/reference-images/` folder, then: *"use element-author to
   make a turnaround for hero from these references."* Claude writes the
   `style-lock.yaml`, composes the prompt, and runs `pipeline element sheet` to
   generate a multi-angle turnaround. Add a few **pose** sheets the same way (chain
   the finished turnaround as an `--image` reference so poses stay on-model).

2. **Check and iterate.** Open the generated `sheets/.../vNNN.png` and judge the
   look against the reference. Not right? Ask for another take — each regeneration
   lands as a new version under the same slug, so you compare and keep iterating
   until the design is locked. (For a whole set of sheets at once, use
   **build-element** instead of element-author.)

3. **Make a talking shot.** Drop a reference voice recording into the project and:
   *"transcribe this wav, then use shot-author to make a shot of hero saying it."*
   Claude runs `pipeline voice transcribe` to get an exact transcript sidecar, then
   `pipeline shot generate` with `--speech-audio <wav>` so the character reproduces
   those exact words and pacing (Seedance lip-sync — see the recipe below). It's
   often worth feeding **reference images** alongside the audio (`--image`) to pin
   down the look: the starting pose — e.g. the three-quarter-front angle from the
   turnaround — and/or specific key poses you want the shot to hit. This keeps the
   character on-model and gives the motion a defined beginning and target.

4. **Review and iterate the shot** the same way: watch the draft, regenerate until
   the delivery and framing are right. Draft cheap at 480p (below).

5. **Compare across a batch.** Once you have several shots, build a review page with
   `pipeline review shots` — a static HTML page (no server) to view versions side by
   side and tick the takes you like. See [Review pages](#review-pages).

6. **Finish for production.** For the keepers, promote the chosen draft, then
   **upscale** it to 1080p+ (`pipeline shot upscale`) and, when you need the
   character on a transparent background for compositing, **matte** it to alpha
   (`pipeline shot matte`). These are the production finals.

Throughout, generation spends real credits — Claude presents the plan and reads the
prompt back for approval before every generation. See [Costs](#costs).

### Using the pipeline directly

An alternative to driving Claude is to call the pipeline yourself from the command
line — useful for scripting, batch runs, or when you already have the prompt in
hand. Claude authors prompts and calls these same commands under the hood. The full
surface:

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
pipeline shot matte     --id <shotId> [--version <n|final>] [--quality fast|best] [--format prores4444|webm|png] [--despill <true|false>] [--input <file>]
pipeline voice transcribe --audio <wav> [--out <file>] | --dir <folder> [--force]
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

### Creating elements

An element is created once, then given one or more **sheets**.
`pipeline element create --type characters --name hero` scaffolds
`elements/characters/hero/` (its inputs, `style-lock.yaml`, and `sheets/`). Render a
sheet with `pipeline element sheet`: pick the `--sheet` kind (`turnaround`, `pose`,
or `cycles`) and an `--id` slug to group its versions — each run saves the next
`vNNN.png`, so re-running iterates. Feed reference art with `--image` (chain a
finished turnaround into pose sheets so they stay on-model). `pipeline verify
element` sanity-checks the inputs and prompt before you spend credits; element art
defaults to Nano Banana. Use `pipeline element upscale` for a hi-res sheet and
`pipeline review images` to compare versions side by side.

### Creating shots

A **shot** is a short clip built from elements. `pipeline shot create --id <shotId>`
scaffolds it; `pipeline shot draft --id <shotId>` opens a new draft version to fill;
`pipeline shot generate --id <shotId> --version <n> --model seedance_2_5 ...` renders
that version, taking image references via `--image` and speech via `--speech-audio`.
`pipeline verify shot` checks a version before generating, and `pipeline shot
promote` marks the draft you picked as the final. Iterate by generating more
versions under the same shot id.

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
- Point `review shots --folder <dir>` at a flat, manually-curated folder of clips
  named `<shotId>-vNNN.ext` (e.g. `episodes/2/shots/candidates/`); shots and versions
  are read from the filenames (a name with no `-vNNN` is a single `v001`). `--match`/
  `--exclude` still apply; `--episode` is ignored.
- Each shot/sheet shows its available versions side by side (or stacked, via
  `--layout`) for quick comparison.
- Re-run with `--update` to refresh a page in place after new generations,
  rather than rebuilding it from scratch.
- Select the takes you like with each version's **select** checkbox; the toolbar's
  **Show only selected** collapses every row to its selected versions (rows with none
  say so). **Download selection** exports a small JSON of the selected shot/versions
  (names only, no media) and **Import selection** restores it; selections also auto-save
  in the browser. All client-side, so it works on a static GitHub Pages host.
- Vendored media referenced by the page lives under `web/<slug>/assets/`,
  which is gitignored — review pages are local artifacts, not committed
  deliverables (only the generated `index.html`/`review.json` are trackable).

## Example

A full pass on the **ArtAI** project: build the `art` character, then author the
`art1` shot of Art delivering a line. Prompt-authoring happens in Claude via the
**element-author** and **shot-author** skills; the pipeline generates and preserves
each result.

**1. Create the Art element and its turnaround.**

```bash
# From the ArtAI project folder (CLAUDE.md auto-loaded):
pipeline element create --type characters --name art
cp ~/Downloads/art-concept.png elements/characters/art/inputs/reference-images/ref.png
```

Then, to Claude: *"use element-author to make a turnaround for art from that
reference."* The skill authors `style-lock.yaml`, composes the detailed prompt (a
real multi-angle turnaround, not a single figure), writes it to
`sheets/turnaround/default/prompt.md`, runs `pipeline verify`, and generates:

```bash
pipeline element sheet --type characters --name art --sheet turnaround --id default --model nano_banana \
  --image elements/characters/art/inputs/reference-images/ref.png
# -> saved v001: elements/characters/art/sheets/turnaround/default/v001.png
```

Check `v001.png`; regenerate for a new version under the same slug until the look is
locked. Add pose sheets the same way, chaining the turnaround as an `--image` so Art
stays on-model.

**2. Author the art1 shot (Art says a line).**

Drop the voice recording into the project, then to Claude: *"transcribe
art1-line.wav, then use shot-author to make art1 — Art saying it, starting
three-quarter front."* Claude transcribes the audio and, pulling the starting pose
from the turnaround, generates a Seedance draft:

```bash
pipeline voice transcribe --audio art1-line.wav           # -> art1-line.wav.txt (exact transcript)
pipeline shot create --id art1 --description "Art delivers the opening line"
pipeline shot draft  --id art1                            # opens draft v001
pipeline shot generate --id art1 --version 1 --model seedance_2_5 --mode omni_reference \
  --resolution 480p --speech-audio art1-line.wav \
  --image elements/characters/art/sheets/turnaround/default/v001.png
# -> saved shots/art1/drafts/v001/
```

Review the draft, regenerate versions until the delivery lands, then finish it —
promote the keeper and upscale the 480p draft to a 1080p production final:

```bash
pipeline shot promote --id art1 --version 1 --output shots/art1/final/art1.mp4
pipeline shot upscale --id art1                           # -> upscaled-1080p.mp4 beside the final
```

Each render keeps its exact prompt in a `vNNN.prompt.md` sidecar, so every version
is reproducible.

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
