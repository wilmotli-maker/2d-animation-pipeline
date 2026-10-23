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

export const HARMONIZE_MODEL = 'seedance_2_5';
export const HARMONIZE_DEFAULT_RESOLUTION = '480p';

// Canonical prompts — the single source of truth. The harmonize-eval spike's
// prompts.mjs re-exports these; the previz-blocking skill keeps a verbatim copy.
export const PREVIS_PROMPT =
  `Re-render the exact character in this video as a smooth, untextured GREYSCALE 3D RENDER — a clean matte digital maquette of THIS specific character, like an untextured CG model lit with soft global illumination. SHAPE — keep the character's silhouette, proportions and body-part shapes from the source: the same head shape and size, the same body, torso, limbs, hands and feet, the glasses, the hair volume and shape, the apron shape and every distinctive feature it has (antennae, snout, muzzle, tail, ears, horns, spikes, fins, wings, extra or non-human limbs, block feet, etc.). You MAY slightly simplify and smooth the forms into clean, idealised geometry, but do NOT change overall proportions, do NOT humanise or regularise it, do NOT replace it with a generic humanoid figure or a wooden posing mannequin, and do NOT alter the pose. FACE & EXPRESSION — KEEP the character's facial features and current expression on every frame: eyes, eyebrows, the mouth (or beak / muzzle), nose, and any visible teeth or tongue must stay, modelled as smooth raised or recessed relief so the expression reads clearly — never leave a blank, smooth-over or featureless face, and do not drop the mouth. MATERIAL — the ENTIRE character (body, head, face, hair, fur, skin, eyes, glasses, clothing and every accessory) becomes ONE uniform smooth matte mid-grey surface. Strip ALL colour, line art, outlines, markings, patterns, logos, printed text and surface texture that came from the source: absolutely no colour survives anywhere — no coloured hair or fur, no coloured eyes, no coloured glasses lenses or frames, no wood tone, no tints from the source — every part is the same neutral grey. The surface must be SMOOTH and TEXTURELESS, shown through soft, even, gentle shading and subtle highlights like a clean untextured 3D render or smooth modelling clay — NOT rough, NOT bumpy, NOT grainy, NOT painterly, NOT hand-drawn, and NOT 2D artwork. BACKGROUND: a completely empty, featureless flat matte grey void — no environment, floor, set, walls, props or scenery of any kind; nothing but the single grey character on seamless grey. FRAMING: keep the source's exact camera framing and character scale — the whole character stays in frame from top to bottom in the same position and with the same margins as the source; never crop, zoom, pan or reframe. Preserve the body motion, performance timing, pose and gesture exactly. The result must read as a smooth, untextured greyscale 3D render of this character — never finished or coloured 2D artwork, and never a generic dummy.`;

export const STYLE_PROMPT =
  'Repaint this grey placeholder previs animation as a finished, hand-drawn 2D ' +
  'illustrated character in the EXACT style of the reference image(s) — their character ' +
  'design, colour palette, line weight, shading and texture. Keep the body motion, pose, ' +
  'gesture and timing from the video completely unchanged. Apply the reference look ' +
  'identically on every frame so the whole clip reads as one continuous, uniformly-styled ' +
  'shot. FRAMING: preserve the exact framing, character scale and composition of the ' +
  'video — the entire character stays in frame from the top of the head to the feet with ' +
  'the same margins; never crop below the feet, knees or waist, never zoom in, never ' +
  'reframe. Keep the background the same plain flat colour as the reference image; add no ' +
  'scenery, props or set.';

// Restyle prompt for the FILTER guidance path (default): the stage-1 input is the source run
// through a non-generative b+w + slight-blur filter, not a generated grey previz. It addresses the
// references by position (@Video1 = the guidance clip, @Image1/@Image2 = appearance) and carries a
// strong full-body framing guard (a looser prompt let the restyle crop below the knees).
export const FILTER_STYLE_PROMPT =
  '@Video1 is a desaturated, softened black-and-white guidance pass of the animation — take ONLY ' +
  'its motion, pose, gesture, timing, composition and framing from it; ignore its greyscale and its ' +
  'blur. @Image1 and @Image2 are the appearance references (the first and last frame of the finished ' +
  'look): repaint the character in their EXACT style — character design, colour palette, line weight, ' +
  'shading and texture — restoring full colour and crisp finished hand-drawn 2D rendering. Keep ' +
  "@Video1's body motion, pose, gesture and timing completely unchanged and apply the reference look " +
  'identically on every frame so the whole clip reads as one continuous, uniformly-styled 2D cartoon ' +
  'shot. FRAMING — CRITICAL, match the reference images exactly: this is a FULL-BODY WIDE shot. The ' +
  'ENTIRE character is visible at all times, from the very top of the hair down to the bottom of BOTH ' +
  'feet, with a generous margin of empty background ABOVE the head and BELOW the feet. NEVER crop, cut ' +
  'off or push the character out of frame below the knees, shins, ankles or feet; the feet stay fully ' +
  'inside the frame on every frame. Do NOT zoom in, do NOT scale the character up, do NOT pan, tilt or ' +
  "reframe, and do NOT let the character drift toward the camera — the character's size and position " +
  'stay exactly as in @Video1 and the reference images. Background: the same plain flat colour as the ' +
  'reference image; add no scenery, props or set.';

