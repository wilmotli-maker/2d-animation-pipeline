#!/usr/bin/env python3
"""Seedance stitch: join two AI clips that almost-but-not-quite match, via a generated bridge.

  stitch.py prep     A.mp4 B.mp4 --out DIR [--search 36] [--fps 24]
      Normalises both clips, finds the best hand-off frames (skipping soft/degraded
      end frames), measures the motion and colour at the join, and writes:
        DIR/A_out.png  DIR/B_in.png       the two keyframes for the bridge
        DIR/plan.json                     cut points, motion, colour deltas, recommendation
        DIR/prep_sheet.jpg                A's exit | B's entry | difference map
      Recommendation is one of:
        "cut"     frames already match -> join directly (short dissolve)
        "bridge"  generate a start+end-frame bridge clip (normal case)
        "hide"    too different for a clean bridge -> bridge with a seam-hiding move

  stitch.py assemble DIR --bridge bridge.mp4 [--dissolve 2] [--keep-audio]
      Fits the generated bridge (finds where it actually meets A and B, trims,
      retimes to continue A's motion speed, colour-matches A->B), joins
      A + bridge + B, then QAs both joins. Writes DIR/stitched.mp4, DIR/qa.json,
      DIR/join_strips.jpg.

  stitch.py assemble DIR --direct
      Joins A and B at the chosen frames with no bridge (for "cut" cases).
"""
import argparse, json, os, subprocess, sys, math
from pathlib import Path
import numpy as np
import cv2

FFMPEG = "ffmpeg"; FFPROBE = "ffprobe"


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"command failed: {' '.join(map(str, cmd))}\n{r.stderr[-1500:]}")
    return r.stdout


def probe(p):
    j = json.loads(run([FFPROBE, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(p)]))
    v = next(s for s in j["streams"] if s["codec_type"] == "video")
    n, d = v.get("r_frame_rate", "24/1").split("/")
    return dict(w=int(v["width"]), h=int(v["height"]), fps=float(n) / float(d),
                dur=float(j["format"]["duration"]), audio=any(s["codec_type"] == "audio" for s in j["streams"]))


def normalise(src, dst, w, h, fps):
    run([FFMPEG, "-v", "error", "-y", "-i", str(src), "-vf",
         f"scale={w}:{h}:flags=lanczos,fps={fps},setsar=1", "-an", "-c:v", "libx264",
         "-crf", "14", "-preset", "medium", "-pix_fmt", "yuv420p", str(dst)])


def read_frames(path, which, n):
    """which='tail' -> last n frames, 'head' -> first n frames. Returns (list of BGR, start_index, total)."""
    cap = cv2.VideoCapture(str(path)); total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frames = []
    while True:
        ok, f = cap.read()
        if not ok: break
        frames.append(f)
    cap.release()
    total = len(frames)
    if which == "tail":
        s = max(0, total - n); return frames[s:], s, total
    return frames[:n], 0, total


def small(f, w=320):
    h = int(f.shape[0] * w / f.shape[1]); return cv2.resize(f, (w, h), interpolation=cv2.INTER_AREA)


