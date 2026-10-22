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
  'shot. FRAMING: the video is the camera. Copy its framing exactly — the same character ' +
  'scale, the same position and the same margins, including the top of the head and the ' +
  'feet. Do not zoom, do not scale the character up or down, do not pan or reframe. Keep ' +
  'the background the same plain flat colour as the reference image; add no scenery, props ' +
  'or set.';

// Restyle prompt for the FILTER guidance path (default). @Video1 is the camera: a prompt that
// asked for a "generous margin" or to match the reference stills' crop did not stop the model
// zooming. The guidance clip and the stills are padded before this prompt runs, so copying
// @Video1's framing copies the padded frame; a later TRS removes that pad.
export const FILTER_STYLE_PROMPT =
  '@Video1 is a desaturated, softened black-and-white guidance pass of the animation — take ONLY ' +
  'its motion, pose, gesture, timing, composition and framing from it; ignore its greyscale and its ' +
  'blur. @Image1 and @Image2 are the appearance references: repaint the character in their EXACT ' +
  'style — character design, colour palette, line weight, shading and texture — restoring full ' +
  'colour and crisp finished hand-drawn 2D rendering. The reference images control appearance ' +
  'only and must not change the crop or the character\'s size. Keep @Video1\'s body motion, pose, ' +
  'gesture and timing completely unchanged and apply the reference look identically on every frame ' +
  'so the whole clip reads as one continuous, uniformly-styled 2D cartoon shot. FRAMING — CRITICAL: ' +
  '@Video1 is the camera. Copy its framing exactly on every frame — the same character scale, the ' +
  'same position, the same headroom and the same empty margins on all sides. Do NOT zoom in or out, ' +
  'do NOT scale the character larger or smaller, do NOT pan, tilt or reframe, and do NOT let the ' +
  'character drift toward or away from the camera. Keep every body part that is inside @Video1\'s ' +
  'frame inside the frame, including the feet and anything that reaches the top of the head. ' +
  'Background: the same plain flat colour as the reference image; add no scenery, props or set.';

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

async function probe(ffprobe, input) {
  const out = await ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'json', input]);
  const j = JSON.parse(out);
  const s = (j.streams && j.streams[0]) || {};
  return { width: Number(s.width) || 0, height: Number(s.height) || 0, duration: Number(j.format && j.format.duration) || 0 };
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

/**
 * Harmonize a video so one continuous Seedance pass replaces the whole clip (removing splice
 * seams). Two guidance modes build the stage-1 driving clip:
 *   - 'filter' (default): run the source through a non-generative b+w + slight-blur ffmpeg filter.
 *     Cheaper (ONE Seedance gen) and higher fidelity — the real structure survives, so the restyle
 *     follows it closely. Restyled with FILTER_STYLE_PROMPT.
 *   - 'previz': generate a smooth grey maquette (PREVIS_PROMPT), then restyle (STYLE_PROMPT). Two
 *     Seedance gens; use when the source is too inconsistent for the filter to collapse.
 * Then restyle from the appearance refs. Before the restyle, the guidance clip and both stills are
 * padded (`spec.padMargin`, default 0.12 per side) so a model zoom still leaves the extremities
 * inside the frame. After the restyle, one global TRS scales that pad back off against the
 * original input, and the input's audio is muxed onto the result.
 *
 * Writes `<base>.guidance.mp4` + `<base>.harmonized.mp4` (beside the input, or under `spec.out`).
 * Returns { outputPath, previzPath, guidance, refs, jobs, framing, model, resolution }.
 *
 * `spec`: { input, refs?[], resolution?, aspect?, out?, keepPreviz?, guidance?, blur?, padMargin? }
 * `deps`: { runner, runBatch, downloadTo, ff, ffprobe, padFrame, alignFraming, sampleCorner } — injected for tests.
 */
export async function harmonizeVideo(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
  ff = defaultFf, ffprobe = defaultFfprobe,
  padFrame = defaultPadFrame, alignFraming = defaultAlignFraming, sampleCorner = sampleCornerHex,
} = {}) {
  const {
    input, resolution = HARMONIZE_DEFAULT_RESOLUTION, keepPreviz = true,
    guidance = HARMONIZE_DEFAULT_GUIDANCE, blur = HARMONIZE_DEFAULT_BLUR,
  } = spec;
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
    // Non-generative: desaturate + slight blur to strip colour/texture while keeping the real motion.
    await ff(['-i', input, '-vf', `hue=s=0,gblur=sigma=${blur}`, '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-an', guidancePath]);
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

  // Pad the guidance and the stills by the same margin. The model copies this looser frame;
  // the TRS below puts the character back on the original crop. padMargin 0 skips both.
  const margin = spec.padMargin == null ? HARMONIZE_PAD_MARGIN : Number(spec.padMargin);
  let guidanceForModel = guidancePath;
  let refsForModel = refs;
  const paddedTemps = [];
  if (margin > 0) {
    const fill = await sampleCorner(guidancePath);
    guidanceForModel = path.join(outDir, `.${base}.guidance.pad.${process.pid}.mp4`);
    await ff(['-i', guidancePath, '-vf', padVideoFilter(meta.width, meta.height, margin, fill), '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-an', guidanceForModel]);
    paddedTemps.push(guidanceForModel);
    refsForModel = [];
    for (const r of refs) {
      const padded = r.replace(/(\.[^.]+)$/, '.pad$1');
      await padFrame(r, padded, { margin });
      refsForModel.push(padded);
      paddedTemps.push(padded);
    }
  }

  // Stage 2: restyle (repaint) the guidance clip from the appearance refs.
  const guidanceMedia = await runner.upload(guidanceForModel);
  const refMedia = [];
  for (const r of refsForModel) refMedia.push((await runner.upload(r)).id);
  const restyle = await seedanceEdit({
    runner, runBatch, ref: 'harmonize', videoId: guidanceMedia.id, imageIds: refMedia,
    prompt: stylePrompt, resolution, aspectRatio, duration,
  });
  await downloadTo(restyle.outputUrl, restyledTmp);

  const alignedTmp = path.join(outDir, `.${base}.aligned.${process.pid}.mp4`);
  const framing = await alignFraming(input, restyledTmp, alignedTmp, {
    seedScale: margin > 0 ? 1 / (1 - 2 * margin) : 1,
  });
  const videoForMux = framing.applied ? alignedTmp : restyledTmp;

  // Carry the input's audio onto the silent restyled clip.
  await ff(['-i', videoForMux, '-i', input, '-map', '0:v', '-map', '1:a?', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputPath]);
  await rm(restyledTmp, { force: true });
  if (framing.applied) await rm(alignedTmp, { force: true });
  for (const p of paddedTemps) await rm(p, { force: true });
  if (!keepPreviz) await rm(guidancePath, { force: true });

  return {
    outputPath, previzPath: keepPreviz ? guidancePath : null, guidance: { mode: guidance, path: keepPreviz ? guidancePath : null, padMargin: margin },
    refs, jobs: { previz: previzJob, restyle: restyle.id }, framing,
    model: HARMONIZE_MODEL, resolution, aspectRatio, duration,
  };
}
