# Model findings

Durable, decision-relevant findings about the generation models/APIs this pipeline
drives (Seedance, Runway Aleph, WAN VACE, TokenFlow, Higgsfield, Topaz). These are
empirical behaviors observed in spikes — capabilities, limits, quirks, and costs —
kept here so we don't re-derive them each time. Each entry notes the date and, where
relevant, the PR, eval, or script that produced it.

> Conventions: SSIM/PSNR are frame-adherence/similarity metrics (higher = closer; SSIM 1.0 / PSNR ∞ = identical).
> "fal" = fal.ai hosted endpoints; "HF" = Higgsfield; "MuAPI" = direct MuAPI/ModelArk.

---

## Seedance 2.5 (fal)

### Endpoints & input params (from fal OpenAPI, 2026-10-28)
Three distinct endpoints, with **different** capabilities — the choice of endpoint, not
just the prompt, determines what you can constrain:

| capability | `reference-to-video` | `image-to-video` | `text-to-video` |
|---|---|---|---|
| omni refs (`image_urls`/`video_urls`/`audio_urls`, named @Image1/@Video1…) | ✅ | ❌ | ❌ |
| explicit first/last frame (`image_url` + `end_image_url`) | ❌ | ✅ | ❌ |
| `seed` | ✅ | ❌ | ✅ |
| `aspect_ratio` | ✅ (enum) | forced `auto` | ✅ |
| `task` enum | auto/reference/editing/extension | — | — |

- Up to 30 images / 10 videos / 10 audios on reference-to-video (≤50 files total).
- `duration` is a **string**, 4–30s or "auto". `draft: true` forces a 480p preview.
- The pipeline's fal runner (`src/fal.js`) hits **reference-to-video** only.

### Seed is NOT deterministic (2026-10-28)
Two gens with identical seed/prompt/refs on reference-to-video: **SSIM 0.835 / PSNR 19.3 dB**
(identical would be ~0.99+ / 40 dB+). Character, palette, outfit and backdrop stay stable;
framing, pose, hand detail and expression diverge frame-by-frame. Gesture *beats* and rough
timing loosely align, so seed+audio weakly anchors the motion arc — not the pixels. A fixed
seed is a weak control, not a reproducible re-gen. (`--seed` wired in PR #179; spike shot
`bruce-seed-test` in the 3D-Test project.)

### First/last frame: explicit params vs omni-ref prompting (2026-10-28)
Comparing the two ways to constrain the end frames, on shot `ai12-firstlast-ab` (ArtAI ep2,
robot smile→arms-crossed-scowl). **No shared seed is possible** — explicit start/end only
exists on `image-to-video`, which has no `seed` field.

Frame-adherence SSIM (generated endpoint frame vs the supplied frame):

| mode | endpoint | first | last |
|---|---|---|---|
| A — explicit start/end (`image_url`+`end_image_url`) | image-to-video | **0.687** | **0.719** |
| B — omni-ref, plain prompt (`image_urls=[first,last]`) | reference-to-video | 0.577 | 0.637 |
| B — omni-ref, @Image keyframe-pinned prompt | reference-to-video | 0.505 | 0.588 |

- **The main real difference is framing/zoom, not pose/content.** Aside from Mode B
  consistently **zooming in / re-framing**, the two modes are close on pose and image
  adherence — both reach the target pose. This matches earlier informal experiments that
  found "little difference" between the modes.
