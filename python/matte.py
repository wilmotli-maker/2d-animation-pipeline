#!/usr/bin/env python3
"""Per-frame BiRefNet-DIS matte for a finalized shot -> RGBA video.

Invoked by src/matte.js, not directly by users. Frames stream in from an ffmpeg
decoder and RGBA streams out to an ffmpeg encoder, so a 121-frame clip never
lands on disk as loose images. One JSON report goes to stdout; all progress and
diagnostics go to stderr, which keeps stdout parseable by the Node side.

Why BiRefNet-DIS: it recovers a 4 px antenna with 0.996 spine alpha and roughly
half the edge-ramp width of five alternatives. See docs/plans/shot-matte-alpha.md.

Scope note: this stage emits STRAIGHT alpha over the source RGB. Edge pixels are
still colour-contaminated by the plate (75-99% of them carry green on the ArtAI
corpus) because that contamination is baked into the source and cannot be
undone by a matte. Despill is a separate stage.
"""
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image

# BiRefNet's fixed input geometry and the ImageNet normalization it was trained
# with. These must match what the model expects exactly; they are not tunable.
NET_SIZE = 1024
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def probe(path):
    """Width, height, frame rate and frame count of the source clip."""
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
         'stream=width,height,r_frame_rate,nb_frames', '-of', 'json', path],
        capture_output=True, text=True, check=True).stdout
    s = json.loads(out)['streams'][0]
    num, den = (s['r_frame_rate'].split('/') + ['1'])[:2]
    fps = float(num) / float(den or 1)
    try:
        frames = int(s.get('nb_frames'))
    except (TypeError, ValueError):
        frames = 0  # some containers omit it; progress just goes unbounded
    return int(s['width']), int(s['height']), fps, frames


def encoder_args(fmt, width, height, fps, output, source):
    """ffmpeg args to turn a raw RGBA stream into the requested container."""
    common = [
        'ffmpeg', '-v', 'error', '-y',
        '-f', 'rawvideo', '-pix_fmt', 'rgba',
        '-s', f'{width}x{height}', '-r', f'{fps}', '-i', 'pipe:0',
        # Second input carries the source's audio, if it has any. Seedance shots
        # often do, and losing it here would force a re-mux downstream.
        '-i', source, '-map', '0:v:0', '-map', '1:a:0?', '-c:a', 'copy',
    ]
    if fmt == 'prores4444':
        # 4444 keeps a full-resolution alpha plane; -alpha_bits 16 keeps it from
        # being quantized to where soft edges band. Note prores_ks promotes the
        # result to yuva444p12le regardless of the 10le request — more alpha
        # precision than asked for, which is harmless, but the probed pix_fmt
        # will not match this flag.
        return common + ['-c:v', 'prores_ks', '-profile:v', '4444',
                         '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', output]
    if fmt == 'webm':
        return common + ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
                         '-auto-alt-ref', '0', output]
    if fmt == 'png':
        # A sequence has no audio track; drop the second input entirely.
        return [
            'ffmpeg', '-v', 'error', '-y',
            '-f', 'rawvideo', '-pix_fmt', 'rgba',
            '-s', f'{width}x{height}', '-r', f'{fps}', '-i', 'pipe:0',
            os.path.join(output, '%05d.png'),
        ]
    raise SystemExit(f'unknown format: {fmt}')


def make_session(model, providers):
    import onnxruntime as ort
    avail = ort.get_available_providers()
    chosen = [p for p in providers if p in avail] or ['CPUExecutionProvider']
    log(f'onnxruntime providers: {chosen}')
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    return ort.InferenceSession(model, sess_options=opts, providers=chosen)


