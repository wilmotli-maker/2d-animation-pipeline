---
name: seedance-stitch
description: Stitch two AI video clips (Seedance, Wan, Kling, Veo…) that are meant to join into one continuous shot but don't quite line up — finds the best hand-off frames, generates a short start+end-frame BRIDGE clip through the pipeline's Seedance runner, fits it (trim, retime, colour-match, optical-flow morph at each join), assembles the one-er and QAs the joins. Use whenever the user hands over two clips and asks to stitch, bridge, join, blend, "make these one shot", "fill the gap", "the end frame and start frame don't match", "make a transition between these", or wants a oner built from separate generations.
---

# Seedance stitch

The artist hands over clip A and clip B. The goal is **one seamless continuous shot**: A → bridge → B, with no visible jump, same camera move carried through, same light, same faces. Report in plain language.

> **Origin & adaptation.** This skill is by **Jordie Shapiro** (7 Oct 2026). Jordie's
> original generated the bridge clip through the **Magnific connector**. This copy is adapted
> for the **2d-animation-pipeline**: the bridge is generated through the pipeline's existing
> **MuAPI Seedance 2.5 runner** (`pipeline shot generate --runner muapi --mode first_last_frame`)
> instead, so there is one Seedance path and one credit ledger. The measuring/fitting/QA script
> (`stitch.py`) and the WaveSpeed VACE joiner (`vace_join.py`) are Jordie's, unchanged.

Script: `templates/skills/seedance-stitch/scripts/stitch.py` (Python 3 + OpenCV + ffmpeg). It
does all the measuring, trimming, fitting and QA. The bridge generation is done by you through
the pipeline's Seedance runner — see step 2.

## House rules that apply here
- Video generation is **480p** and only on the artist's go. Handing over two clips and asking for a stitch **is** the go for ONE bridge generation (plus at most one retry). Say the cost before a second retry.
- The bridge is a normal paid Seedance generation, billed per second of the **bridge clip** by the
  pipeline's credit layer (MuAPI USD, `estimateCost` = duration × per-second rate: 480p ≈ $0.17/s,
  720p ≈ $0.34/s). A 4 s 480p bridge ≈ $0.68. Shortest duration the model allows (Seedance: 4 s).
- Always try the **free, non-generative** options first (step 1a/1b) — they spend nothing.
- Work in a scratch dir the artist can find, e.g. `evaluation/stitches/<YYMMDD>_<A-name>__<B-name>/` (JOBDIR).
- Prompts you show the artist go in a fenced text block.

## Workflow

### 1. Prep (free — no generation)
```
python3 templates/skills/seedance-stitch/scripts/stitch.py prep A.mp4 B.mp4 --out JOBDIR
```
Then READ `JOBDIR/prep_sheet.jpg` (A's exit frame | B's entry frame | difference map) and `plan.json`. It tells you:
- which frames to hand off on (it skips soft/smeared end frames and searches ~1.5 s into each clip for the closest pair — trimming a few frames is normal and good),
- `mismatch_vs_typical` — how big the jump is compared with a normal frame-to-frame change in A,
- the camera motion leaving A and entering B, in words,
- the lightness change,
- a `recommendation`:

| recommendation | meaning | do |
| --- | --- | --- |
| `cut` | already nearly continuous (< ~2.5× a normal frame change) | skip generation: `assemble JOBDIR --direct --morph 6`. Free. |
| `bridge` | the normal case | FIRST try the free digital push-in: `assemble JOBDIR --reframe 1.5 --morph 10` (no generation — see below). Only if that ghosts or can't match, generate a start+end-frame bridge (step 2) |
| `hide` | too different for the model to morph believably (different framing, a person in a different place, big lighting change) | bridge with a **seam-hiding move** (step 2, variant) — or tell the artist the two clips don't really meet and suggest regenerating B from A's last frame instead |

Check the sheet yourself: the script measures pixels, you judge story. If the hand-off frames are wrong for the action (e.g. mid-blink, a hand half out of frame), rerun prep with a different `--search`, or pick frames by eye and overwrite `A_out.png` / `B_in.png` and the cut numbers in `plan.json`.

### 1a. PREFERRED (tested 22 Sep 2026, the best result so far) — push-in + WaveSpeed VACE joiner
`python3 scripts/vace_join.py A.mp4 B.mp4 --pushin 1.7 --out JOBDIR/vace/joined.mp4` (~$0.20 cash, ~4 min), then conform to 23.976/1080 with ffmpeg and QA. Use `--pushin` whenever A and B are framed differently; leave it off if they already match. Fall back to the options below only if this fails.