- Adding the `targeted-edit-author` @Image keyframe language ("STARTS on @Image1 @0.0s …
  reproduce exact full-body framing, subject scale and position") to Mode B did **not** close
  the gap — it zoomed in *more*. **Prompt wording does not override reference-to-video's
  re-framing behavior.** If holding the exact frame/scale matters, use the explicit
  image-to-video endpoint.
- Caveat: single sample per cell; with no seed on image-to-video, gen noise is uncontrolled.
  Mode B's 0.58→0.51 prompt-to-prompt swing is within that noise — don't over-read its
  direction. The A-over-B ordering and the zoom behavior are the robust takeaways.
- Neither mode reproduces a supplied frame pixel-exactly (~0.7 SSIM ceiling even for explicit);
  the model always repaints in its own render.
- Driver: `scripts/spike-firstlast-ab.mjs`; review page `web/ai12-firstlast-ab` in ArtAI ep2.

### Keyframe-pose vs text-described pose (EP2 textpose rolls)
On talking-shot pose edits: a **keyframe pose** (inject a pose still as the middle @Image)
hits the exact pose but lerps/snaps stiffly into/out of it; a **text-described pose** moves
more naturally but **under-shoots** the gesture (e.g. "both arms overhead" → a chest-height
shrug). Neither gets both precision and naturalness at once. 3 keyframes + per-second timing
reliably lands a pose at its timestamp; 5 keyframes do not. (See `targeted-edit-author` skill.)

### Pricing / billing (fal, ~Oct 2026)
- Per-second by resolution: 480p ≈ **$0.206/s**, 720p ≈ **$0.473/s**. A 4s 480p gen ≈ $0.82.
- **Image and audio references are free; reference VIDEOS are billed** — fal sums the input
  video + output durations and multiplies. The "blank speechref video" lip-sync trick therefore
  adds billable seconds; to minimize cost, pass speech as a plain `audio` ref (free) or skip it.
- ⚠️ **A dropped poll never means re-generate.** A network drop on an in-flight job keeps
  billing; resubmitting re-bills (3–6× overspend observed). Persist the `request_id` and
  re-poll it; outputs are recoverable from the fal dashboard. (Fixed PR #170.)

---

## Seedance via MuAPI vs Higgsfield (moderation)
- HF flags the **speech-ref video + >1 image reference** combo as `nsfw` near-deterministically
  (~14/15), regardless of content — it's an HF packaging issue, not the model. @-tags don't
  bypass it; HF `--draft` removed the recipe entirely.
- **Direct MuAPI/ModelArk Seedance 2.5 runs the same combo fine** (bypasses HF moderation).
  The pipeline's `--runner muapi` exists for this; needs MUAPI_KEY + FAL_KEY (local refs are
  uploaded to fal storage since MuAPI takes URLs).

---

## Runway Aleph (v2v)
- Spatially **local** edits with mild global re-draw; good for targeted spatial/global changes.
- Temporal timing needs **keyframes** to land — it won't invent correct timing from prose alone.
  (Live spike 2026-09-07; keyframe-v2v spike.)

## WAN VACE (fal)
- Fixed **81-frame budget**. Pre-resample inputs to **16 fps** or timing drifts and the tail
  gets dropped. (wan-fal-timeline-truncation.)

## TokenFlow (feature-injection v2v)
- **Appearance-only** by construction — cannot do temporal or gesture edits. Only use it for
  spatial/global restyle, never motion changes.

## Topaz upscalers (via HF)
- No cost-estimate API for `topaz_image` (credits come back null; ~2 credits/panel in practice).
- Ledger name "Topaz Image" ≠ the model-list name "Topaz". `topaz_video` / `bytedance_video_upscale`
  for clips; `topaz_image` / `bytedance_image_upscale` for stills.

---

## Cross-cutting

### Harmonizing spliced/illustrated clips
Two-stage **Seedance previs → restyle** beats a single-pass v2v for making spliced illustrated
clips look uniform (removes splice seams). (harmonize-eval.)

### Colour range (gen chain)
The edit/gen chain standardizes on **limited/tv** range. Source clips are untagged; ffmpeg
reads untagged as tv on frame extraction (so PNG extraction needs no range flag), but every
**encode** on the way out must be tagged tv (`RANGE_ARGS` in `src/color-range.js`) or a ~6–10
level gen↔source colour step appears. (PR #178.)