def alpha_for(session, frame, size):
    """Alpha plane for one RGB frame, resized back to the source geometry.

    Mirrors rembg's BiRefNet session step for step. Two details are load-bearing
    and both were learned the hard way:

      * The network emits LOGITS. They must go through a sigmoid before the
        min-max rescale. Skipping it rescales a near-linear range instead of a
        saturated one, which yields a smooth gradient rather than a mask —
        measured 97% of pixels neither opaque nor transparent, and a coverage of
        0.010 where the correct answer is 0.259.
      * Input scaling divides by the frame's own max, not by 255. Identical
        whenever some pixel hits 255, which is why it is easy to miss.
    """
    small = Image.fromarray(frame).resize((NET_SIZE, NET_SIZE), Image.LANCZOS)
    ary = np.asarray(small, dtype=np.float32)
    ary = ary / max(float(ary.max()), 1e-6)
    x = np.ascontiguousarray(((ary - MEAN) / STD).transpose(2, 0, 1)[None])

    logits = session.run(None, {session.get_inputs()[0].name: x})[0][:, 0, :, :]
    pred = 1.0 / (1.0 + np.exp(-logits))
    lo, hi = float(pred.min()), float(pred.max())
    # Per-frame min-max is what the reference does, and the bake-off numbers were
    # measured with it. It is also a temporal-flicker hazard: the same true alpha
    # maps to different outputs when a frame's range shifts. Deliberately left
    # alone here; the temporal stage owns it.
    pred = (pred - lo) / (hi - lo) if hi > lo else np.zeros_like(pred)
    a = (np.squeeze(pred) * 255.0).astype(np.uint8)
    return np.asarray(Image.fromarray(a, 'L').resize(size, Image.LANCZOS))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--format', default='prores4444')
    # CPU by default, deliberately. CoreML looks attractive on Apple silicon but
    # converting this ~930 MB graph wedges: measured 9.6 GB RSS and zero CPU
    # progress after 10 minutes, having spawned no decoder. CPU loads in 1.4 s and
    # runs ~4.4 s/frame. Opt in with --providers if you want to retest CoreML.
    ap.add_argument('--providers', default='CPUExecutionProvider')
    args = ap.parse_args()

    width, height, fps, expected = probe(args.input)
    log(f'{os.path.basename(args.input)}: {width}x{height} @ {fps:.3f}fps, {expected or "?"} frames')

    session = make_session(args.model, args.providers.split(','))

    dec = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-i', args.input, '-f', 'rawvideo',
         '-pix_fmt', 'rgb24', 'pipe:1'],
        stdout=subprocess.PIPE)
    enc = subprocess.Popen(
        encoder_args(args.format, width, height, fps, args.output, args.input),
        stdin=subprocess.PIPE)

    frame_bytes = width * height * 3
    count, started = 0, time.time()
    coverage = []
    soft = []
    try:
        while True:
            buf = dec.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, np.uint8).reshape(height, width, 3)
            a = alpha_for(session, frame, (width, height))
            enc.stdin.write(np.dstack([frame, a]).tobytes())
            coverage.append(float((a > 127).mean()))
            soft.append(float(((a > 13) & (a < 242)).mean()))
            count += 1
            if count % 10 == 0:
                log(f'  {count}/{expected or "?"} frames')
    finally:
        if dec.stdout:
            dec.stdout.close()
        if enc.stdin:
            enc.stdin.close()
        dec.wait()
        enc.wait()

    if count == 0:
        raise SystemExit(f'decoded no frames from {args.input}')
    if enc.returncode != 0:
        raise SystemExit(f'ffmpeg encode failed (exit {enc.returncode})')

    # A correct matte is mostly decided: opaque subject, transparent plate, with
    # soft pixels confined to the silhouette edge (~1% on the reference corpus).
    # A mostly-soft result means the alpha is a gradient rather than a mask —
    # the signature of a broken post-process, which otherwise writes a plausible
    # multi-hundred-MB file and exits 0. Refuse to pass that off as success.
    mean_soft = float(np.mean(soft))
    if mean_soft > 0.5:
        raise SystemExit(
            f'degenerate matte: {mean_soft:.1%} of pixels are partially transparent '
            f'(expected well under 10%). The alpha is a gradient, not a mask — '
            f'check the model post-process before trusting {args.output}.')

    elapsed = time.time() - started
    print(json.dumps({
        'frames': count,
        'width': width,
        'height': height,
        'fps': round(fps, 3),
        'seconds': round(elapsed, 1),
        'secondsPerFrame': round(elapsed / count, 3),
        'meanCoverage': round(float(np.mean(coverage)), 4),
        'minCoverage': round(float(np.min(coverage)), 4),
        'maxCoverage': round(float(np.max(coverage)), 4),
        'meanSoftFraction': round(mean_soft, 4),
    }))


if __name__ == '__main__':
    main()
