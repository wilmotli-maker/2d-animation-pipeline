// Two-stage previz → restyle harmonization for a whole video.
//
// A spliced clip shows a seam where a generated window meets the source (a colour
// step + background mottling). Regenerating the whole clip in one continuous Seedance
// pass removes the seam by construction. We do it in two stages so the restyle lands
// uniformly:
//   1. previz  — re-render the clip as a smooth, untextured greyscale 3D maquette,
//                stripping all colour/texture but keeping silhouette, expression,
//                motion and framing. Collapses any per-region mismatch to one look.
//   2. restyle — repaint that neutral previz from appearance-reference frames, so the
//                finished look lands identically across the whole clip.
// Both stages are Seedance 2.5 `video_edit`. See the `previz-blocking` skill and
// docs/superpowers/specs/2026-10-20-harmonization-pipeline-design.md.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { runBatch as defaultRunBatch } from './batch.js';
import { downloadTo as defaultDownloadTo } from './download.js';
import { padFrame as defaultPadFrame } from './edit-ui/pad-frame.js';
import { alignFraming as defaultAlignFraming, sampleCornerHex } from './edit-ui/splice.js';
import { RANGE_ARGS } from './color-range.js';
import { styleDirective } from './prompt-style.js';

export const HARMONIZE_MODEL = 'seedance_2_5';
export const HARMONIZE_DEFAULT_RESOLUTION = '480p';

// Canonical prompts — the single source of truth. The harmonize-eval spike's
// prompts.mjs re-exports these; the previz-blocking skill keeps a verbatim copy.
export const PREVIS_PROMPT =
  `Re-render the exact character in this video as a smooth, untextured GREYSCALE 3D RENDER — a clean matte digital maquette of THIS specific character, like an untextured CG model lit with soft global illumination. SHAPE — keep the character's silhouette, proportions and body-part shapes from the source: the same head shape and size, the same body, torso, limbs, hands and feet, the glasses, the hair volume and shape, the apron shape and every distinctive feature it has (antennae, snout, muzzle, tail, ears, horns, spikes, fins, wings, extra or non-human limbs, block feet, etc.). You MAY slightly simplify and smooth the forms into clean, idealised geometry, but do NOT change overall proportions, do NOT humanise or regularise it, do NOT replace it with a generic humanoid figure or a wooden posing mannequin, and do NOT alter the pose. FACE & EXPRESSION — KEEP the character's facial features and current expression on every frame: eyes, eyebrows, the mouth (or beak / muzzle), nose, and any visible teeth or tongue must stay, modelled as smooth raised or recessed relief so the expression reads clearly — never leave a blank, smooth-over or featureless face, and do not drop the mouth. MATERIAL — the ENTIRE character (body, head, face, hair, fur, skin, eyes, glasses, clothing and every accessory) becomes ONE uniform smooth matte mid-grey surface. Strip ALL colour, line art, outlines, markings, patterns, logos, printed text and surface texture that came from the source: absolutely no colour survives anywhere — no coloured hair or fur, no coloured eyes, no coloured glasses lenses or frames, no wood tone, no tints from the source — every part is the same neutral grey. The surface must be SMOOTH and TEXTURELESS, shown through soft, even, gentle shading and subtle highlights like a clean untextured 3D render or smooth modelling clay — NOT rough, NOT bumpy, NOT grainy, NOT painterly, NOT hand-drawn, and NOT 2D artwork. BACKGROUND: a completely empty, featureless flat matte grey void — no environment, floor, set, walls, props or scenery of any kind; nothing but the single grey character on seamless grey. FRAMING: keep the source's exact camera framing and character scale — the whole character stays in frame from top to bottom in the same position and with the same margins as the source; never crop, zoom, pan or reframe. Preserve the body motion, performance timing, pose and gesture exactly. The result must read as a smooth, untextured greyscale 3D render of this character — never finished or coloured 2D artwork, and never a generic dummy.`;

// Restyle STYLE CLAUSE — the one place render style is driven, shared by the filter and previz
// restyle prompts. Style-lock-aware and MEDIUM-NEUTRAL: with a lock it injects it verbatim; without
// one it defers render style entirely to the appearance references and forbids imposing a look the
// references do not show. This is the sibling of buildTrimPrompt's design block (both go through
// styleDirective) — previously this path hardcoded "hand-drawn 2D cartoon", which overrode a
// 3D-rendered character's own style lock and repainted it as flat 2D.
export function restyleStyleClause(styleLock = '') {
  return styleDirective(styleLock, {
    locked: (lock) => `matching the reference images' character design, colour palette, line and edge ` +
      `treatment, shading, lighting, surface finish and overall rendering — in this exact style: ${lock} — ` +
      `and restoring full colour and a finished render on every frame.`,
    generic: `matching the reference images' character design, colour palette, line and edge treatment, ` +
      `shading, lighting, surface finish and overall rendering, and restoring full colour and a finished ` +
      `render on every frame. Do NOT impose any look the reference images do not show — no flat 2D, ` +
      `cel-shading, ink outlines, hand-drawn or painterly treatment unless the references are themselves ` +
      `in that style, and do not force a 3D or photoreal look onto 2D references.`,
  });
}

