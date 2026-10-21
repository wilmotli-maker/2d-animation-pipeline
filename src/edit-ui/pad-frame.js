// src/edit-ui/pad-frame.js
// Pad a reference frame: scale the content down by `margin` on every side and fill the border with
// the frame's own background colour, keeping the same dimensions. Giving the generator empty space
// around the subject stops it cropping antennae / feet / hands at the frame edges (the prompt alone
// doesn't reliably hold the margin). The subject ends up smaller in frame, but the splice's TRS
// align re-absorbs the scale back to the source framing.
import sharp from 'sharp';

// Mean colour of a small top-left patch — the flat studio background the clips use.
async function cornerColour(src) {
  const { data } = await sharp(src).extract({ left: 1, top: 1, width: 6, height: 6 }).raw().toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, n = data.length / 3;
  for (let i = 0; i < data.length; i += 3) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

// Write a padded copy of `src` to `out`. margin is the fraction of empty space added on EACH side
// (0.1 ≈ 10%). Returns { out, margin }.
export async function padFrame(src, out, { margin = 0.1, background } = {}) {
  const m = Math.max(0, Math.min(0.4, margin));
  const meta = await sharp(src).metadata();
  const W = meta.width, H = meta.height;
  const iw = Math.max(1, Math.round(W * (1 - 2 * m)));
  const ih = Math.max(1, Math.round(H * (1 - 2 * m)));
  const left = Math.round((W - iw) / 2), top = Math.round((H - ih) / 2);
  const bg = background || await cornerColour(src);
  await sharp(src).resize(iw, ih)
    .extend({ top, bottom: H - ih - top, left, right: W - iw - left, background: bg })
    .toFile(out);
  return { out, margin: m };
}
