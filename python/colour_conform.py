#!/usr/bin/env python3
"""Colour-conform a generated clip toward a source reference (Reinhard LAB mean/std transfer).

The edit-ui generation sometimes drifts slightly in colour/exposure from the source it will be
spliced into, which shows at the seam. This maps each frame's LAB statistics toward the source's:

    out = (gen_lab - gen_mean) * (src_std / gen_std) + src_mean      (per L,a,b channel)

blended by --strength (0 = unchanged, 1 = full match). Statistics are pooled over sampled frames of
each clip, so the correction is a single global transform (no per-frame flicker). Frame count and fps
are preserved and the input's audio is copied through, so the result stays splice-compatible.

Prints a one-line JSON report (frames + before/after LAB mean drift) on the last stdout line.

    colour_conform.py --input gen.mp4 --reference source-span.mp4 --out conformed.mp4 [--strength 1.0]
"""
import argparse, json, subprocess
import cv2
import numpy as np


def sampled_lab_stats(path, n=12):
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    idxs = range(total) if total <= n else [round(i * (total - 1) / (n - 1)) for i in range(n)]
    means, stds = [], []
    for i in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, f = cap.read()
        if not ok:
            continue
        lab = cv2.cvtColor(f, cv2.COLOR_BGR2LAB).astype(np.float32)
        means.append([lab[..., c].mean() for c in range(3)])
        stds.append([lab[..., c].std() for c in range(3)])
    cap.release()
    if not means:
        raise SystemExit(f"colour_conform: could not read frames from {path}")
    return np.array(means).mean(0), np.array(stds).mean(0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--reference", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--strength", type=float, default=1.0)
    ap.add_argument("--min-drift", type=float, default=1.0,
                    help="skip (pass through unchanged) when the LAB mean drift is below this; the "
                         "decode/encode round trip is ~0.5 LAB, so correcting a smaller drift adds "
                         "more noise than it removes")
    a = ap.parse_args()
    strength = max(0.0, min(1.0, a.strength))

    g_mean, g_std = sampled_lab_stats(a.input)
    s_mean, s_std = sampled_lab_stats(a.reference)
    drift = float(np.abs(g_mean - s_mean).mean())
    if drift < a.min_drift:
        # Already matched within the round-trip floor: copy through untouched rather than add noise.
        r = subprocess.run(["ffmpeg", "-y", "-i", a.input, "-c", "copy", a.out], capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit(f"colour_conform: pass-through copy failed: {r.stderr[-400:]}")
        print(json.dumps({"skipped": True, "driftBefore": round(drift, 3), "minDrift": a.min_drift}))
        return
    # Per-channel gain toward the source spread; full gain scaled by strength, guarding /0.
    gain = np.where(g_std > 1e-3, s_std / g_std, 1.0)
    gain = 1.0 + strength * (gain - 1.0)
    shift_to = g_mean + strength * (s_mean - g_mean)
    before = drift

    cap = cv2.VideoCapture(a.input)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # Pipe raw BGR frames straight into a single H.264 encode — no lossy intermediate codec, which
    # would shift colours more than the correction itself. Carry the input's audio through.
    has_audio = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name",
         "-of", "csv=p=0", a.input], capture_output=True, text=True).stdout.strip()
    cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-"]
    if has_audio:
        cmd += ["-i", a.input, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-shortest"]
    # Keep full (PC) range end to end: the BGR frames are full-range, and OpenCV reads YUV back as
    # full-range, so encoding limited-range (ffmpeg's default) would darken everything ~1-2 LAB and
    # defeat the match. Force full range on the scale and tag the stream accordingly.
    cmd += ["-vf", "scale=in_range=full:out_range=full", "-color_range", "pc",
            "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", a.out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    frames = 0
    post_sum = np.zeros(3)
    while True:
        ok, f = cap.read()
        if not ok:
            break
        lab = cv2.cvtColor(f, cv2.COLOR_BGR2LAB).astype(np.float32)
        for c in range(3):
            lab[..., c] = (lab[..., c] - g_mean[c]) * gain[c] + shift_to[c]
        lab = np.clip(lab, 0, 255).astype(np.uint8)
        out = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
        pl = cv2.cvtColor(out, cv2.COLOR_BGR2LAB).astype(np.float32)
        post_sum += [pl[..., c].mean() for c in range(3)]
        proc.stdin.write(np.ascontiguousarray(out).tobytes())
        frames += 1
    cap.release()
    proc.stdin.close()
    err = proc.stderr.read().decode(errors="ignore")
    if proc.wait() != 0:
        raise SystemExit(f"colour_conform: ffmpeg encode failed: {err[-400:]}")

    after = float(np.abs(post_sum / frames - s_mean).mean()) if frames else None
    print(json.dumps({"frames": frames, "strength": strength,
                      "driftBefore": round(before, 3),
                      "driftAfter": round(after, 3) if after is not None else None}))


if __name__ == "__main__":
    main()