export const HARMONIZE_DEFAULT_GUIDANCE = 'filter'; // 'filter' (non-generative b+w+blur) | 'previz' (generated grey maquette)
export const HARMONIZE_DEFAULT_BLUR = 1.2;          // gaussian sigma for the filter guidance

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

/**
 * Harmonize a video so one continuous Seedance pass replaces the whole clip (removing splice
 * seams). Two guidance modes build the stage-1 driving clip:
 *   - 'filter' (default): run the source through a non-generative b+w + slight-blur ffmpeg filter.
 *     Cheaper (ONE Seedance gen) and higher fidelity — the real structure survives, so the restyle
 *     follows it closely. Restyled with FILTER_STYLE_PROMPT.
 *   - 'previz': generate a smooth grey maquette (PREVIS_PROMPT), then restyle (STYLE_PROMPT). Two
 *     Seedance gens; use when the source is too inconsistent for the filter to collapse.
 * Then restyle from the appearance refs and mux the input's audio onto the result.
 *
 * Writes `<base>.guidance.mp4` + `<base>.harmonized.mp4` (beside the input, or under `spec.out`).
 * Returns { outputPath, previzPath, guidance, refs, jobs, model, resolution }.
 *
 * `spec`: { input, refs?[], resolution?, aspect?, out?, keepPreviz?, guidance?, blur?, genSpan? }
 * `genSpan` is `[startFrame, endFrame)` of the spliced clip to desaturate. Omit it to grey the whole clip.
 * `deps`: { runner, runBatch, downloadTo, ff, ffprobe } — injected for tests.
 */
export async function harmonizeVideo(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
  ff = defaultFf, ffprobe = defaultFfprobe,
} = {}) {
  const {
    input, resolution = HARMONIZE_DEFAULT_RESOLUTION, keepPreviz = true,
    guidance = HARMONIZE_DEFAULT_GUIDANCE, blur = HARMONIZE_DEFAULT_BLUR, genSpan = null,
  } = spec;
  if (genSpan && (!Number.isInteger(genSpan[0]) || !Number.isInteger(genSpan[1]) || genSpan[1] <= genSpan[0])) {
    throw new Error('harmonizeVideo: genSpan must be [startFrame, endFrame)');
  }
  if (!input) throw new Error('harmonizeVideo: spec.input is required');
  if (guidance !== 'filter' && guidance !== 'previz') throw new Error(`harmonizeVideo: guidance must be 'filter' or 'previz', got "${guidance}"`);
  if (!await exists(input)) throw new Error(`no such video: ${input}`);

  const outDir = spec.out ? path.resolve(root, spec.out) : path.dirname(path.resolve(root, input));
  await mkdir(outDir, { recursive: true });
  const base = path.basename(input).replace(/\.[^.]+$/, '');
  const guidancePath = path.join(outDir, `${base}.guidance.mp4`);
  const restyledTmp = path.join(outDir, `.${base}.restyled.${process.pid}.mp4`);
  const outputPath = path.join(outDir, `${base}.harmonized.mp4`);

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

  // Stage 1: build the neutral guidance clip.
  let previzJob = null;
  let stylePrompt = FILTER_STYLE_PROMPT;
  if (guidance === 'filter') {
    // Full-clip grey asks the restyle to invent every frame's colour from two stills, and it only
    // does that reliably where it repaints. A gen span keeps the source head/tail in colour — the
    // look to copy — and greys only the generated middle, which is the part to repaint.
    const vf = genSpan ? selectiveGreyFilter(genSpan[0], genSpan[1], blur) : `hue=s=0,gblur=sigma=${blur}`;
    if (genSpan) stylePrompt = selectiveFilterPrompt(genSpan[0], genSpan[1], meta.fps);
    await ff(['-i', input, '-vf', vf, '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-an', guidancePath]);
  } else {
    // Generate a smooth grey previz maquette (no appearance ref — the point is to strip it).
    const srcMedia = await runner.upload(input);
    const previz = await seedanceEdit({
      runner, runBatch, ref: 'previz', videoId: srcMedia.id, imageIds: null,
      prompt: PREVIS_PROMPT, resolution, aspectRatio, duration,
    });
    await downloadTo(previz.outputUrl, guidancePath);
    previzJob = previz.id;
    stylePrompt = STYLE_PROMPT;
  }

  // Stage 2: restyle (repaint) the guidance clip from the appearance refs.
  const guidanceMedia = await runner.upload(guidancePath);
  const refMedia = [];
  for (const r of refs) refMedia.push((await runner.upload(r)).id);
  const restyle = await seedanceEdit({
    runner, runBatch, ref: 'harmonize', videoId: guidanceMedia.id, imageIds: refMedia,
    prompt: stylePrompt, resolution, aspectRatio, duration,
  });
  await downloadTo(restyle.outputUrl, restyledTmp);

  // Carry the input's audio onto the silent restyled clip.
  await ff(['-i', restyledTmp, '-i', input, '-map', '0:v', '-map', '1:a?', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputPath]);
  await rm(restyledTmp, { force: true });
  if (!keepPreviz) await rm(guidancePath, { force: true });

  return {
    outputPath, previzPath: keepPreviz ? guidancePath : null,
    guidance: { mode: guidance, path: keepPreviz ? guidancePath : null, genSpan: genSpan || null },
    refs, jobs: { previz: previzJob, restyle: restyle.id },
    model: HARMONIZE_MODEL, resolution, aspectRatio, duration,
  };
}