// Previz-path restyle prompt (repaints the grey maquette). Style-lock-aware via restyleStyleClause.
export function previzStylePrompt(styleLock = '') {
  return 'Repaint this grey placeholder previs animation as a finished, fully-rendered character, ' +
    restyleStyleClause(styleLock) + ' Keep the body motion, pose, gesture and timing from the video ' +
    'completely unchanged. Apply the reference look identically on every frame so the whole clip reads ' +
    'as one continuous, uniformly-styled shot. FRAMING: the video is the camera. Copy its framing ' +
    'exactly — the same character scale, the same position and the same margins, including the top of ' +
    'the head and the feet. Do not zoom, do not scale the character up or down, do not pan or reframe. ' +
    'Keep the background the same plain flat colour as the reference image; add no scenery, props or set.';
}
// Backward-compatible constant: the no-lock (generic) previz restyle prompt.
export const STYLE_PROMPT = previzStylePrompt('');

// Restyle prompt for the FILTER guidance path (default). Style-lock-aware via restyleStyleClause.
// @Video1 is the camera: a prompt that asked for a "generous margin" or to match the reference
// stills' crop did not stop the model zooming. The guidance clip and the stills are padded or
// border-anchored before this prompt runs, so copying @Video1's framing copies that frame.
export function filterStylePrompt(styleLock = '') {
  return '@Video1 is a desaturated, softened black-and-white guidance pass of the animation — take ONLY ' +
    'its motion, pose, gesture, timing, composition and framing from it; ignore its greyscale and its ' +
    'blur. @Image1 and @Image2 are the appearance references: repaint the character in their EXACT ' +
    'style, ' + restyleStyleClause(styleLock) + ' The reference images control appearance only and must ' +
    'not change the crop or the character\'s size. Keep @Video1\'s body motion, pose, gesture and timing ' +
    'completely unchanged and apply the reference look identically on every frame so the whole clip reads ' +
    'as one continuous, uniformly-styled shot in the references\' own style. FRAMING — CRITICAL: @Video1 ' +
    'is the camera. Copy its framing exactly on every frame — the same character scale, the same ' +
    'position, the same headroom and the same empty margins on all sides. Do NOT zoom in or out, do NOT ' +
    'scale the character larger or smaller, do NOT pan, tilt or reframe, and do NOT let the character ' +
    'drift toward or away from the camera. Keep every body part that is inside @Video1\'s frame inside ' +
    'the frame, including the feet and anything that reaches the top of the head. Background: the same ' +
    'plain flat colour as the reference image; add no scenery, props or set.';
}
// Backward-compatible constant: the no-lock (generic) filter restyle prompt.
export const FILTER_STYLE_PROMPT = filterStylePrompt('');

// Restyle prompt for the PASSTHROUGH guidance path (composite a plain-bg character clip into a
// scene). Unlike the filter/previz prompts, @Video1 is the FULL-COLOUR source — the model keeps
// the character's existing colours and only adapts lighting to the scene — and the reference is a
// finished composite still that defines the target frame (scene + character placement + grounding),
// so this prompt ASKS for scenery instead of forbidding it. Style-lock-aware via restyleStyleClause
// only when a lock is supplied (otherwise appearance comes from @Video1 + the reference).
export function compositeScenePrompt(styleLock = '') {
  const styleClause = styleLock
    ? ` Render the character in this exact style: ${styleLock}.`
    : '';
  return '@Video1 is the source animation in full colour. Take from it the CHARACTER\'s performance — ' +
    'his full body motion, pose, gesture and timing on every frame — together with his scale, position ' +
    'and framing within the shot, AND his existing colours, materials and design as the basis for his ' +
    'appearance. IGNORE @Video1\'s background entirely: its plain flat backdrop is a placeholder, not ' +
    'part of the scene — do NOT reproduce any of it. @Image1 is the TARGET STILL: it shows exactly the ' +
    'look the output must match — the desired background scene AND the desired composition of the ' +
    'character within it (placement, scale, integration, lighting and grounding). Reproduce @Image1\'s ' +
    'environment faithfully behind the character on every frame (the same setting, scenery, colours, ' +
    'depth and lighting, held steady and consistent), and render the character to sit in it exactly as ' +
    'in @Image1.' + styleClause + ' @Image1 defines the finished frame; @Video1 only drives how the ' +
    'character moves within it. COMPOSITE THE CHARACTER INTO THE SCENE so he looks really present, not ' +
    'a cutout: LIGHTING — relight him from the scene\'s key light as in @Image1 (the same direction, ' +
    'colour temperature, intensity and ambient fill) on every frame as he moves, keeping his underlying ' +
    'colours recognisable; SHADOWS — keep a believable contact shadow and cast shadow consistent with ' +
    '@Image1\'s light direction and softness (they may shift naturally with his motion, but he must ' +
    'always stay grounded, never floating or pasted-in); GRADE — match @Image1\'s overall exposure, ' +
    'colour grade, atmosphere and depth of field, with clean natural edges (no halo, no hard cutout ' +
    'fringe), so character and background read as one image throughout. FRAMING — CRITICAL: @Video1 is ' +
    'the camera. Copy its framing exactly on every frame — the same character scale, position, headroom ' +
    'and margins. Do NOT zoom in or out, scale the character, pan, tilt or reframe, and do NOT let him ' +
    'drift toward or away from the camera. Keep every body part that is inside @Video1\'s frame inside ' +
    'the frame, including the feet and the top of the head. The background scene from @Image1 stays ' +
    'locked behind him at a constant scale and position throughout.';
}
// Backward-compatible constant: the no-lock (generic) composite-scene restyle prompt.
export const COMPOSITE_SCENE_PROMPT = compositeScenePrompt('');

