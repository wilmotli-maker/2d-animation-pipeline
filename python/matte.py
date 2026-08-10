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
import shutil
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


def estimate_plate(frame, alpha, block=16, min_samples=8):
    """Spatially varying plate colour, sampled only where the matte says background.

    A single per-frame median would do for a genuinely flat plate. These are not
    flat: they carry gradients and localized dark streaks — one measured frame
    reads RGB(1,80,15) against a (94,196,108) plate. Estimating on a coarse grid
    and smoothing tracks real variation without letting one streak contaminate
    the whole frame, and sampling by alpha (rather than by a border ring) means
    the character is never mistaken for plate.
    """
    from scipy import ndimage as ndi

    h, w, _ = frame.shape
    bg = alpha < 0.02
    ph, pw = (-h) % block, (-w) % block
    f = np.pad(frame, ((0, ph), (0, pw), (0, 0)))
    m = np.pad(bg, ((0, ph), (0, pw)))
    gh, gw = (h + ph) // block, (w + pw) // block

    counts = m.reshape(gh, block, gw, block).sum((1, 3))
    sums = (f * m[..., None]).reshape(gh, block, gw, block, 3).sum((1, 3))
    valid = counts >= min_samples
    if not valid.any():
        # A frame with no background at all can't be despilled from its own
        # content; leave the plate estimate neutral so despill is a no-op.
        return np.zeros_like(frame)

    coarse = np.zeros((gh, gw, 3), np.float32)
    coarse[valid] = sums[valid] / counts[valid][:, None]
    # Cells with no background sample (fully covered by the character) borrow
    # from the nearest cell that has one.
    idx = ndi.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    coarse = coarse[idx[0], idx[1]]
    coarse = ndi.uniform_filter(coarse, size=(3, 3, 1))

    up = np.stack([
        np.asarray(Image.fromarray(coarse[:, :, c]).resize((w + pw, h + ph), Image.BILINEAR))
        for c in range(3)
    ], axis=-1)
    return up[:h, :w]


def despill(frame, alpha, plate, floor=0.15, bg_thresh=0.02):
    """Recover true foreground colour by inverting the compositing equation.

    Every edge pixel is C = a*F + (1-a)*B for plate colour B, so F = (C - (1-a)B)/a
    removes the plate's contribution exactly. Two properties matter more than the
    arithmetic:

      * At a == 1 this reduces to the identity. Fully opaque pixels — in-design
        greens like AI2's chest cross, and the spine of every thin structure —
        are untouched BY CONSTRUCTION, not by a radius heuristic that has to be
        tuned and can be wrong.
      * It is driven by the alpha we already computed, so it needs no hue
        assumptions and cannot mistake a green costume for spill.

    Below `floor` the division is numerically unstable, so it is clamped; those
    pixels are under 15% opaque and contribute almost nothing to a composite.

    Pixels the matte calls pure background are left untouched. Their colour is
    multiplied away by any correct compositor, but running the inverse there
    divides the plate's own noise by the 0.15 floor — measured std 8 -> 17 across
    73.7% of the frame, turning a flat plate into amplified noise. Invisible in a
    composite, plainly wrong in the file, and worth +70% on disk (140 MB -> 239 MB).
    """
    a = alpha[..., None]
    f = np.clip((frame - (1.0 - a) * plate) / np.maximum(a, floor), 0.0, 255.0)
    return np.where(a < bg_thresh, frame, f)


