#!/usr/bin/env node
// THROWAWAY SPIKE — mask-video generator for the Wan VACE inpainting spike
// (wan-vace.js). Produces a WHITE-on-BLACK mask video that matches a source
// clip's dimensions, fps, and duration, in VACE's convention:
//   WHITE = regenerate this pixel, BLACK = keep the source pixel.
//
// This is the no-ML-deps path: geometric region + time-window masks. It exercises
// VACE's spatial/temporal mask contract cheaply. For a moving subject you want
// SAM-2/3 tracking instead (or the repo's matte pipeline) — this static-region
// tool is only honest when the target region roughly holds still, or you accept a
// generous box. Coordinates are FRACTIONS of width/height (0..1), origin top-left.
//
// Usage:
//   node make-mask.js --src draft.mp4 --out mask.mp4 --box 0.5,0.35,0.3,0.15
//   node make-mask.js --src draft.mp4 --out mask.mp4 --ellipse 0.5,0.4,0.18,0.12 --feather 12
//   node make-mask.js --src draft.mp4 --out mask.mp4 --window 6.0,7.2        # full-frame, one beat
//   node make-mask.js --src draft.mp4 --out mask.mp4 --box 0.4,0.5,0.4,0.4 --window 6.0,7.2
//
// Flags:
//   --box cx,cy,w,h        white rectangle, centered at (cx,cy), size (w,h)   [fractions]
//   --ellipse cx,cy,rx,ry  white ellipse, centered at (cx,cy), radii (rx,ry)  [fractions]
//   (omit both -> full-frame white)
//   --window start,end     white only within [start,end] seconds; black elsewhere
//   --feather <px>         gaussian-blur the mask edge by N px (VACE likes soft edges)
//   --invert               swap white/black
//   --dry-run              print the ffmpeg command and exit

import { spawn } from 'node:child_process';
import path from 'node:path';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else { out._.push(a); }
  }
  return out;
}

const nums = (s, n, label) => {
  const parts = String(s).split(',').map((x) => Number(x.trim()));
  if (parts.length !== n || parts.some((x) => Number.isNaN(x))) {
    console.error(`error: --${label} expects ${n} comma-separated numbers, got "${s}"`);
    process.exit(2);
  }
  return parts;
};

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

const args = parseArgs(process.argv.slice(2));
const src = args.src && args.src !== true ? String(args.src) : null;
const out = args.out && args.out !== true ? String(args.out) : null;
if (!src || !out) {
  console.error('usage: node make-mask.js --src <video> --out <mask.mp4> [--box cx,cy,w,h | --ellipse cx,cy,rx,ry] [--window s,e] [--feather px] [--invert]');
  process.exit(2);
}

// The source drives geometry (iw/ih), fps and duration: we filter the source
// itself, overwriting every pixel, so the mask is frame-for-frame aligned.
// White fill: start from the luma plane, force it to a flat value per region.
const filters = [];

// 1) region: build a white shape on black. drawbox for rects; geq for ellipse.
const box = args.box && args.box !== true ? nums(args.box, 4, 'box') : null;
const ellipse = args.ellipse && args.ellipse !== true ? nums(args.ellipse, 4, 'ellipse') : null;

// Force to gray, then paint. Base black via drawbox full-frame.
filters.push('format=gray');
filters.push('drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill');

if (box) {
  const [cx, cy, w, h] = box;
  const x = `(iw*${cx} - iw*${w}/2)`;
  const y = `(ih*${cy} - ih*${h}/2)`;
  filters.push(`drawbox=x=${x}:y=${y}:w=iw*${w}:h=ih*${h}:color=white:t=fill`);
} else if (ellipse) {
  const [cx, cy, rx, ry] = ellipse;
  // geq: white where the normalized ellipse equation <= 1.
  const eq = `pow((X-iw*${cx})/(iw*${rx}),2)+pow((Y-ih*${cy})/(ih*${ry}),2)`;
  filters.push(`geq=lum='if(lte(${eq},1),255,0)'`);
} else {
  // no region -> full-frame white
  filters.push('drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill');
}

// 2) feather the edge (soft masks composite better under VACE).
if (args.feather && args.feather !== true) {
  filters.push(`gblur=sigma=${Number(args.feather)}`);
}

// 3) invert if asked.
if (args.invert) filters.push('lut=y=negval');

// 4) time-gate: black outside [start,end]. Done last so the window wins.
if (args.window && args.window !== true) {
  const [s, e] = nums(args.window, 2, 'window');
  // Blend the shaped mask with pure black, selecting black outside the window.
  // Simplest robust form: drawbox full-frame black enabled outside the window.
  filters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='not(between(t,${s},${e}))'`);
}

// grayscale mask, but encode as yuv420p so every player/decoder (and fal) accepts it.
filters.push('format=yuv420p');

const vf = filters.join(',');
const ff = ['-y', '-i', src, '-vf', vf, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-an', out];

if (args['dry-run']) {
  console.log(`[dry-run] ffmpeg ${ff.map((a) => (a.includes(' ') || a.includes(',') ? `'${a}'` : a)).join(' ')}`);
  process.exit(0);
}

await mkdirp(path.dirname(out));
console.log(`building mask -> ${out}`);
await run('ffmpeg', ff);
console.log('done.');

async function mkdirp(dir) {
  const { mkdir } = await import('node:fs/promises');
  if (dir && dir !== '.') await mkdir(dir, { recursive: true });
}