// Frame-anchor border whitelist clause, appended to the restyle prompt when spec.border draws a
// border on the guidance+stills (see harmonizeVideo). Without it the prompt's "add no scenery" wins
// and the model strips the border instead of treating it as a fixed frame to preserve.
export const BORDER_PROMPT_CLAUSE =
  'FRAME BORDER: there is a solid, flat, high-contrast rectangular border running around all four ' +
  'edges of the picture. Reproduce this border EXACTLY — the same colour, thickness and position on ' +
  'every single frame, as a crisp hard-edged rectangular frame flush to the picture edges. This border ' +
  'is a FIXED FRAME, not scenery or a prop: do NOT remove it, do NOT treat it as background to clear, ' +
  'do NOT restyle, recolour, thicken, thin, round, fade or move it, and never let the character cross ' +
  'in front of or behind it. Keep the whole character inside this border at the same scale and position ' +
  'as in @Video1.';

export const HARMONIZE_PAD_MARGIN = 0.12; // fraction of width/height added on each side before the restyle

// Shrink the picture to (1-2*margin) and pad back to the original size with `fill`. Even inner
// dimensions so the yuv420 encode is legal. 560×752 at 0.12 → scale=426:572, pad back to 560:752.
export function padVideoFilter(width, height, margin, fill) {
  const m = Math.max(0, Math.min(0.4, Number(margin) || 0));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const sw = even(width * (1 - 2 * m));
  const sh = even(height * (1 - 2 * m));
  return `scale=${sw}:${sh},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${fill}`;
}

export const HARMONIZE_DEFAULT_GUIDANCE = 'filter'; // 'filter' (non-generative b+w+blur) | 'previz' (generated grey maquette)
export const HARMONIZE_DEFAULT_BLUR = 1.2;          // gaussian sigma for the filter guidance

// Chroma-match bounds. The restyle drives off a desaturated guidance pass, so its colour comes
// out a touch washed vs the source. A single global saturation gain lifts it back. Guard rails:
// skip when the gain is within the deadband of 1 (no visible change, avoids a needless re-encode)
// and clamp so a degenerate measurement (near-grey restyle, a grey source span) cannot blow up.
export const CHROMA_GAIN_MIN = 0.5;
export const CHROMA_GAIN_MAX = 2.0;
export const CHROMA_GAIN_DEADBAND = 0.03;
// Below this average saturation the clip is effectively greyscale; a ratio off it is unreliable.
const CHROMA_MIN_SAT = 0.5;

// Luma-match bounds. Unlike chroma (a uniform wash), the restyle's brightness error is NOT global:
// measured on v013, the CHARACTER luma already matches the source and only the flat BACKGROUND is
// too bright, so a naive mean offset would darken the already-correct character. Instead fit a
// robust linear map y=a*val+b that lands the restyle's YLOW/YHIGH (signalstats' low/high luma, a
// percentile spread that ignores outliers) onto the source's — this corrects the tonal range
// (pulling the bright backdrop down) while barely moving the midtone character. Clamp the slope and
// treat a near-identity map as a no-op.
export const LUMA_SLOPE_MIN = 0.5;
export const LUMA_SLOPE_MAX = 2.0;
export const LUMA_SLOPE_DEADBAND = 0.02;
export const LUMA_OFFSET_DEADBAND = 1.5; // luma levels; below this the shift is imperceptible
const LUMA_MIN_SPREAD = 8;               // YHIGH-YLOW below this is a near-flat clip; don't fit