> **Key note for this pipeline.** The VACE joiner (`vace_join.py`) still talks to **WaveSpeed**
> (`~/.wavespeed/key`, ~$0.20/join in WaveSpeed cash). fal has **no drop-in joiner endpoint** —
> fal hosts only the raw `fal-ai/wan-vace-14b` v2v/inpainting model, so your existing `FAL_KEY`
> cannot replace WaveSpeed here without reimplementing the joiner workflow (A-tail → gray gap →
> B-head + mask, inpaint the gap) over that endpoint, which inherits fal Wan VACE's fixed
> 81-frame @16fps budget. That reimplementation is a documented follow-up (see README), not wired
> yet. Until then: if you don't have a WaveSpeed key, skip step 1a and use the free push-in (1b)
> then the Seedance bridge (step 2). The key is read from `WAVESPEED_API_KEY` (pipeline `.env` or
> shell) first, then `~/.wavespeed/key`.

### 1b. Free option — digital push-in (`--reframe`)
Matches features between A's last frame and B's first (SIFT + RANSAC), works out the exact zoom/shift/rotation from A's framing to B's, and eases that move over A's last N seconds of REAL footage (the subject keeps moving — no freeze frame), then optical-flow-morphs into B. Nothing is regenerated, so faces, cloth and texture can't drift; costs nothing. Tested 22 Sep on the church Start→End pair: 1.7× push, 125 matched points, join clean — preferred over the Seedance bridge.
Breaks when: the camera HEIGHT/angle changed a lot (parallax — near and far things move differently, which a flat 2D move can't fake → ghosting in the morph), or the push is so big (>~2×) that A goes too soft. Then use the bridge, or run a VACE joiner over just the seam frames (WaveSpeed "VACE Video Joiner" ~$0.20/join, cash not credits).
Tips: `--reframe` 1–2 s; longer = gentler push. `--morph 8–12`. Land the join on the subject's own motion (a head turn, the start of a smile) so any residual blend is hidden.

### 2. Generate the bridge (through the pipeline's Seedance runner)
Jordie's version uploaded the two keyframes to Magnific and called `video_generate` with
`keyframes.start`/`keyframes.end`. In this pipeline the **same first/last-frame generation** is a
single `pipeline shot generate` call on the MuAPI runner — the `first_last_frame` mode routes to
Seedance 2.5's `first-last-frame` endpoint with `images_list: [A_out, B_in]`:

1. Prep already wrote `JOBDIR/A_out.png` (A's exit keyframe) and `JOBDIR/B_in.png` (B's entry keyframe).
2. Write the bridge prompt (below) to `JOBDIR/bridge_prompt.txt`.
3. Create a scratch shot and generate the bridge. The **first `--image` is the start frame, the
   second is the end frame** (order is preserved into `images_list`):
   ```
   pipeline shot create --id stitch-bridge --root JOBDIR
   pipeline shot generate --id stitch-bridge --version 1 --model seedance_2_5 \
     --runner muapi --mode first_last_frame \
     --image JOBDIR/A_out.png --image JOBDIR/B_in.png \
     --prompt-file JOBDIR/bridge_prompt.txt \
     --resolution 480p --duration 4 --aspect-ratio <A's ratio> --generate-audio false \
     --root JOBDIR
   ```
   Model: use `seedance_2_5` (the pipeline's Seedance). Shortest duration (4 s). 480p. Spicy
   route only if the material needs it (`--spicy`, relaxed moderation) — same flag as everywhere else.
4. Copy the finished draft output to `JOBDIR/bridge.mp4`, then assemble (step 3).

**Bridge prompt** — describe only the MOVEMENT between the frames, never re-describe the scene (the frames carry the look). Put the continuity rules first:
```text
ONE CONTINUOUS SHOT — NO CUT, NO DISSOLVE, NO SCENE CHANGE. The clip begins exactly on the first frame and ends exactly on the last frame.
Camera: continues the move it is already making — <motion_A_text from plan.json> — at the same speed, and eases into <motion_B_text> by the end.
Action: <the one physical thing that has to happen between the two frames, in one smooth motion — e.g. "he lowers his arm and turns his head to the right">.
Everything else stays identical: same faces, same costume and props, same lighting, same colour, same film grain. Nothing new enters the frame. No text.
```
**Seam-hiding variant** (for `hide`): same header, then give the model somewhere to hide the change —
- *foreground wipe*: "a dark figure / post / branch passes close across the lens, filling the frame for a moment",
- *whip*: "a fast whip-pan blur to the right" (only if A or B is already moving that way),
- *push through dark*: "the camera pushes in through a patch of deep shadow",
- *two-step*: generate A→midpoint and midpoint→B (make the midpoint still from both frames).

### 3. Assemble + QA
```
python3 templates/skills/seedance-stitch/scripts/stitch.py assemble JOBDIR --bridge JOBDIR/bridge.mp4 --morph 8
```
It finds where the generated bridge actually meets A and B (models rarely land on the exact first/last frame), trims the duplicates, **retimes the bridge so it moves at A's speed** (a bridge that is too slow or too fast is the most common giveaway), colour-matches it from A's grade to B's, and joins with an 8-frame optical-flow **morph** at each seam (warps geometry across the join instead of a ghosty cross-fade). Add `--keep-audio` to carry A's and B's sound (silence across the bridge). `--dissolve 2` without `--morph` for a plain short dissolve.

Then READ `JOBDIR/join_strips.jpg` (4 frames either side of each join) and `qa.json`. Verdicts: `clean` (< 2× a normal frame change) · `soft bump` · `VISIBLE JUMP`. Look for: faces changing across the bridge, props appearing/disappearing, the camera stalling or lurching, a hidden cut inside the bridge, colour pumping.

### 4. If it isn't clean
In order, cheapest first:
1. `soft bump` → re-assemble with a longer morph (`--morph 10–12`). Free.
2. Bridge has a cut inside it / faces drift / wrong action → ONE regenerate with the prompt tightened (name the action more concretely, add "the same person throughout", shorten if the model allows). Tell the artist the cost first if it's a second retry.
3. Still jumping → the two clips genuinely don't meet: switch to the seam-hiding variant, or recommend regenerating B with A's exit frame as B's start frame.
Never spend past two bridge generations without asking.

### 5. Deliver
- Final: `JOBDIR/stitched.mp4` — copy it to the project with a clear name.
- Report to the artist in plain words: where it cuts from A and into B (and how many frames were trimmed and why), what the bridge does, the QA verdict per join, what it cost, and anything he should eyeball (e.g. "watch his hand at 0:04.6").

## Notes / known limits
- **WaveSpeed VACE joiner (wired 22 Sep, cash not credits, ~$0.20/join):** `python3 scripts/vace_join.py A.mp4 B.mp4 --out JOBDIR/vace/joined.mp4` (add `--dry-run` for the price only). Key lives in `~/.wavespeed/key`; the artist tops up the account. Try it when the free push-in ghosts, before spending Seedance credits on a bridge. Then QA the result like any other one-er. First test 22 Sep (church Start→END_2): output came back 1920×1072 at 32 fps (conform to 23.976/1080 with ffmpeg), and the seam was a very fast ~0.2 s snap push-in, faster than the free `--reframe` ease. It suits clips where a quick move reads as intentional; for slow, gentle moves the free push-in looked calmer. **Fix (v7, 22 Sep): add `--pushin 1.7`** — the script first digitally pushes A's tail onto B's framing, then the joiner only blends the leftover gap. Result: a smooth ~1 s push, no snap. Default to `--pushin` whenever A and B are framed differently.
- **fal joiner (not wired).** fal's `FAL_KEY` (already used by this pipeline for uploads and Wan VACE) cannot stand in for WaveSpeed's one-call joiner — fal has no turnkey joiner; you'd reimplement the gap-inpaint workflow over `fal-ai/wan-vace-14b/inpainting`, constrained to 81 frames @16fps. Tracked as a follow-up in the README.
- A two-frame bridge knows the start and end pictures but not the motion around them — that is why the script retimes to A's speed and morphs the seams. For long or fast camera moves, a context-aware joiner (Wan VACE Video Joiner — ComfyUI `stuttlepress/ComfyUI-Wan-VACE-Video-Joiner`, or WaveSpeedAI's hosted version) reads several frames either side and can do better.
- Seedance 2.5's first/last-frame mode **is** the "two-clip transition" capability this skill now calls directly via the MuAPI runner (`--mode first_last_frame`). Spicy/intl variants ride the same `--spicy` flag.
- Resolution: A, B and the bridge are normalised to the smaller of A/B and A's frame rate. If A/B are 720p+ and the bridge is 480p, the bridge will be softer — say so; upres the finished one-er with `pipeline shot upscale` afterwards if needed.
- Tiny mismatches (a few pixels of drift) often need no bridge at all — `--direct --morph 6` is a real morph cut.
