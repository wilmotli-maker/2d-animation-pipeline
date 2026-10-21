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
 * Harmonize a video via previz → restyle. Writes `<base>.previz.mp4`,
 * `<base>.harmonized.mp4` (audio carried over from the input) beside the input, or
 * under `spec.out`. Returns { outputPath, previzPath, refs, jobs, model, resolution }.
 *
 * `spec`: { input, refs?[], resolution?, aspect?, out?, keepPreviz? }
 * `deps`: { runner, runBatch, downloadTo, ff, ffprobe } — injected for tests.
 */
export async function harmonizeVideo(root, spec, {
  runner, runBatch = defaultRunBatch, downloadTo = defaultDownloadTo,
  ff = defaultFf, ffprobe = defaultFfprobe,
} = {}) {
  const { input, resolution = HARMONIZE_DEFAULT_RESOLUTION, keepPreviz = true } = spec;
  if (!input) throw new Error('harmonizeVideo: spec.input is required');
  if (!await exists(input)) throw new Error(`no such video: ${input}`);

  const outDir = spec.out ? path.resolve(root, spec.out) : path.dirname(path.resolve(root, input));
  await mkdir(outDir, { recursive: true });
  const base = path.basename(input).replace(/\.[^.]+$/, '');
  const previzPath = path.join(outDir, `${base}.previz.mp4`);
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

  // Stage 1: previz (neutralise). No appearance reference — the point is to strip it.
  const srcMedia = await runner.upload(input);
  const previz = await seedanceEdit({
    runner, runBatch, ref: 'previz', videoId: srcMedia.id, imageIds: null,
    prompt: PREVIS_PROMPT, resolution, aspectRatio, duration,
  });
  await downloadTo(previz.outputUrl, previzPath);

  // Stage 2: restyle (repaint) from the appearance refs.
  const previzMedia = await runner.upload(previzPath);
  const refMedia = [];
  for (const r of refs) refMedia.push((await runner.upload(r)).id);
  const restyle = await seedanceEdit({
    runner, runBatch, ref: 'harmonize', videoId: previzMedia.id, imageIds: refMedia,
    prompt: STYLE_PROMPT, resolution, aspectRatio, duration,
  });
  await downloadTo(restyle.outputUrl, restyledTmp);

  // Carry the input's audio onto the silent restyled clip.
  await ff(['-i', restyledTmp, '-i', input, '-map', '0:v', '-map', '1:a?', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputPath]);
  await rm(restyledTmp, { force: true });
  if (!keepPreviz) await rm(previzPath, { force: true });

  return {
    outputPath, previzPath: keepPreviz ? previzPath : null, refs,
    jobs: { previz: previz.id, restyle: restyle.id },
    model: HARMONIZE_MODEL, resolution, aspectRatio, duration,
  };
}