// Seedance 2.5 aspect ratios (see src/validate.js). Pick the closest to the source.
const ASPECTS = [['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3], ['21:9', 21 / 9]];
export function nearestAspect(width, height) {
  if (!width || !height) return '3:4';
  const r = width / height;
  let best = ASPECTS[0];
  for (const a of ASPECTS) if (Math.abs(a[1] - r) < Math.abs(best[1] - r)) best = a;
  return best[0];
}

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

function runProc(bin, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${err.slice(-300)}`))));
  });
}
const defaultFf = (args) => runProc('ffmpeg', ['-v', 'error', '-y', ...args]);
const defaultFfprobe = (args) => runProc('ffprobe', ['-v', 'error', ...args]);

function parseRate(text) {
  const [a, b] = String(text || '').split('/').map(Number);
  if (!b) return a > 0 ? a : 0;
  return a > 0 ? a / b : 0;
}

async function probe(ffprobe, input) {
  const out = await ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate', '-show_entries', 'format=duration', '-of', 'json', input]);
  const j = JSON.parse(out);
  const s = (j.streams && j.streams[0]) || {};
  return {
    width: Number(s.width) || 0, height: Number(s.height) || 0,
    duration: Number(j.format && j.format.duration) || 0, fps: parseRate(s.avg_frame_rate) || 24,
  };
}

// One Seedance video_edit generation. Returns { outputUrl, id }.
async function seedanceEdit({ runner, runBatch, ref, videoId, imageIds, prompt, resolution, aspectRatio, duration }) {
  const opts = {
    videoReferences: [videoId], prompt,
    resolution, aspectRatio, duration, generateAudio: false, mode: 'video_edit',
  };
  if (imageIds && imageIds.length) opts.imageReferences = imageIds;
  const [r] = await runBatch(runner, [{ ref, model: HARMONIZE_MODEL, opts }]);
  if (!r || r.status !== 'completed' || !r.outputUrl) {
    throw new Error(`harmonize ${ref} did not complete: ${(r && (r.error || r.status)) || 'no result'}`);
  }
  return { outputUrl: r.outputUrl, id: r.id };
}

// Output frames [start, end) occupied by the retimed gen span of a splice.
// The head is orig [0, inPoint.origFrame); the gen is retimed to
// (outPoint.origFrame - inPoint.origFrame) frames. Grey only that window.
export function splicedGenSpan(report) {
  if (!report || report.retime === false) return null;
  const start = report.inPoint && report.inPoint.origFrame;
  const end = report.outPoint && report.outPoint.origFrame;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
  return [start, end];
}

// Desaturate and blur frames [startFrame, endFrame) and leave every other frame coloured.
// Commas inside enable= are escaped so the filtergraph parser does not split on them.
export function selectiveGreyFilter(startFrame, endFrame, blur) {
  const last = endFrame - 1;
  const window = `between(n\\,${startFrame}\\,${last})`;
  return `hue=s=0:enable='${window}',gblur=sigma=${blur}:enable='${window}'`;
}

// The coloured head and tail are the finished look. The grey middle is the only region to repaint.
export function selectiveFilterPrompt(startFrame, endFrame, fps) {
  const a = (startFrame / fps).toFixed(2);
  const b = (endFrame / fps).toFixed(2);
  return '@Video1 is the animation. Follow its motion, pose, gesture, timing, composition and framing ' +
    `on every frame. From ${a}s to ${b}s the picture has been turned grey and slightly softened — that ` +
    'middle stretch is the ONLY part to repaint. Repaint it in the EXACT colour, line weight, shading and ' +
    `texture of the coloured frames before ${a}s and after ${b}s, and of @Image1 and @Image2. Those coloured ` +
    'frames are already the finished look: keep their colour, saturation, line and texture unchanged. Do not ' +
    'desaturate them, do not fade their colour toward grey, and do not restyle them. The grey middle must ' +
    'match their colour on every frame so the whole clip reads as one continuous shot. FRAMING — CRITICAL, ' +
    'match the reference images exactly: this is a FULL-BODY WIDE shot. The ENTIRE character is visible at ' +
    'all times, from the very top of the hair down to the bottom of BOTH feet, with a generous margin of ' +
    'empty background ABOVE the head and BELOW the feet. NEVER crop, cut off or push the character out of ' +
    'frame below the knees, shins, ankles or feet; the feet stay fully inside the frame on every frame. Do ' +
    'NOT zoom in, do NOT scale the character up, do NOT pan, tilt or reframe, and do NOT let the character ' +
    "drift toward the camera — the character's size and position stay exactly as in @Video1 and the reference " +
    'images. Background: the same plain flat colour as the reference image; add no scenery, props or set.';
}

// Clip mean of one `lavfi.signalstats.<KEY>` across an ffmpeg `metadata=print` dump. Returns
// null when the key never appears.
export function parseMeanStat(text, key) {
  if (!text) return null;
  let sum = 0, n = 0;
  const re = new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`, 'g');
  let m;
  while ((m = re.exec(String(text)))) { sum += Number(m[1]); n += 1; }
  return n ? sum / n : null;
}

// SATAVG is the average chroma magnitude sqrt((U-128)^2+(V-128)^2) of a frame; its clip mean is a
// single global saturation level.
export function parseSatAvg(text) { return parseMeanStat(text, 'SATAVG'); }

// Clip-mean signalstats for `file` (SATAVG for chroma, YLOW/YHIGH for luma), optionally over only
// the frames kept by `selectExpr` (e.g. to skip a gen span). ff must return the command's stdout.
async function measureSignal(ff, file, selectExpr) {
  const chain = (selectExpr ? `select='${selectExpr}',` : '') + 'signalstats,metadata=print:file=-';
  const out = await ff(['-i', file, '-vf', chain, '-an', '-f', 'null', '-']);
  return { sat: parseMeanStat(out, 'SATAVG'), ylow: parseMeanStat(out, 'YLOW'), yhigh: parseMeanStat(out, 'YHIGH') };
}

// Single global saturation gain that lifts `harmSat` onto `srcSat`. Returns 1 (no change) when
// either side is missing or too grey to trust, or when the gain sits inside the deadband; otherwise
// the clamped ratio. The hue filter scales chroma about its own centroid, so this preserves the
// source's white balance and only restores the magnitude the guidance pass washed out.
export function chromaGain(srcSat, harmSat, {
  min = CHROMA_GAIN_MIN, max = CHROMA_GAIN_MAX, deadband = CHROMA_GAIN_DEADBAND, minSat = CHROMA_MIN_SAT,
} = {}) {
  if (!(srcSat > minSat) || !(harmSat > minSat)) return 1;
  let g = srcSat / harmSat;
  g = Math.min(max, Math.max(min, g));
  return Math.abs(g - 1) <= deadband ? 1 : g;
}

// Robust linear luma map y=a*val+b that lands the restyle's (YLOW,YHIGH) onto the source's, so the
// restyle's tonal range matches the source. Returns {a:1,b:0} (identity) when a side is missing, the
// clip is near-flat, the slope clamps past its bounds' intent, or the map sits in the deadband.
export function lumaMap(src, harm, {
  slopeMin = LUMA_SLOPE_MIN, slopeMax = LUMA_SLOPE_MAX,
  slopeDeadband = LUMA_SLOPE_DEADBAND, offsetDeadband = LUMA_OFFSET_DEADBAND, minSpread = LUMA_MIN_SPREAD,
} = {}) {
  const identity = { a: 1, b: 0 };
  if (!src || !harm) return identity;
  const { ylow: sl, yhigh: sh } = src, { ylow: hl, yhigh: hh } = harm;
  if (![sl, sh, hl, hh].every((v) => Number.isFinite(v))) return identity;
  const srcSpread = sh - sl, harmSpread = hh - hl;
  if (srcSpread < minSpread || harmSpread < minSpread) return identity;
  let a = srcSpread / harmSpread;
  a = Math.min(slopeMax, Math.max(slopeMin, a));
  const b = sl - a * hl;
  // Identity test at the two anchor points: if neither endpoint moves meaningfully, skip.
  const moveLo = Math.abs((a * hl + b) - hl), moveHi = Math.abs((a * hh + b) - hh);
  if (Math.abs(a - 1) <= slopeDeadband && moveLo <= offsetDeadband && moveHi <= offsetDeadband) return identity;
  return { a, b };
}

// Frames OUTSIDE the gen span are the source look to match ("the regions outside the generated
// clip"). With no span, the whole source clip is the target.
function outsideSpanSelect(genSpan) {
  if (!genSpan) return null;
  return `not(between(n\\,${genSpan[0]}\\,${genSpan[1] - 1}))`;
}

/**
 * Harmonize a video so one continuous Seedance pass replaces the whole clip (removing splice
 * seams). Two guidance modes build the stage-1 driving clip:
 *   - 'filter' (default): run the source through a non-generative b+w + slight-blur ffmpeg filter.
 *     Cheaper (ONE Seedance gen) and higher fidelity — the real structure survives, so the restyle
 *     follows it closely. Restyled with FILTER_STYLE_PROMPT.
 *   - 'previz': generate a smooth grey maquette (PREVIS_PROMPT), then restyle (STYLE_PROMPT). Two
 *     Seedance gens; use when the source is too inconsistent for the filter to collapse.
 *   - 'passthrough': keep the source in FULL COLOUR as the guidance (no desaturate, no blur) and
 *     restyle with COMPOSITE_SCENE_PROMPT. Use to composite a plain-bg character clip INTO a scene:
 *     the appearance ref is a finished composite still, @Video1 supplies motion/colour. Defaults to
 *     no pad (padMargin 0) and no colour conform (conforming onto the plain-bg source would
 *     desaturate the scene). ONE Seedance gen.
 * Then restyle from the appearance refs. Before the restyle, the guidance clip and both stills are
 * padded (`spec.padMargin`, default 0.12 per side) so a model zoom still leaves the extremities
 * inside the frame. After the restyle, one global TRS scales that pad back off against the original
 * input. Then conform the restyle's colour onto the source — a global chroma gain (unless
 * `chroma:false`) and a robust luma-range match (unless `luma:false`) — and mux the input's audio on.
 *
 * Writes `<base>.guidance.mp4` + `<base>.harmonized.mp4` (beside the input, or under `spec.out`).
 * Returns { outputPath, previzPath, guidance, chroma, luma, refs, jobs, framing, model, resolution }.
 *
 * `spec`: { input, refs?[], resolution?, aspect?, out?, keepPreviz?, guidance?, blur?, genSpan?, padMargin?, chroma?, luma?, styleLock?, border?, prompt? }
 * `styleLock` (string) is the character's style lock — folded into the restyle prompt so the repaint
 *   matches the character's own render style; omitted, the restyle defers style to the appearance refs
 *   (medium-neutral, imposes no 2D/3D look). `border` ({ px, guidanceColor?, refColor? }) draws an
 *   experimental frame-anchor border; `prompt` overrides the composed restyle prompt entirely.
 * `genSpan` is `[startFrame, endFrame)` of the spliced clip to desaturate. Omit it to grey the whole clip.
 * `chroma` (default true) runs the global saturation match; `luma` (default true) runs the tonal-range match. Either false leaves that channel as-is.
 * `deps`: { runner, runBatch, downloadTo, ff, ffprobe, padFrame, alignFraming, sampleCorner } — injected for tests.
 */
export async function harmonizeVideo(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
  ff = defaultFf, ffprobe = defaultFfprobe,
  padFrame = defaultPadFrame, alignFraming = defaultAlignFraming, sampleCorner = sampleCornerHex,
} = {}) {
  const {
    input, resolution = HARMONIZE_DEFAULT_RESOLUTION, keepPreviz = true,
    guidance = HARMONIZE_DEFAULT_GUIDANCE, blur = HARMONIZE_DEFAULT_BLUR, genSpan = null,
    keepRaw = false,
  } = spec;
  // The colour conform matches the restyle's chroma/luma onto the SOURCE. That is right for a
  // restyle (keep the clip's own look), but wrong for 'passthrough' composite-into-scene: the
  // source is a plain-bg clip, so conforming would desaturate the vivid scene down to the backdrop.
  // So passthrough defaults the conform OFF; the caller can still force it on explicitly.
  const conformDefault = guidance !== 'passthrough';
  const chroma = spec.chroma == null ? conformDefault : spec.chroma;
  const luma = spec.luma == null ? conformDefault : spec.luma;
  if (genSpan && (!Number.isInteger(genSpan[0]) || !Number.isInteger(genSpan[1]) || genSpan[1] <= genSpan[0])) {
    throw new Error('harmonizeVideo: genSpan must be [startFrame, endFrame)');
  }
  if (!input) throw new Error('harmonizeVideo: spec.input is required');
  if (guidance !== 'filter' && guidance !== 'previz' && guidance !== 'passthrough') throw new Error(`harmonizeVideo: guidance must be 'filter', 'previz' or 'passthrough', got "${guidance}"`);
  if (!await exists(input)) throw new Error(`no such video: ${input}`);

  const outDir = spec.out ? path.resolve(root, spec.out) : path.dirname(path.resolve(root, input));
  await mkdir(outDir, { recursive: true });
  const base = path.basename(input).replace(/\.[^.]+$/, '');
  const guidancePath = path.join(outDir, `${base}.guidance.mp4`);
  const restyledTmp = path.join(outDir, `.${base}.restyled.${process.pid}.mp4`);
  const outputPath = path.join(outDir, `${base}.harmonized.mp4`);
  const rawPath = path.join(outDir, `${base}.harmonized.raw.mp4`);

  const meta = await probe(ffprobe, input);
  const aspectRatio = spec.aspect || nearestAspect(meta.width, meta.height);
  const duration = Math.max(1, Math.round(meta.duration));

  // Appearance refs for the restyle: caller-supplied, else the input's first + last frame.
  let refs = (spec.refs || []).slice();
  if (!refs.length) {
    const first = path.join(outDir, `${base}.ref-first.png`);
    const last = path.join(outDir, `${base}.ref-last.png`);
    await ff(['-i', input, '-vf', 'select=eq(n\\,0)', '-vframes', '1', first]);
    await ff(['-sseof', '-0.2', '-i', input, '-update', '1', '-vframes', '1', last]);
    refs = [first, last];
  }

  // Stage 1: build the guidance clip.
  let previzJob = null;
  let stylePrompt = filterStylePrompt(spec.styleLock);
  if (guidance === 'passthrough') {
    // Composite-into-scene mode: keep the source in FULL COLOUR as the guidance — no desaturation,
    // no blur — so the model matches the character's existing colours and only adapts lighting to
    // the scene. The appearance ref (@Image1) is a finished composite still that defines the target
    // frame. Re-encode through the `null` filter so range tagging and pix_fmt stay consistent.
    stylePrompt = compositeScenePrompt(spec.styleLock);
    await ff(['-i', input, '-vf', 'null', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', ...RANGE_ARGS, '-an', guidancePath]);
  } else if (guidance === 'filter') {
    // Full-clip grey asks the restyle to invent every frame's colour from two stills, and it only
    // does that reliably where it repaints. A gen span keeps the source head/tail in colour — the
    // look to copy — and greys only the generated middle, which is the part to repaint.
    const vf = genSpan ? selectiveGreyFilter(genSpan[0], genSpan[1], blur) : `hue=s=0,gblur=sigma=${blur}`;
    if (genSpan) stylePrompt = selectiveFilterPrompt(genSpan[0], genSpan[1], meta.fps);
    await ff(['-i', input, '-vf', vf, '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', ...RANGE_ARGS, '-an', guidancePath]);
  } else {
    // Generate a smooth grey previz maquette (no appearance ref — the point is to strip it).
    const srcMedia = await runner.upload(input);
    const previz = await seedanceEdit({
      runner, runBatch, ref: 'previz', videoId: srcMedia.id, imageIds: null,
      prompt: PREVIS_PROMPT, resolution, aspectRatio, duration,
    });
    await downloadTo(previz.outputUrl, guidancePath);
    previzJob = previz.id;
    stylePrompt = previzStylePrompt(spec.styleLock);
  }

  // Pad the guidance and the stills by the same margin. The model copies this looser frame;
  // the TRS below puts the character back on the original crop. padMargin 0 skips both.
  // Passthrough (composite-into-scene) defaults to no pad: the full-colour guidance anchors
  // structure and framing on its own, and a pad would reintroduce a grey ring the TRS can't fully
  // crop once a real background is filled in. The other modes keep the anti-zoom pad.
  const defaultMargin = guidance === 'passthrough' ? 0 : HARMONIZE_PAD_MARGIN;
  const margin = spec.padMargin == null ? defaultMargin : Number(spec.padMargin);
  let guidanceForModel = guidancePath;
  let refsForModel = refs;
  const paddedTemps = [];
  if (margin > 0) {
    const fill = await sampleCorner(guidancePath);
    guidanceForModel = path.join(outDir, `.${base}.guidance.pad.${process.pid}.mp4`);
    await ff(['-i', guidancePath, '-vf', padVideoFilter(meta.width, meta.height, margin, fill), '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', ...RANGE_ARGS, '-an', guidanceForModel]);
    paddedTemps.push(guidanceForModel);
    refsForModel = [];
    for (const r of refs) {
      const padded = r.replace(/(\.[^.]+)$/, '.pad$1');
      await padFrame(r, padded, { margin });
      refsForModel.push(padded);
      paddedTemps.push(padded);
    }
  }

  // Experimental frame anchor: draw a high-contrast border around the guidance and the stills so the
  // model has a salient scale reference at the frame edge instead of an anchorless subject on a flat
  // void (the cause of its frame-filling zoom). `spec.border` = { px, guidanceColor, refColor };
  // default off. Runs after any pad, on what is uploaded, and whitelists the border in the prompt so
  // the restyle keeps it rather than stripping it as scenery. The border is keyed/cropped downstream.
  if (spec.border && spec.border.px > 0) {
    const { px, guidanceColor = 'black', refColor = 'red' } = spec.border;
    const boxed = guidanceForModel.replace(/(\.[^.]+)$/, '.border$1');
    await ff(['-i', guidanceForModel, '-vf', `drawbox=x=0:y=0:w=iw:h=ih:t=${px}:color=${guidanceColor}`,
      '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', ...RANGE_ARGS, '-an', boxed]);
    guidanceForModel = boxed; paddedTemps.push(boxed);
    const bordered = [];
    for (const r of refsForModel) {
      const b = r.replace(/(\.[^.]+)$/, '.border$1');
      await ff(['-i', r, '-vf', `drawbox=x=0:y=0:w=iw:h=ih:t=${px}:color=${refColor}`, b]);
      bordered.push(b); paddedTemps.push(b);
    }
    refsForModel = bordered;
    stylePrompt += ' ' + BORDER_PROMPT_CLAUSE;  // whitelist the border so the restyle keeps it
  }

  // Optional full prompt override (experiment escape hatch). Replaces the composed prompt above.
  if (spec.prompt) stylePrompt = spec.prompt;

  // Stage 2: restyle (repaint) the guidance clip from the appearance refs.
  const guidanceMedia = await runner.upload(guidanceForModel);
  const refMedia = [];
  for (const r of refsForModel) refMedia.push((await runner.upload(r)).id);
  const restyle = await seedanceEdit({
    runner, runBatch, ref: 'harmonize', videoId: guidanceMedia.id, imageIds: refMedia,
    prompt: stylePrompt, resolution, aspectRatio, duration,
  });
  await downloadTo(restyle.outputUrl, restyledTmp);

  // Scale the pad back off: one global TRS aligns the restyle onto the original input's crop.
  // Cropping a `margin` pad needs a scale of 1/(1-2*margin), which for margins past ~0.18 exceeds
  // alignFraming's default maxScale (1.6) — it would then refuse the undo and leave the pad border
  // on (which also corrupts the colour conform's measurement below). Raise the cap to the pad's
  // required scale, with headroom, so larger pads are undone instead of silently kept.
  const seedScale = margin > 0 ? 1 / (1 - 2 * margin) : 1;
  const alignedTmp = path.join(outDir, `.${base}.aligned.${process.pid}.mp4`);
  const framing = await alignFraming(input, restyledTmp, alignedTmp, {
    seedScale,
    maxScale: Math.max(1.6, seedScale * 1.15),
  });
  const videoForMux = framing.applied ? alignedTmp : restyledTmp;

  // Non-generative colour conform onto the source, on the framing-aligned restyle. The restyle
  // drives off a desaturated guidance pass, so its colour and tone drift from the source. Measure
  // the source (frames outside any gen span — the look to match) and the aligned restyle with one
  // signalstats pass each, then:
  //   - CHROMA: lift saturation by one global gain with `hue=s=`. The restyle comes out uniformly
  //     washed, so a single gain is right; hue scales chroma about its own centroid, restoring the
  //     magnitude without shifting white balance, and the near-neutral backdrop is not over-saturated.
  //   - LUMA: match the tonal range with a robust `lutyuv` linear map (YLOW/YHIGH onto the source).
  //     Brightness error is NOT uniform — the character already matches, only the flat backdrop is
  //     too bright — so a mean offset would darken the character; the range map corrects the backdrop
  //     while barely moving the midtones.
  // An identity transform (a match, or an untrustworthy grey/flat measurement) is skipped, and when
  // both are identity the fast stream-copy path is kept.
  let chromaInfo = { gain: 1, sourceSat: null, harmonizedSat: null };
  let lumaInfo = { a: 1, b: 0, source: null, harmonized: null };
  if (chroma || luma) {
    const src = await measureSignal(ff, input, outsideSpanSelect(genSpan));
    const harm = await measureSignal(ff, videoForMux);
    if (chroma) chromaInfo = { gain: chromaGain(src.sat, harm.sat), sourceSat: src.sat, harmonizedSat: harm.sat };
    if (luma) { const m = lumaMap(src, harm); lumaInfo = { ...m, source: src, harmonized: harm }; }
  }

  // Build the conform filter chain (chroma + luma are independent — one touches chroma planes, the
  // other the luma plane — so order is immaterial), applying it during the audio mux.
  const filters = [];
  if (chromaInfo.gain !== 1) filters.push(`hue=s=${chromaInfo.gain.toFixed(4)}`);
  if (lumaInfo.a !== 1 || lumaInfo.b !== 0) filters.push(`lutyuv='y=clip(${lumaInfo.a.toFixed(4)}*val+${lumaInfo.b.toFixed(2)}\\,0\\,255)'`);

  // Optionally keep the RAW harmonized result — the framing-aligned restyle with the input's audio
  // but BEFORE the colour conform — beside the conformed output, so the two can be compared.
  if (keepRaw) {
    await ff(['-i', videoForMux, '-i', input, '-vf', 'setsar=1',
      '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', ...RANGE_ARGS, '-c:a', 'aac', '-shortest', rawPath]);
  }

  // Carry the input's audio onto the restyled clip, applying the conform in the same pass when there
  // is one (otherwise copy the video stream through untouched).
  // Normalize the pixel aspect to 1:1 and pin the colour range to limited/tv (RANGE_ARGS). The
  // restyle download can carry a non-square SAR that the mux would otherwise inherit, making a
  // correct WxH frame DISPLAY stretched (e.g. 560x752 tagged to show 752x752), and it arrives with
  // no range tag at all, which leaves downstream tools to guess. On the re-encode path setsar=1 +
  // -color_range tv do it; on the stream-copy path both live in the H.264 SPS/VUI, so rewrite them
  // with a bitstream filter (sample_aspect_ratio + video_full_range_flag=0) without re-encoding.
  if (filters.length) {
    await ff(['-i', videoForMux, '-i', input, '-vf', [...filters, 'setsar=1'].join(','),
      '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', ...RANGE_ARGS, '-c:a', 'aac', '-shortest', outputPath]);
  } else {
    await ff(['-i', videoForMux, '-i', input, '-map', '0:v', '-map', '1:a?', '-c:v', 'copy',
      '-bsf:v', 'h264_metadata=sample_aspect_ratio=1/1:video_full_range_flag=0', '-c:a', 'aac', '-shortest', outputPath]);
  }
  await rm(restyledTmp, { force: true });
  if (framing.applied) await rm(alignedTmp, { force: true });
  for (const p of paddedTemps) await rm(p, { force: true });
  if (!keepPreviz) await rm(guidancePath, { force: true });

  return {
    outputPath, rawPath: keepRaw ? rawPath : null, previzPath: keepPreviz ? guidancePath : null,
    guidance: { mode: guidance, path: keepPreviz ? guidancePath : null, genSpan: genSpan || null, padMargin: margin },
    chroma: chromaInfo, luma: lumaInfo,
    refs, jobs: { previz: previzJob, restyle: restyle.id }, framing,
    model: HARMONIZE_MODEL, resolution, aspectRatio, duration,
  };
}
