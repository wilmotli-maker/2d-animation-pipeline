#!/usr/bin/env python3
"""Dense optical-flow seam morph for the edit-ui splice (see src/edit-ui/flow-morph.js).

Joins two already-rendered segment clips that meet at a seam by inserting N transition frames that
warp one side's boundary frame into the other's along the computed optical flow. Unlike ffmpeg's
minterpolate (block motion -> halos) or a cross-dissolve (ghosting), the one-sided modes are a pure
geometry ramp that keeps one side's pixels, so the GEN footage can stay pristine.

Output length matches the minterpolate joiner exactly: (len(left)-1) + N + (len(right)-1). The left
boundary frame and right boundary frame are consumed as morph endpoints, not emitted directly.

Modes:
  one-sided-left  warp left's last frame toward right's first (left is the source head)
  one-sided-right warp right's first frame back toward left's last (right is the source tail)
  balanced        split the warp across both sides with a cross-dissolve
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np


def read_frames(path):
    cap = cv2.VideoCapture(str(path))
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    cap.release()
    if not frames:
        sys.exit(f"flow_morph: no frames read from {path}")
    return frames


def compute_flow(a, b, engine):
    ga = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
    gb = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    if engine == "dis":
        dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
        return dis.calc(ga, gb, None)
    return cv2.calcOpticalFlowFarneback(ga, gb, None, 0.5, 4, 31, 3, 7, 1.5, 0)


def warp(img, flow, frac, grid):
    """Move img's content by frac*flow via backward sampling."""
    gx, gy = grid
    mx = (gx - frac * flow[..., 0]).astype(np.float32)
    my = (gy - frac * flow[..., 1]).astype(np.float32)
    return cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def morph_frames(left, right, n, mode, engine):
    left_last, right_first = left[-1], right[0]
    h, w = left_last.shape[:2]
    grid = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    out = []
    if mode == "balanced":
        fl_lr = compute_flow(left_last, right_first, engine)
        fl_rl = compute_flow(right_first, left_last, engine)
        for k in range(1, n + 1):
            t = k / (n + 1)
            a = warp(left_last, fl_lr, t, grid)
            b = warp(right_first, fl_rl, 1 - t, grid)
            out.append(cv2.addWeighted(a, 1 - t, b, t, 0))
    elif mode == "one-sided-left":
        fl_lr = compute_flow(left_last, right_first, engine)
        for k in range(1, n + 1):
            out.append(warp(left_last, fl_lr, k / (n + 1), grid))
    elif mode == "one-sided-right":
        fl_rl = compute_flow(right_first, left_last, engine)
        for k in range(1, n + 1):
            # k=1 -> warp right almost fully onto left geometry (continuous with left_last);
            # k=n -> nearly native right.
            out.append(warp(right_first, fl_rl, 1 - k / (n + 1), grid))
    else:
        sys.exit(f"flow_morph: unknown mode {mode}")
    return out


def encode(frames, out_path, fps):
    with tempfile.TemporaryDirectory() as tmp:
        for i, f in enumerate(frames):
            cv2.imwrite(f"{tmp}/{i:06d}.png", f)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-framerate", str(fps), "-i", f"{tmp}/%06d.png",
             "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", str(out_path)],
            check=True,
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--left", required=True)
    ap.add_argument("--right", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--frames", type=int, required=True)
    ap.add_argument("--fps", type=float, required=True)
    ap.add_argument("--mode", default="one-sided-left")
    ap.add_argument("--flow", default="farneback", choices=["farneback", "dis"])
    a = ap.parse_args()

    left, right = read_frames(a.left), read_frames(a.right)
    morph = morph_frames(left, right, a.frames, a.mode, a.flow)
    # left[:-1] + morph + right[1:] — endpoints consumed by the morph (parity with minterpolate join).
    seq = left[:-1] + morph + right[1:]
    encode(seq, a.out, a.fps)
    print(json.dumps({"frames": len(seq), "mode": a.mode, "flow": a.flow}))


if __name__ == "__main__":
    main()