def green_fraction(rgb, mask):
    """Share of masked pixels that read as saturated green — the spill metric."""
    if not mask.any():
        return 0.0
    px = rgb[mask]
    mx = px.max(1)
    mn = px.min(1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    return float(((px[:, 1] >= mx) & (sat > 0.15)).mean())


def edge_mask(alpha):
    """Transition band plus the 2 px of near-opaque pixels just inside it."""
    from scipy import ndimage as ndi
    soft = (alpha > 0.05) & (alpha < 0.95)
    return ndi.binary_dilation(soft, iterations=2) & (alpha > 0.02)


def _remove(p):
    if os.path.isdir(p):
        shutil.rmtree(p, ignore_errors=True)
    elif os.path.exists(p):
        try:
            os.remove(p)
        except OSError:
            pass


def reject(tmp, msg):
    """Fail loudly AND leave nothing behind.

    Encoding finishes before the output can be checked, so a rejected matte has
    already been written. Discarding the partial is what makes the invariants
    meaningful: without it a failed run still leaves a plausible file on disk
    that a later step — or a person — could pick up as if it were good.
    """
    _remove(tmp)
    raise SystemExit(msg)


def finalize(tmp, dest):
    """Move the validated artifact into place, replacing any previous one."""
    _remove(dest)
    os.replace(tmp, dest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--format', default='prores4444')
    ap.add_argument('--despill', default='true', choices=['true', 'false'])
    # CPU by default, deliberately. CoreML looks attractive on Apple silicon but
    # converting this ~930 MB graph wedges: measured 9.6 GB RSS and zero CPU
    # progress after 10 minutes, having spawned no decoder. CPU loads in 1.4 s and
    # runs ~4.4 s/frame. Opt in with --providers if you want to retest CoreML.
    ap.add_argument('--providers', default='CPUExecutionProvider')
    args = ap.parse_args()

    width, height, fps, expected = probe(args.input)
    log(f'{os.path.basename(args.input)}: {width}x{height} @ {fps:.3f}fps, {expected or "?"} frames')

    session = make_session(args.model, args.providers.split(','))

    # Encode to a sibling temp path and only move it into place once every
    # invariant below has passed, so a rejected matte never reaches args.output.
    # Keep the real extension last — ffmpeg picks its muxer from it, and
    # "alpha.mov.partial" leaves it with nothing to go on.
    _root, _ext = os.path.splitext(args.output)
    out_tmp = f'{_root}.partial{_ext}'
    _remove(out_tmp)
    if args.format == 'png':
        os.makedirs(out_tmp, exist_ok=True)

    dec = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-i', args.input, '-f', 'rawvideo',
         '-pix_fmt', 'rgb24', 'pipe:1'],
        stdout=subprocess.PIPE)
    enc = subprocess.Popen(
        encoder_args(args.format, width, height, fps, out_tmp, args.input),
        stdin=subprocess.PIPE)

    do_despill = args.despill == 'true'
    frame_bytes = width * height * 3
    count, started = 0, time.time()
    coverage = []
    soft = []
    green_before, green_after, interior_drift = [], [], []
    try:
        while True:
            buf = dec.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, np.uint8).reshape(height, width, 3)
            a = alpha_for(session, frame, (width, height))

            rgb = frame
            if do_despill:
                src = frame.astype(np.float32)
                af = a.astype(np.float32) / 255.0
                edge = edge_mask(af)
                plate = estimate_plate(src, af)
                clean = despill(src, af, plate)
                green_before.append(green_fraction(src, edge))
                green_after.append(green_fraction(clean, edge))
                # Fully opaque pixels must come through bit-identical — that is
                # the whole safety argument for in-design green, so verify it
                # rather than assume it. Test at a == 1 exactly, where the
                # compositing equation reduces to the identity: pixels at
                # a == 0.99 legitimately move ~1.4/255, so a loose threshold here
                # would assert nothing.
                opaque = a == 255
                if opaque.any():
                    interior_drift.append(float(np.abs(clean - src)[opaque].max()))
                rgb = clean.astype(np.uint8)

            try:
                enc.stdin.write(np.dstack([rgb, a]).tobytes())
            except BrokenPipeError:
                # The encoder died mid-stream; its own stderr already explains
                # why. Surface that plainly instead of a write traceback.
                enc.wait()
                reject(out_tmp,
                       f'ffmpeg encoder exited early (code {enc.returncode}) after '
                       f'{count} frames — see its error above')
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

    elapsed = time.time() - started
    if count == 0:
        reject(out_tmp, f'decoded no frames from {args.input}')
    if enc.returncode != 0:
        reject(out_tmp, f'ffmpeg encode failed (exit {enc.returncode})')

    # A correct matte is mostly decided: opaque subject, transparent plate, with
    # soft pixels confined to the silhouette edge (~1% on the reference corpus).
    # A mostly-soft result means the alpha is a gradient rather than a mask —
    # the signature of a broken post-process, which otherwise writes a plausible
    # multi-hundred-MB file and exits 0. Refuse to pass that off as success.
    mean_soft = float(np.mean(soft))
    if mean_soft > 0.5:
        reject(out_tmp,
               f'degenerate matte: {mean_soft:.1%} of pixels are partially transparent '
               f'(expected well under 10%). The alpha is a gradient, not a mask — '
               f'check the model post-process.')

    report = {
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
        'despill': do_despill,
    }

    if do_despill and green_before:
        before = float(np.mean(green_before))
        after = float(np.mean(green_after))
        drift = float(np.max(interior_drift)) if interior_drift else 0.0
        # Same principle as the soft-pixel check: this stage asserts something
        # about its own output rather than trusting a clean exit. Despill that
        # fails to reduce edge spill has misestimated the plate, and despill that
        # moves opaque pixels has broken the guarantee that protects in-design
        # green — both would otherwise ship a large, plausible, wrong file.
        if after >= before:
            reject(out_tmp,
                   f'despill did not reduce edge spill ({before:.1%} -> {after:.1%}); '
                   'the plate estimate is probably wrong — refusing to write a worse matte')
        if drift > 0.01:
            reject(out_tmp,
                   f'despill moved fully-opaque pixels by up to {drift:.3f}/255 — it must be '
                   'an exact identity there, or in-design colours are being altered')
        report.update({
            'edgeGreenBefore': round(before, 4),
            'edgeGreenAfter': round(after, 4),
            'maxOpaqueDrift': round(drift, 3),
        })

    finalize(out_tmp, args.output)
    print(json.dumps(report))


if __name__ == '__main__':
    main()
