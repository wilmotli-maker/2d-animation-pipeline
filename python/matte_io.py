#!/usr/bin/env python3
"""Shared streaming I/O for the matte sidecars (python/matte.py, python/plate_matte.py).

Every matte method is the same shape: probe the clip, then stream frames from an
ffmpeg rgb24 decoder, turn each into RGBA, and stream that to an ffmpeg encoder,
never landing loose frames on disk. Output is written to a sibling temp path and
only moved into place once the whole clip has passed its invariants, so a rejected
matte never leaves a plausible-but-wrong file behind.

This module owns that machinery so the methods differ only in their per-frame
`process(frame_bgr, i) -> (F_rgb, alpha)` — not in ffmpeg wiring, temp-then-replace,
or the degenerate-output guard. Extracted verbatim from the two sidecars; the
success path is byte-identical to what each produced inline (golden-tested).
"""
import json, os, shutil, subprocess, sys, time

import numpy as np


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# --- method-agnostic quality warnings ---------------------------------------
# Two statistics flag a suspicious matte regardless of how it was generated (ml,
# chroma, or keylight): the whole-clip mean coverage (average alpha) and the mean
# soft-pixel fraction (share of partially-transparent pixels). Unlike the despill
# invariants in python/matte.py, neither can *prove* a matte is wrong — a subject
# entering/leaving frame legitimately drives coverage toward 0, one filling the
# frame drives it toward 1, and a genuinely translucent subject raises the soft
# fraction. So these WARN (the file is still written) rather than reject.
#
# Defaults are derived from the accepted matte corpus (evaluation/, measured
# 2026-09-16):
#   ml (26 known-good clips)  meanCoverage 0.24-0.27   meanSoftFraction 0.008-0.016
#   plate chroma+closed-form  meanCoverage 0.26-0.27   meanSoftFraction 0.03-0.04
#   plate keylight (raw)      meanCoverage 0.25-0.43   meanSoftFraction 0.20-0.22
# Coverage: the good clips cluster near 0.25 but that is one genre (centred
# subject); legit shots run wider (robot keylight measured meanCoverage 0.43). The
# two bounds are deliberately ASYMMETRIC. Low is very forgiving (0.02): a subject
# entering/leaving frame drives coverage toward 0, so near-empty clips are common
# and usually legitimate. High is tighter (0.85, ~2x the observed good envelope):
# "almost nothing was keyed out" is a strong smell — a wrong --screen-colour on the
# bluescreen clip measured 0.87 here — though a subject that truly fills the frame
# can also reach it, which is why it warns rather than rejects.
# Soft: raw keylight is INHERENTLY soft (~0.22 — its edge is partial coverage, no
# hard trimap), so the bound must clear that with margin; 0.40 sits above every
# good clip yet below the ~0.5 "alpha is a gradient, not a mask" failure regime.
COVERAGE_WARN_LO = 0.02
COVERAGE_WARN_HI = 0.85
SOFT_WARN_HI = 0.40


def coverage_warnings(mean_cov, mean_soft, *,
                      cov_lo=COVERAGE_WARN_LO, cov_hi=COVERAGE_WARN_HI,
                      soft_hi=SOFT_WARN_HI):
    """Build human-readable warnings for a finished matte's whole-clip stats.

    Returns a list of strings (empty when nothing is suspect). Pure and
    side-effect-free so both sidecars share one definition and it is unit-testable.
    """
    warns = []
    if mean_cov < cov_lo:
        warns.append(
            f'low coverage: only {mean_cov:.1%} of the average frame is opaque — the '
            'subject may be keyed out (check the plate colour / clip levels). This is '
            'expected if the subject is absent from most frames.')
    elif mean_cov > cov_hi:
        warns.append(
            f'high coverage: {mean_cov:.1%} of the average frame is opaque — little was '
            'keyed out. This is expected if the subject fills the frame.')
    if mean_soft > soft_hi:
        warns.append(
            f'high soft-pixel fraction: {mean_soft:.1%} of pixels are partially '
            'transparent (good mattes are a few percent). The edge may be too soft, or '
            'the alpha a gradient rather than a mask — unless the subject is translucent.')
    return warns


def probe(path, count_frames=True):
    """Width, height, fps, frame count. count_frames counts exactly (accurate but
    slower); the ml sidecar historically read the container's nb_frames instead."""
    entries = 'stream=width,height,avg_frame_rate,nb_read_frames' if count_frames \
        else 'stream=width,height,r_frame_rate,nb_frames'
    cmd = ['ffprobe', '-v', 'error', '-select_streams', 'v:0']
    if count_frames:
        cmd += ['-count_frames']
    cmd += ['-show_entries', entries, '-of', 'json', path]
    s = json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout)['streams'][0]
    rate = s.get('avg_frame_rate') or s.get('r_frame_rate') or '0/1'
    num, den = (rate.split('/') + ['1'])[:2]
    fps = float(num) / float(den) if float(den or 0) else 24.0
    frames = int(s.get('nb_read_frames') or s.get('nb_frames') or 0)
    return int(s['width']), int(s['height']), fps, frames