def sharpness(f):
    return float(cv2.Laplacian(cv2.cvtColor(small(f, 640), cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())


def lab_stats(f):
    lab = cv2.cvtColor(small(f), cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)
    return lab.mean(0), lab.std(0)


def diff_score(a, b):
    """0 = identical. Blend of structural (grey, blurred) and colour-distribution difference."""
    ga = cv2.GaussianBlur(cv2.cvtColor(small(a), cv2.COLOR_BGR2GRAY), (5, 5), 0).astype(np.float32)
    gb = cv2.GaussianBlur(cv2.cvtColor(small(b), cv2.COLOR_BGR2GRAY), (5, 5), 0).astype(np.float32)
    struct = float(np.abs(ga - gb).mean()) / 255.0
    ma, sa = lab_stats(a); mb, sb = lab_stats(b)
    colour = float(np.abs(ma - mb).mean() + 0.5 * np.abs(sa - sb).mean()) / 255.0
    return struct + colour, struct, colour


def flow(a, b):
    """Mean optical flow a->b on a downscaled grey image. Returns dx, dy (px/frame at full res), zoom (+ = push in), magnitude."""
    ga = cv2.cvtColor(small(a, 480), cv2.COLOR_BGR2GRAY); gb = cv2.cvtColor(small(b, 480), cv2.COLOR_BGR2GRAY)
    fl = cv2.calcOpticalFlowFarneback(ga, gb, None, 0.5, 3, 21, 3, 5, 1.2, 0)
    scale = a.shape[1] / 480.0
    dx, dy = float(np.median(fl[..., 0])) * scale, float(np.median(fl[..., 1])) * scale
    h, w = ga.shape; yy, xx = np.mgrid[0:h, 0:w]
    rx, ry = xx - w / 2, yy - h / 2; r = np.sqrt(rx ** 2 + ry ** 2) + 1e-6
    radial = (fl[..., 0] * rx + fl[..., 1] * ry) / r
    zoom = float(np.median(radial)) * scale
    mag = float(np.median(np.sqrt(fl[..., 0] ** 2 + fl[..., 1] ** 2))) * scale
    return dx, dy, zoom, mag


def motion_at(frames, idx, span=4):
    """Average flow over `span` frames ending (or starting) around idx."""
    vals = []
    lo = max(0, idx - span); hi = min(len(frames) - 1, idx + span)
    for i in range(lo, hi):
        vals.append(flow(frames[i], frames[i + 1]))
    if not vals: return dict(dx=0, dy=0, zoom=0, mag=0)
    v = np.array(vals).mean(0)
    return dict(dx=round(float(v[0]), 2), dy=round(float(v[1]), 2), zoom=round(float(v[2]), 3), mag=round(float(v[3]), 2))


def describe_motion(m):
    if m["mag"] < 0.6 and abs(m["zoom"]) < 0.08: return "the camera is almost static"
    parts = []
    if abs(m["dx"]) > 0.6: parts.append(("the image drifts left" if m["dx"] < 0 else "the image drifts right") + f" (camera pans/trucks {'right' if m['dx'] < 0 else 'left'})")
    if abs(m["dy"]) > 0.6: parts.append(("the image moves up" if m["dy"] < 0 else "the image moves down") + f" (camera tilts/cranes {'down' if m['dy'] < 0 else 'up'})")
    if m["zoom"] > 0.08: parts.append("the camera pushes in")
    elif m["zoom"] < -0.08: parts.append("the camera pulls out")
    speed = "slowly" if m["mag"] < 2 else ("steadily" if m["mag"] < 6 else "fast")
    return f"{', '.join(parts) or 'the camera moves'}, {speed} (~{m['mag']:.1f} px/frame)"


# ---------------------------------------------------------------- prep
def prep(a, b, out, search, fps_opt):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    pa, pb = probe(a), probe(b)
    w, h = min(pa["w"], pb["w"]), min(pa["h"], pb["h"])
    w -= w % 2; h -= h % 2
    fps = fps_opt or round(pa["fps"], 3)
    na, nb = out / "A_norm.mp4", out / "B_norm.mp4"
    normalise(a, na, w, h, fps); normalise(b, nb, w, h, fps)

    ta, sa, tot_a = read_frames(na, "tail", search)
    hb, _, tot_b = read_frames(nb, "head", search)
    sh_a = [sharpness(f) for f in ta]; sh_b = [sharpness(f) for f in hb]
    thr_a = 0.6 * float(np.median(sh_a)); thr_b = 0.6 * float(np.median(sh_b))
    ok_a = [i for i, s in enumerate(sh_a) if s >= thr_a] or list(range(len(ta)))
    ok_b = [j for j, s in enumerate(sh_b) if s >= thr_b] or list(range(len(hb)))

    best = None
    for i in ok_a:
        for j in ok_b:
            sc, st, co = diff_score(ta[i], hb[j])
            lost = (len(ta) - 1 - i) + j                      # frames thrown away
            cost = sc + 0.0015 * lost                         # small preference for keeping footage
            if best is None or cost < best[0]:
                best = (cost, i, j, sc, st, co)
    _, i, j, sc, st, co = best
    cut_a = sa + i          # last frame of A we keep (inclusive)
    cut_b = j               # first frame of B we keep
    A_out, B_in = ta[i], hb[j]
    cv2.imwrite(str(out / "A_out.png"), A_out); cv2.imwrite(str(out / "B_in.png"), B_in)

    ma = motion_at(ta, i); mb = motion_at(hb, j)
    la, _ = lab_stats(A_out); lb, _ = lab_stats(B_in)
    d_light = float(lb[0] - la[0]) * 100 / 255
    # the typical frame-to-frame change inside A = the scale a "clean join" has to live within
    inner = float(np.median([diff_score(ta[k], ta[k + 1])[0] for k in range(max(0, len(ta) - 12), len(ta) - 1)] or [0.01]))
    ratio = sc / max(inner, 1e-4)
    rec = "cut" if ratio < 2.5 else ("bridge" if sc < 0.22 else "hide")
    speed = (ma["mag"] + mb["mag"]) / 2
    bridge_s = 0.6 if rec == "cut" else float(np.clip(0.8 + sc * 8, 1.0, 2.5))

    plan = dict(A=str(a), B=str(b), A_norm=str(na), B_norm=str(nb), width=w, height=h, fps=fps,
                A_frames=tot_a, B_frames=tot_b, cut_a_last_kept=cut_a, cut_b_first_kept=cut_b,
                trimmed_from_A=tot_a - 1 - cut_a, trimmed_from_B=cut_b,
                mismatch=round(sc, 4), mismatch_structure=round(st, 4), mismatch_colour=round(co, 4),
                typical_frame_change=round(inner, 4), mismatch_vs_typical=round(ratio, 1),
                lightness_change_B_minus_A=round(d_light, 1),
                motion_A_exit=ma, motion_B_entry=mb,
                motion_A_text=describe_motion(ma), motion_B_text=describe_motion(mb),
                recommendation=rec, target_bridge_seconds=round(bridge_s, 2),
                soft_frames_skipped=dict(A=len(ta) - len(ok_a), B=len(hb) - len(ok_b)),
                source_audio=dict(A=pa["audio"], B=pb["audio"]))
    (out / "plan.json").write_text(json.dumps(plan, indent=1))

    # sheet: A exit | B entry | diff heatmap
    tw = 640
    sa_ = small(A_out, tw); sb_ = small(B_in, tw)
    d = cv2.absdiff(cv2.cvtColor(sa_, cv2.COLOR_BGR2GRAY), cv2.cvtColor(sb_, cv2.COLOR_BGR2GRAY))
    hm = cv2.applyColorMap(cv2.normalize(d, None, 0, 255, cv2.NORM_MINMAX), cv2.COLORMAP_INFERNO)
    sheet = np.hstack([sa_, np.full((sa_.shape[0], 6, 3), 20, np.uint8), sb_, np.full((sa_.shape[0], 6, 3), 20, np.uint8), hm])
    for x, t in ((8, f"A out f{cut_a}"), (tw + 14, f"B in f{cut_b}"), (2 * tw + 20, f"difference  score {sc:.3f} ({ratio:.1f}x typical)")):
        cv2.putText(sheet, t, (x, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
    cv2.imwrite(str(out / "prep_sheet.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])
    print(json.dumps({k: plan[k] for k in ("recommendation", "mismatch", "mismatch_vs_typical", "trimmed_from_A", "trimmed_from_B",
                                           "motion_A_text", "motion_B_text", "lightness_change_B_minus_A", "target_bridge_seconds")}, indent=1))


# ---------------------------------------------------------------- assemble helpers
def read_all(path):
    cap = cv2.VideoCapture(str(path)); fr = []
    while True:
        ok, f = cap.read()
        if not ok: break
        fr.append(f)
    cap.release(); return fr


def write_video(frames, path, fps):
    h, w = frames[0].shape[:2]
    p = subprocess.Popen([FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps),
                          "-i", "-", "-c:v", "libx264", "-crf", "14", "-preset", "medium", "-pix_fmt", "yuv420p", str(path)],
                         stdin=subprocess.PIPE)
    for f in frames: p.stdin.write(f.tobytes())
    p.stdin.close(); p.wait()


def colour_transfer(f, src_stats, dst_stats):
    """Move frame f from src Lab stats toward dst Lab stats (mean/std per channel)."""
    lab = cv2.cvtColor(f, cv2.COLOR_BGR2LAB).astype(np.float32)
    (ms, ss), (md, sd) = src_stats, dst_stats
    lab = (lab - ms) / np.maximum(ss, 1e-3) * sd + md
    return cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)


def resample(frames, n_out):
    """Retime a frame list to n_out frames by linear blending (simple, artefact-light for small speed changes)."""
    n = len(frames)
    if n_out == n: return frames
    out = []
    for k in range(n_out):
        t = k * (n - 1) / max(n_out - 1, 1); i = int(math.floor(t)); a = t - i
        if i >= n - 1: out.append(frames[-1]); continue
        out.append(frames[i] if a < 0.02 else cv2.addWeighted(frames[i], 1 - a, frames[i + 1], a, 0))
    return out


def eased_retime(frames, v_start, v_end, cap=3.5, min_frames=24):
    """Re-time a bridge so its camera travel follows a smooth ease-in / ease-out curve that
    hands off at A's exit speed (v_start px/frame) and lands at B's entry speed (v_end).
    Progress through the bridge is measured from its own optical flow, so it works whatever
    pacing the generator chose. Returns (frames, info)."""
    n = len(frames)
    if n < 3: return frames, {}
    step = [flow(frames[k], frames[k + 1])[3] for k in range(n - 1)]
    cum = np.concatenate([[0.0], np.cumsum(np.maximum(step, 1e-3))])
    D = float(cum[-1])
    # cubic Hermite curve p(t) with p(0)=0, p(1)=1 and end slopes set from the neighbour speeds
    def curve(T):
        m0 = v_start * T / max(D, 1e-6); m1 = v_end * T / max(D, 1e-6)
        m0, m1 = min(m0, 1.0), min(m1, 1.0)
        return lambda t: (2*t**3 - 3*t**2 + 1)*0 + (t**3 - 2*t**2 + t)*m0 + (-2*t**3 + 3*t**2)*1 + (t**3 - t**2)*m1
    # choose length so the peak speed stays under `cap` px/frame
    T = max(min_frames, int(math.ceil(1.5 * D / cap)))
    p = curve(T)
    out = []
    for k in range(T):
        target = min(max(p(k / (T - 1)), 0.0), 1.0) * D
        i = int(np.searchsorted(cum, target, side="right") - 1); i = min(max(i, 0), n - 2)
        a = (target - cum[i]) / max(cum[i + 1] - cum[i], 1e-6)
        out.append(frames[i] if a < 0.02 else (frames[i + 1] if a > 0.98 else cv2.addWeighted(frames[i], 1 - a, frames[i + 1], a, 0)))
    return out, dict(travel_px=round(D, 1), frames=T, peak_px_per_frame=round(1.5 * D / T, 2))


def match_sharpness(frames, s_start, s_end):
    """Nudge each bridge frame's crispness toward a line from A's exit sharpness to B's entry sharpness."""
    out = []
    for k, f in enumerate(frames):
        t = k / max(len(frames) - 1, 1); target = (1 - t) * s_start + t * s_end
        cur = sharpness(f)
        if cur < target * 0.85:
            amt = min(1.5, (target / max(cur, 1e-3)) ** 0.5 - 1)
            blur = cv2.GaussianBlur(f, (0, 0), 1.2); f = cv2.addWeighted(f, 1 + amt, blur, -amt, 0)
        elif cur > target * 1.2:
            f = cv2.GaussianBlur(f, (0, 0), min(1.5, 0.4 * (cur / max(target, 1e-3)) ** 0.5))
        out.append(f)
    return out


def estimate_similarity(a, b):
    """Scale/rotation/shift that maps frame a onto frame b (feature matching + RANSAC)."""
    sift = cv2.SIFT_create(4000)
    ga = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY); gb = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    ka, da = sift.detectAndCompute(ga, None); kb, db = sift.detectAndCompute(gb, None)
    if da is None or db is None: return None, 0
    m = cv2.BFMatcher().knnMatch(da, db, k=2)
    good = [x for x, y in (p for p in m if len(p) == 2) if x.distance < 0.75 * y.distance]
    if len(good) < 12: return None, len(good)
    pa = np.float32([ka[g.queryIdx].pt for g in good]); pb = np.float32([kb[g.trainIdx].pt for g in good])
    M, inl = cv2.estimateAffinePartial2D(pa, pb, method=cv2.RANSAC, ransacReprojThreshold=6.0)
    return M, int(inl.sum()) if inl is not None else 0


def reframe_tail(A, M, n):
    """Digitally push/shift the last n frames of A along an eased path from its own framing to
    B's framing (the similarity M), so the cut lands on B's composition. No generated pixels."""
    h, w = A[0].shape[:2]
    s = math.hypot(M[0, 0], M[1, 0]); th = math.atan2(M[1, 0], M[0, 0]); tx, ty = M[0, 2], M[1, 2]
    out = A[:-n] if n < len(A) else []
    tail = A[-n:]
    for k, f in enumerate(tail):
        t = (k + 1) / n; e = t * t * (3 - 2 * t)                 # ease in/out
        sk = math.exp(e * math.log(s)); thk = e * th
        Mk = np.array([[sk * math.cos(thk), -sk * math.sin(thk), e * tx],
                       [sk * math.sin(thk),  sk * math.cos(thk), e * ty]], np.float32)
        # keep the push centred the way the full transform is: blend translation so the
        # image centre follows a straight line from where it is to where M sends it
        c = np.array([w / 2, h / 2, 1.0]); target = M @ c
        cur = Mk[:, :2] @ c[:2]
        Mk[:, 2] = (1 - e) * (c[:2] - Mk[:, :2] @ c[:2]) * 0 + (c[:2] + e * (target - c[:2])) - cur
        out.append(cv2.warpAffine(f, Mk, (w, h), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT))
    return out


def detail_handoff(Br, ref, n, from_start=True, sigma=1.6):
    """Borrow real fine detail from `ref` (A's last frame, or B's first) and lay it over the
    first (or last) n bridge frames, warped with optical flow to follow the bridge's motion and
    faded out smoothly. Stops a sharp 1080p clip from dropping into a soft generated bridge in
    a single frame."""
    out = list(Br); n = min(n, len(Br))
    ref_f = ref.astype(np.float32); ref_hf = ref_f - cv2.GaussianBlur(ref_f, (0, 0), sigma)
    h, w = ref.shape[:2]
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    for k in range(n):
        idx = k if from_start else len(Br) - 1 - k
        t = k / max(n - 1, 1); wgt = 1 - t * t * (3 - 2 * t)          # 1 at the join -> 0, eased
        f = Br[idx].astype(np.float32)
        fl = dense_flow(Br[idx], ref)                                   # bridge frame -> ref
        hf_ref = cv2.remap(ref_hf, gx + fl[..., 0], gy + fl[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        hf_own = f - cv2.GaussianBlur(f, (0, 0), sigma)
        out[idx] = np.clip(f + wgt * (hf_ref - hf_own), 0, 255).astype(np.uint8)
    return out


def join_jump(frames, k):
    """How big the change across the join (k-1 -> k) is, relative to the typical nearby change."""
    j = diff_score(frames[k - 1], frames[k])[0]
    near = [diff_score(frames[x], frames[x + 1])[0] for x in range(max(0, k - 10), min(len(frames) - 1, k + 10)) if x not in (k - 1,)]
    return j, j / max(float(np.median(near)) if near else 1e-4, 1e-4)


def dense_flow(a, b):
    ga = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY); gb = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    return cv2.calcOpticalFlowFarneback(ga, gb, None, 0.5, 5, 31, 5, 7, 1.5, 0)


def warp(img, fl, t):
    """Sample img displaced by t*flow (backward warp)."""
    h, w = img.shape[:2]
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    return cv2.remap(img, gx - t * fl[..., 0], gy - t * fl[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def dissolve(left, right, n, morph=False):
    """Overlap the last n frames of left with the first n of right.
    morph=True: optical-flow morph cut — the left frames are pulled toward the right
    frame's geometry and vice versa while cross-fading, so small shifts, zooms and
    pose differences glide instead of ghosting."""
    if n <= 0: return left + right
    out = left[:-n]
    if morph:
        L, R = left[-n - 1] if len(left) > n else left[0], right[min(n, len(right) - 1)]
        fwd = dense_flow(L, R); bwd = dense_flow(R, L)
    for k in range(n):
        a = (k + 1) / (n + 1)
        lf, rf = left[len(left) - n + k], right[k]
        if morph:
            lf = warp(lf, bwd, a)          # push left frame toward R's geometry
            rf = warp(rf, fwd, 1 - a)      # hold right frame back toward L's geometry
        if morph:
            # blend the broad image linearly, but keep fine texture at full strength: when two
            # frames' fine detail doesn't line up exactly, a plain mix cancels it and the seam goes soft
            lf32, rf32 = lf.astype(np.float32), rf.astype(np.float32)
            lL, lR = cv2.GaussianBlur(lf32, (0, 0), 2.0), cv2.GaussianBlur(rf32, (0, 0), 2.0)
            hf = ((1 - a) * (lf32 - lL) + a * (rf32 - lR)) / math.sqrt((1 - a) ** 2 + a ** 2)
            out.append(np.clip((1 - a) * lL + a * lR + hf, 0, 255).astype(np.uint8))
        else:
            out.append(cv2.addWeighted(lf, 1 - a, rf, a, 0))
    return out + right[n:]


def assemble(d, bridge, direct, dis, keep_audio, morph=0, ease_cap=3.5, reframe=0.0, handoff=1.0):
    d = Path(d); plan = json.loads((d / "plan.json").read_text())
    fps, w, h = plan["fps"], plan["width"], plan["height"]
    A = read_all(plan["A_norm"])[: plan["cut_a_last_kept"] + 1]
    B = read_all(plan["B_norm"])[plan["cut_b_first_kept"]:]
    report = dict(mode="direct" if direct else "bridge")
    if reframe: direct = False

    if reframe:
        M, inl = estimate_similarity(A[-1], B[0])
        if M is None: sys.exit(f"reframe: not enough matching detail between A's last frame and B's first frame ({inl} matches)")
        nf = max(6, int(round(reframe * fps)))
        A = reframe_tail(A, M, min(nf, len(A) - 1))
        n = morph or dis
        seq = dissolve(A, B, n, bool(morph)); joins = [len(A) - n]
        report.update(mode="reframe", scale=round(math.hypot(M[0,0], M[1,0]), 3), shift_px=[round(float(M[0,2]),1), round(float(M[1,2]),1)],
                      matched_points=inl, reframe_seconds=round(nf / fps, 2))
    elif direct:
        n = morph or dis
        seq = dissolve(A, B, n, bool(morph)); joins = [len(A) - n]
    else:
        bn = d / "bridge_norm.mp4"; normalise(bridge, bn, w, h, fps)
        Br = read_all(bn)
        # where does the generated bridge actually meet A's exit and B's entry?
        first = min(range(min(12, len(Br))), key=lambda k: diff_score(Br[k], A[-1])[0])
        last = min(range(max(0, len(Br) - 12), len(Br)), key=lambda k: diff_score(Br[k], B[0])[0])
        if last <= first + 2: first, last = 0, len(Br) - 1
        Br = Br[first + 1: last]                    # drop the frames that duplicate A[-1] / B[0]
        report.update(bridge_frames_generated=int(probe(bn)["dur"] * fps), bridge_trim=[first, last])
        # retime: eased camera travel that hands off at A's exit speed and lands at B's entry speed
        vA = plan["motion_A_exit"]["mag"]; vB = plan["motion_B_entry"]["mag"]
        Br, info = eased_retime(Br, vA, vB, cap=ease_cap)
        report.update(retime="eased", **{f"bridge_{k}": v for k, v in info.items()}, bridge_frames_used=len(Br), bridge_seconds=round(len(Br) / fps, 2))
        # colour: first bridge frame matched to A, last to B, blended in between
        sA, sB = lab_stats(A[-1]), lab_stats(B[0])
        out = []
        for k, f in enumerate(Br):
            t = k / max(len(Br) - 1, 1); src = lab_stats(f)
            dst = ((1 - t) * sA[0] + t * sB[0], (1 - t) * sA[1] + t * sB[1])
            out.append(colour_transfer(f, src, dst))
        Br = out
        # hand real detail across each seam where the bridge is softer than the clip it meets
        hd = int(round(handoff * fps))
        raw_bridge_sharp = sharpness(Br[min(len(Br) - 1, int(0.5 * fps))])
        if hd and sharpness(Br[0]) < 0.8 * sharpness(A[-1]): Br = detail_handoff(Br, A[-1], hd, True); report['detail_handoff_A'] = hd
        if hd and sharpness(Br[-1]) < 0.8 * sharpness(B[0]): Br = detail_handoff(Br, B[0], hd, False); report['detail_handoff_B'] = hd
        Br = match_sharpness(Br, sharpness(A[-1]), sharpness(B[0]))
        # meet in the middle: ease A's last frames down toward the bridge's opening crispness
        sa, sb0 = sharpness(A[-1]), raw_bridge_sharp
        if hd and sb0 < 0.8 * sa:
            nA = min(len(A) - 1, int(round(0.6 * fps)))
            for k in range(nA):
                t = (k + 1) / nA; e = t * t * (3 - 2 * t)
                idx = len(A) - nA + k
                target = sa + e * 0.6 * (sb0 - sa)
                sig = 0.0
                for cand in (0.4, 0.6, 0.8, 1.0, 1.3, 1.6, 2.0):
                    if sharpness(cv2.GaussianBlur(A[idx], (0, 0), cand)) <= target: sig = cand; break
                    sig = cand
                if e > 0.02: A[idx] = cv2.GaussianBlur(A[idx], (0, 0), sig * e ** 0.5)
            report['A_tail_softened_frames'] = nA
        n = morph or dis
        left = dissolve(A, Br, n, bool(morph)); j1 = len(A) - n
        seq = dissolve(left, B, n, bool(morph)); j2 = len(left) - n
        joins = [j1, j2]

    raw = d / "stitched_video.mp4"; write_video(seq, raw, fps)
    final = d / "stitched.mp4"
    if keep_audio and plan["source_audio"]["A"] and plan["source_audio"]["B"]:
        ta = (plan["cut_a_last_kept"] + 1) / fps; tb = plan["cut_b_first_kept"] / fps
        gap = (len(seq) - (plan["cut_a_last_kept"] + 1) - (len(read_all(plan["B_norm"])) - plan["cut_b_first_kept"])) / fps
        run([FFMPEG, "-v", "error", "-y", "-i", str(raw), "-i", plan["A"], "-i", plan["B"], "-filter_complex",
             f"[1:a]atrim=0:{ta:.3f},asetpts=PTS-STARTPTS[a];anullsrc=r=48000:cl=stereo,atrim=0:{max(gap,0.01):.3f}[g];"
             f"[2:a]atrim=start={tb:.3f},asetpts=PTS-STARTPTS[b];[a][g][b]concat=n=3:v=0:a=1[out]",
             "-map", "0:v", "-map", "[out]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", str(final)])
    else:
        os.replace(raw, final)

    # QA
    qa = []
    for k in joins:
        k = max(1, min(len(seq) - 1, k)); j, rel = join_jump(seq, k)
        qa.append(dict(frame=k, time=round(k / fps, 2), jump=round(j, 4), vs_typical=round(rel, 1),
                       verdict="clean" if rel < 2.0 else ("soft bump" if rel < 3.5 else "VISIBLE JUMP")))
    report.update(joins=qa, total_seconds=round(len(seq) / fps, 2), output=str(final))
    (d / "qa.json").write_text(json.dumps(report, indent=1))
    # strips: 4 frames either side of each join
    rows = []
    for q in qa:
        k = q["frame"]; tiles = []
        for x in range(k - 4, k + 4):
            x = max(0, min(len(seq) - 1, x)); t = small(seq[x], 300).copy()
            cv2.putText(t, f"{x}" + (" <join" if x == k else ""), (6, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
            tiles.append(t)
        rows.append(np.hstack(tiles))
    cv2.imwrite(str(d / "join_strips.jpg"), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 86])
    print(json.dumps(report, indent=1))


def ease_seam(src, out, seconds=1.0, fps_out=24000/1001, thresh=2.5, pad=3):
    """Find the burst of fast motion in a finished one-er (e.g. a VACE joiner's snap push-in) and
    stretch it to `seconds` with an eased speed curve, drawing new frames by optical-flow interpolation."""
    fr = read_all(src); fps = probe(src)["fps"]
    m = [flow(fr[k], fr[k + 1])[3] for k in range(len(fr) - 1)]
    med = float(np.median(m)); pk = int(np.argmax(m))
    s = pk
    while s > 0 and m[s - 1] > thresh * med: s -= 1
    e = pk
    while e < len(m) - 1 and m[e + 1] > thresh * med: e += 1
    s = max(s - pad, 1); e = min(e + pad + 1, len(fr) - 2)          # segment frames s..e
    seg = fr[s:e + 1]; steps = m[s:e]
    cum = np.concatenate([[0.0], np.cumsum(np.maximum(steps, 1e-3))]); D = float(cum[-1])
    T = max(int(round(seconds * fps)), len(seg))
    v0, v1 = m[s - 1], m[e]
    m0 = min(v0 * T / D, 1.0); m1 = min(v1 * T / D, 1.0)
    curve = lambda t: (t**3 - 2*t**2 + t)*m0 + (-2*t**3 + 3*t**2) + (t**3 - t**2)*m1
    flows = {}
    new = []
    for k in range(T):
        target = min(max(curve(k / (T - 1)), 0.0), 1.0) * D
        i = int(np.searchsorted(cum, target, side="right") - 1); i = min(max(i, 0), len(seg) - 2)
        a = (target - cum[i]) / max(cum[i + 1] - cum[i], 1e-6)
        if a < 0.03: new.append(seg[i]); continue
        if a > 0.97: new.append(seg[i + 1]); continue
        if i not in flows: flows[i] = (dense_flow(seg[i], seg[i + 1]), dense_flow(seg[i + 1], seg[i]))
        f, b = flows[i]
        a = float(a); new.append(cv2.addWeighted(warp(seg[i], b, -a), 1 - a, warp(seg[i + 1], f, -(1 - a)), a, 0))
    res = fr[:s] + new + fr[e + 1:]
    tmp = str(out) + ".tmp.mp4"; write_video(res, tmp, fps)
    run([FFMPEG, "-v", "error", "-y", "-i", tmp, "-vf", f"fps={fps_out},scale=1920:1080:flags=lanczos,setsar=1",
         "-c:v", "libx264", "-crf", "14", "-preset", "slow", "-pix_fmt", "yuv420p", "-an", str(out)])
    os.remove(tmp)
    info = dict(src_fps=round(fps, 3), burst_frames=[s, e], burst_seconds=[round(s / fps, 2), round(e / fps, 2)],
                was_seconds=round((e - s) / fps, 2), now_seconds=round(T / fps, 2), peak_vs_typical=round(m[pk] / med, 1))
    print(json.dumps(info)); return info


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    p1 = sp.add_parser("prep"); p1.add_argument("a"); p1.add_argument("b"); p1.add_argument("--out", required=True)
    p1.add_argument("--search", type=int, default=36, help="frames to search at each end (default 36 = 1.5 s at 24 fps)")
    p1.add_argument("--fps", type=float, default=None)
    p2 = sp.add_parser("assemble"); p2.add_argument("dir"); p2.add_argument("--bridge")
    p2.add_argument("--direct", action="store_true")
    p2.add_argument("--reframe", type=float, default=0.0, help="NO generation: digitally push/shift the last N seconds of A onto B's framing, then morph into B"); p2.add_argument("--dissolve", type=int, default=2)
    p2.add_argument("--keep-audio", action="store_true")
    p2.add_argument("--handoff", type=float, default=1.0, help="seconds over which real detail from A/B is faded into a softer bridge (0 = off)")
    p2.add_argument("--ease-cap", type=float, default=3.5, help="max camera speed (px/frame) through the bridge; lower = slower, gentler push")
    p2.add_argument("--morph", type=int, default=0, help="use an N-frame optical-flow morph at each join instead of a plain dissolve (try 6-10)")
    p3 = sp.add_parser("ease", help="slow a too-fast snap (e.g. from the VACE joiner) into a smooth eased move")
    p3.add_argument("src"); p3.add_argument("--out", required=True); p3.add_argument("--seconds", type=float, default=1.0)
    a = ap.parse_args()
    if a.cmd == "prep": prep(a.a, a.b, a.out, a.search, a.fps)
    elif a.cmd == "ease": ease_seam(a.src, a.out, a.seconds)
    else:
        if not (a.direct or a.bridge or a.reframe): sys.exit("assemble needs --bridge FILE, --direct or --reframe SECONDS")
        assemble(a.dir, a.bridge, a.direct, a.dissolve, a.keep_audio, a.morph, a.ease_cap, a.reframe, a.handoff)