def encoder_args(fmt, w, h, fps, output, source):
    """ffmpeg args to turn a raw RGBA stream into the requested container. The
    second input carries the source's audio when it has any (Seedance shots do)."""
    common = ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
              '-s', f'{w}x{h}', '-r', f'{fps}', '-i', 'pipe:0',
              '-i', source, '-map', '0:v:0', '-map', '1:a:0?', '-c:a', 'copy']
    if fmt == 'prores4444':
        return common + ['-c:v', 'prores_ks', '-profile:v', '4444',
                         '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', output]
    if fmt == 'webm':
        return common + ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', output]
    if fmt == 'png':
        # A sequence has no audio track; drop the second input entirely.
        return ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
                '-s', f'{w}x{h}', '-r', f'{fps}', '-i', 'pipe:0', os.path.join(output, '%05d.png')]
    raise SystemExit(f'unknown format: {fmt}')


def _remove(p):
    if os.path.isdir(p):
        shutil.rmtree(p, ignore_errors=True)
    elif os.path.exists(p):
        try:
            os.remove(p)
        except OSError:
            pass


def reject(tmp, msg):
    """Discard the partial output and fail loudly. Encoding finishes before the
    result can be checked, so a rejected matte has already been written; removing
    it is what makes the invariants meaningful."""
    _remove(tmp)
    raise SystemExit(msg)


def finalize(tmp, dest):
    """Move the validated artifact into place, replacing any previous one (which
    may be a directory when switching from a png sequence to a single file)."""
    _remove(dest)
    os.replace(tmp, dest)


def temp_path(output, fmt):
    """Sibling temp path to encode into. For a png sequence the output IS a folder,
    so there is no separate temp — it is written in place."""
    if fmt == 'png':
        return output
    root, ext = os.path.splitext(output)
    return f'{root}.tmp{ext}'


def run_stream(input, output, fmt, w, h, fps, n, process,
               *, on_frame=None, on_done=None):
    """Decode -> process -> encode the whole clip, then temp-then-replace.

    process(frame_bgr, i) -> (F_rgb, alpha): F_rgb float [0,1] HxWx3, alpha HxW.
    on_frame(i, alpha): optional per-frame stats hook (e.g. soft-fraction).
    on_done(frames, mean_cov, tmp): optional guard, called before the file is moved
        into place; it may call reject(tmp, ...) to discard a degenerate result.

    Returns (frames, mean_cov, mean_soft, elapsed_seconds), where mean_soft is the
    whole-clip mean fraction of partially-transparent (0.05 < alpha < 0.95) pixels.
    """
    tmp = temp_path(output, fmt)
    if fmt == 'png':
        os.makedirs(tmp, exist_ok=True)
    dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', input, '-f', 'rawvideo',
                            '-pix_fmt', 'rgb24', 'pipe:1'], stdout=subprocess.PIPE)
    enc = subprocess.Popen(encoder_args(fmt, w, h, fps, tmp, input), stdin=subprocess.PIPE)
    fsz = w * h * 3
    i = 0
    cov = 0.0
    soft = 0.0
    t0 = time.time()
    try:
        while True:
            buf = dec.stdout.read(fsz)
            if not buf or len(buf) < fsz:
                break
            bgr = np.frombuffer(buf, np.uint8).reshape(h, w, 3)[..., ::-1].astype(np.float32) / 255.0
            F, alpha = process(bgr, i)
            rgba = np.dstack([F * 255, np.clip(alpha, 0, 1) * 255]).astype(np.uint8)
            try:
                enc.stdin.write(rgba.tobytes())
            except BrokenPipeError:
                enc.wait()
                reject(tmp, f'ffmpeg encoder exited early (code {enc.returncode}) after '
                            f'{i} frames — see its error above')
            ca = np.clip(alpha, 0, 1)
            cov += float(ca.mean())
            soft += float(((ca > 0.05) & (ca < 0.95)).mean())
            if on_frame is not None:
                on_frame(i, alpha)
            i += 1
            if i % 20 == 0:
                log(f'  {i}/{n} frames')
    finally:
        if dec.stdout:
            dec.stdout.close()
        if enc.stdin:
            enc.stdin.close()
        dec.wait()
        enc.wait()

    if i == 0:
        reject(tmp, f'decoded no frames from {input}')
    if enc.returncode != 0:
        reject(tmp, f'ffmpeg encode failed (exit {enc.returncode})')

    mean_cov = cov / max(i, 1)
    mean_soft = soft / max(i, 1)
    if on_done is not None:
        on_done(i, mean_cov, tmp)
    if fmt != 'png':
        os.replace(tmp, output)
    return i, mean_cov, mean_soft, time.time() - t0
