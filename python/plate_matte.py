#!/usr/bin/env python3
"""Plate matte: trimap + closed-form matting for footage shot on a designed plate.

Invoked by src/matte.js (--method plate), not directly by users. The BACKGROUND is
assumed to be a solid colour distinct from the foreground (a chroma key), and is
AUTO-DETECTED from the frame-edge band — no model weights, works for any plate hue.
Frames stream in from an ffmpeg decoder and RGBA streams out to an ffmpeg encoder,
mirroring python/matte.py, so this is a drop-in alternative producing the same
prores4444 / webm / png outputs and the same JSON report on stdout.

Priors that make it strong on flat cel/2D art: a dark ink outline marks the
boundary, interiors are opaque, and plate-hued negative space (e.g. an open mouth)
is background even when shadowed. The core trimap + closed-form matte is general.
"""
import argparse, json, os, subprocess
import numpy as np, cv2
from matte_io import log, probe, run_stream, reject
# pymatting (and the numba/scipy stack it drags in) is imported lazily inside
# matte(): only the trimap engine needs it. The keylight engine is pure
# numpy+opencv, so it must not pay that import cost or require those wheels.
# Streaming ffmpeg I/O, temp-then-replace, and the degenerate-output guard live
# in matte_io, shared with python/matte.py.


def _k(n): return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (n, n))


# --- algorithm (kept in sync with tools/plate-matte/trimatte.py) ------------
def edge_band(im):
    m = max(4, int(round(0.03*min(im.shape[:2]))))
    return np.concatenate([im[:m].reshape(-1, 3), im[-m:].reshape(-1, 3),
                           im[:, :m].reshape(-1, 3), im[:, -m:].reshape(-1, 3)])


def detect_key_from_bands(ab):
    key = np.median(ab, 0); keep = np.ones(len(ab), bool)
    for _ in range(3):
        d = np.linalg.norm(ab-key, axis=1); med = np.median(d[keep])
        mad = 1.4826*np.median(np.abs(d[keep]-med))+1e-6
        keep = d <= max(med+2.5*mad, 0.04); key = np.median(ab[keep], 0)
    d = np.linalg.norm(ab[keep]-key, axis=1)
    return key.astype(np.float32), max(float(np.percentile(d, 84)), 0.008)


def chroma_alpha(img, key, spread, tdark=0.34, clight=0.42, cbias=1.3, ringpx=7,
                 kcarve=0.22, kencl=0.32, despill=True):
    """Chroma-key core. img BGR float [0,1] -> priors for the edge solver:

      { rgb:     despilled RGB float64 (what the closed-form solve runs on),
        trimap:  0/0.5/1 trimap float64 built from the plate-colour priors,
        fg_lock: bool mask of definite-foreground pixels to hold opaque }

    The plate-specific reasoning that makes this strong on flat cel/2D art lives
    here: a dark ink outline marks the boundary, interiors are opaque, and
    plate-hued negative space (an open mouth) is background. `refine_edges`
    consumes these priors — or, for other basic mattes, works from a plain alpha.
    """
    d_key = np.linalg.norm(img-key, axis=2)
    kc = key-key.mean(); kc = kc/(np.linalg.norm(kc)+1e-6)
    keyn = ((img-img.mean(axis=2, keepdims=True))*kc).sum(axis=2)
    Kp = max(float(np.median(keyn[d_key < max(2*spread, 0.03)])), 1e-3)

    bgr = img.copy()
    if despill:                                     # clamp the plate's dominant channel
        kmax = int(np.argmax(key)); oth = [i for i in (0, 1, 2) if i != kmax]
        bgr[..., kmax] = np.minimum(img[..., kmax], np.maximum(img[..., oth[0]], img[..., oth[1]]))
    L = 0.114*bgr[..., 0]+0.587*bgr[..., 1]+0.299*bgr[..., 2]

    T_BG  = float(np.clip(5.0*spread, 0.05, 0.16))
    T_FG0 = float(np.clip(3.0*T_BG, 0.22, 0.40))
    T_INK = float(np.clip(1.6*T_BG, 0.12, 0.25))
    KN_BG, KN_INK, KN_CV = 0.25*Kp, 0.30*Kp, 0.30*Kp

    FG0    = (d_key > T_FG0).astype(np.uint8)
    FG_def = cv2.erode(FG0, _k(17))
    BG_def = cv2.erode(((d_key < T_BG) & (keyn > KN_BG)).astype(np.uint8), _k(3))
    dark   = ((L < tdark) & (keyn < KN_INK) & (d_key > T_INK)).astype(np.uint8)

    solid = cv2.morphologyEx(((d_key > T_FG0) & (L > tdark)).astype(np.uint8), cv2.MORPH_CLOSE, _k(9))
    _, lab = cv2.connectedComponents((1-solid).astype(np.uint8), connectivity=8)
    brd = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    reach = np.isin(lab, brd)
    negbg = ((reach & (keyn > kcarve*Kp)) | ((FG_def == 0) & (keyn > kencl*Kp))) & (keyn > 0)
    FG_def[negbg] = 0

    tri = np.full(L.shape, 0.5, np.float32)
    tri[BG_def == 1] = 0.0
    FG_seed = ((FG_def == 1) | (cv2.erode(dark, _k(3)) == 1)).astype(np.uint8)
    FG_seed[negbg] = 0
    tri[FG_seed == 1] = 1.0
    tri[negbg] = 0.0
    distFG = cv2.distanceTransform(1-FG_seed, cv2.DIST_L2, 3)
    distBG = cv2.distanceTransform(1-BG_def, cv2.DIST_L2, 3)
    tri[(tri == 0.5) & ((L > clight) | (keyn > KN_CV)) & (distBG < distFG*cbias)] = 0.0
    ring = (cv2.dilate(dark, _k(ringpx)) & (1-FG_seed) & (1-BG_def)).astype(bool)
    tri[ring] = 0.5

    rgb = bgr[..., ::-1].copy().astype(np.float64)
    return {'rgb': rgb, 'trimap': tri.astype(np.float64), 'fg_lock': FG_def == 1}


def trimap_from_alpha(alpha, hi=0.9, lo=0.1, erode=9):
    """Method-agnostic trimap from any core alpha: eroded core = definite FG,
    eroded background = definite BG, the band between = unknown. Used by
    refine_edges when no plate-specific trimap is supplied (e.g. keylight)."""
    fg = cv2.erode((alpha > hi).astype(np.uint8), _k(erode))
    bg = cv2.erode((alpha < lo).astype(np.uint8), _k(erode))
    tri = np.full(alpha.shape, 0.5, np.float32)
    tri[bg == 1] = 0.0
    tri[fg == 1] = 1.0
    return tri.astype(np.float64)


def refine_edges(rgb, *, trimap=None, alpha=None, fg_lock=None, feath=1.1):
    """Closed-form edge refinement. rgb is RGB float64. Either pass a `trimap`
    (from chroma_alpha) or an `alpha` core to derive one via trimap_from_alpha.
    fg_lock holds definite-FG pixels opaque through the solve and feather.
    Returns (alpha HxW, F RGB HxW). This is the only stage needing pymatting."""
    from pymatting import estimate_alpha_cf, estimate_foreground_ml
    if trimap is None:
        if alpha is None:
            raise ValueError('refine_edges needs a trimap or an alpha')
        trimap = trimap_from_alpha(alpha)
    alpha = estimate_alpha_cf(rgb, trimap)
    if fg_lock is not None:
        alpha = np.maximum(alpha, fg_lock.astype(np.float64))
    if feath > 0:
        alpha = cv2.GaussianBlur(alpha.astype(np.float32), (0, 0), feath).astype(np.float64)
        if fg_lock is not None:
            alpha = np.maximum(alpha, cv2.erode(fg_lock.astype(np.uint8), _k(5)).astype(np.float64))
    alpha = np.clip(alpha, 0, 1)
    F = estimate_foreground_ml(rgb, alpha)
    return alpha, F


def matte(img, key, spread, tdark=0.34, ringpx=7, clight=0.42, cbias=1.3,
          feath=1.1, kcarve=0.22, kencl=0.32, despill=True):
    """Trimap chroma matte = chroma_alpha core + closed-form refine. Thin wrapper
    kept so callers (and the byte-identical golden path) are unchanged."""
    core = chroma_alpha(img, key, spread, tdark=tdark, clight=clight, cbias=cbias,
                        ringpx=ringpx, kcarve=kcarve, kencl=kencl, despill=despill)
    return refine_edges(core['rgb'], trimap=core['trimap'], fg_lock=core['fg_lock'], feath=feath)


# --- keylight engine (--key-engine keylight) --------------------------------
# A pure per-pixel colour-difference keyer, faithful to After Effects' Keylight:
# the matte AND the despill both come from one measurement of "how much screen
# colour is in this pixel", so the two can never disagree. No trimap, no
# closed-form solve — edges come from the source's own partial-coverage pixels
# plus an optional Gaussian softness. Consequently much cheaper per frame than
# the trimap engine. See docs/superpowers/specs/2026-09-07-keylight-matte-design.md.
def _screen_strength(x, kmax, oth, balance):
    """Excess of the dominant channel over a balance-weighted blend of the others.

    balance=0 compares to the SMALLER of the other two channels, 1 to the LARGER,
    0.5 to their average — Keylight's Screen Balance. Large on clean screen,
    ~0 or negative on foreground. x is BGR float in [0,1], any leading shape.
    """
    D = x[..., kmax]
    lo = np.minimum(x[..., oth[0]], x[..., oth[1]])
    hi = np.maximum(x[..., oth[0]], x[..., oth[1]])
    return D - (balance * hi + (1.0 - balance) * lo)


def keylight_alpha(img, key, balance=0.5, gain=1.0, clip_black=0.0, clip_white=1.0,
                   pre_blur=0.0, bias='auto', despill=True):
    """img BGR float [0,1], key BGR float [0,1] -> (alpha HxW, F RGB HxW).

    bias: 'auto' derives the protected foreground tone from this frame's core
    (median of high-alpha, off-key pixels) so in-design plate-hued colours are
    not over-keyed; a BGR array pins it; None disables it.
    """
    kmax = int(np.argmax(key))
    oth = [i for i in (0, 1, 2) if i != kmax]
    ki = cv2.GaussianBlur(img, (0, 0), pre_blur) if pre_blur > 0 else img

    s_screen = max(float(_screen_strength(key[None, None, :], kmax, oth, balance)[0, 0]), 1e-6)

    def alpha_from(s_px, s_ref):
        raw = s_px * gain / max(s_ref, 1e-6)
        a = 1.0 - np.clip(raw, 0.0, 1.0)
        if clip_white > clip_black:
            a = np.clip((a - clip_black) / (clip_white - clip_black), 0.0, 1.0)
        else:
            a = (a >= clip_white).astype(np.float32)  # degenerate levels -> hard key
        return a.astype(np.float32)

    s_px = _screen_strength(ki, kmax, oth, balance)

    if isinstance(bias, str) and bias == 'auto':
        # Bootstrap: a bias-free pass locates the foreground core, whose median
        # colour becomes the bias so its own hue reads as foreground (strength ~0).
        core = alpha_from(s_px, s_screen) > 0.9
        bias = np.median(img[core], axis=0).astype(np.float32) if core.any() else None
    if bias is not None:
        s_bias = float(_screen_strength(np.asarray(bias)[None, None, :], kmax, oth, balance)[0, 0])
        s_px = s_px - s_bias
        s_screen = max(s_screen - s_bias, 1e-6)

    alpha = alpha_from(s_px, s_screen)

    F = img.copy()
    if despill:
        F[..., kmax] = np.minimum(img[..., kmax],
                                  balance * np.maximum(img[..., oth[0]], img[..., oth[1]])
                                  + (1.0 - balance) * np.minimum(img[..., oth[0]], img[..., oth[1]]))
    return alpha, F[..., ::-1]  # F -> RGB, matching matte()


def apply_masks(alpha, inside, outside):
    """Force-FG (inside) and force-BG (outside) holdout mattes, each float [0,1]."""
    if inside is not None:
        alpha = np.maximum(alpha, inside)
    if outside is not None:
        alpha = alpha * (1.0 - outside)
    return np.clip(alpha, 0.0, 1.0)


def load_mask(spec, idx, w, h):
    """One holdout mask as float [0,1] HxW, or None.

    spec is a single PNG (applied to every frame) or a directory of %05d.png
    (one per frame; a missing index is a no-op). White forces, black ignores.

    Sequence frames are numbered from 00001 (idx is the 0-based decode counter),
    matching ffmpeg's image2 muxer — i.e. the pipeline's own `--format png` alpha
    output — so a mask sequence lines up 1:1 with a matted png sequence.
    """
    if spec is None:
        return None
    path = os.path.join(spec, f'{idx + 1:05d}.png') if os.path.isdir(spec) else spec
    if not os.path.isfile(path):
        return None  # missing frame in a sequence -> no-op
    m = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if m is None:
        return None
    if (m.shape[1], m.shape[0]) != (w, h):
        m = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
    return m.astype(np.float32) / 255.0


def key_fraction(bgr, mask, kmax):
    """Share of masked pixels reading as saturated dominant-channel spill."""
    if not mask.any():
        return 0.0
    px = bgr[mask]
    mx = px.max(1); mn = px.min(1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    return float(((px[:, kmax] >= mx) & (sat > 0.15)).mean())


def edge_mask_alpha(alpha):
    """Transition band plus 2 px of near-opaque pixels just inside it."""
    soft = ((alpha > 0.05) & (alpha < 0.95)).astype(np.uint8)
    return (cv2.dilate(soft, _k(5)).astype(bool)) & (alpha > 0.02)


# --- ffmpeg I/O: probe / encoder_args / streaming loop now live in matte_io ---
def detect_key(path, w, h, n):
    """One plate colour for the whole clip, from edges of frames sampled across it."""
    idxs = np.linspace(0, max(n-1, 0), num=min(9, max(n, 1)), dtype=int)
    sel = '+'.join(f'eq(n\\,{i})' for i in sorted(set(int(i) for i in idxs)))
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vf', f'select={sel}',
                        '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                       capture_output=True, check=True)
    frames = np.frombuffer(p.stdout, np.uint8).reshape(-1, h, w, 3)[..., ::-1] / 255.0  # -> BGR
    ab = np.concatenate([edge_band(f.astype(np.float32)) for f in frames])
    return detect_key_from_bands(ab)


def _hex_to_bgr(s):
    s = s.lstrip('#')
    if len(s) != 6:
        raise SystemExit(f'expected #rrggbb, got "{s}"')
    r, g, b = (int(s[i:i+2], 16) for i in (0, 2, 4))
    return np.array([b, g, r], np.float32) / 255.0


def _bgr_to_hex(bgr):
    r, g, b = (int(round(float(c) * 255)) for c in bgr[::-1])
    return '#%02x%02x%02x' % (r, g, b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--format', default='prores4444', choices=['prores4444', 'webm', 'png'])
    ap.add_argument('--despill', default='true', choices=['true', 'false'])
    ap.add_argument('--feather', type=float, default=1.2)
    # Composable surface: a basic matte core (--matte) plus an optional edge
    # refinement (--refine). 'chroma' is the colour-distance key; it has no final
    # alpha of its own, so it requires closed-form refinement. 'keylight' is the
    # per-pixel keyer and can run raw (refine none) or refined.
    ap.add_argument('--matte', dest='matte_core', default=None,
                    choices=['chroma', 'keylight'])
    ap.add_argument('--refine', dest='refine', default=None,
                    choices=['none', 'closed-form'])
    # Deprecated alias, kept so existing commands and direct callers keep working:
    #   --key-engine trimap   == --matte chroma  --refine closed-form
    #   --key-engine keylight == --matte keylight --refine none
    ap.add_argument('--key-engine', dest='key_engine', default=None,
                    choices=['trimap', 'keylight'])
    # Keylight-only controls (ignored by the trimap engine; the Node/CLI layer
    # refuses to pass them there). 'auto' reuses the plate auto-detect / per-frame
    # bias derivation; a #rrggbb pins the value.
    ap.add_argument('--screen-colour', dest='screen_colour', default='auto')
    ap.add_argument('--screen-balance', dest='screen_balance', type=float, default=0.5)
    ap.add_argument('--clip-black', dest='clip_black', type=float, default=0.0)
    ap.add_argument('--clip-white', dest='clip_white', type=float, default=1.0)
    ap.add_argument('--screen-gain', dest='screen_gain', type=float, default=1.0)
    ap.add_argument('--screen-pre-blur', dest='screen_pre_blur', type=float, default=0.0)
    ap.add_argument('--despill-bias', dest='despill_bias', default='auto')
    ap.add_argument('--inside-mask', dest='inside_mask', default=None)
    ap.add_argument('--outside-mask', dest='outside_mask', default=None)
    args = ap.parse_args()

    # Resolve core + refine from the new flags, the deprecated alias, or defaults.
    if args.matte_core is not None or args.refine is not None:
        core = args.matte_core or 'chroma'
        refine = args.refine or ('none' if core == 'keylight' else 'closed-form')
    elif args.key_engine is not None:
        core, refine = ('keylight', 'none') if args.key_engine == 'keylight' \
            else ('chroma', 'closed-form')
    else:
        core, refine = 'chroma', 'closed-form'  # historical default (== trimap)
    if core == 'chroma' and refine != 'closed-form':
        raise SystemExit('--matte chroma has no final alpha of its own — it requires '
                         '--refine closed-form')

    keylight = core == 'keylight'
    despill = args.despill == 'true'
    w, h, fps, n = probe(args.input)

    if keylight and args.screen_colour != 'auto':
        key = _hex_to_bgr(args.screen_colour)
        spread = 0.0
    else:
        key, spread = detect_key(args.input, w, h, n)
    keyhex = _bgr_to_hex(key)
    bias = None if not despill else (
        'auto' if args.despill_bias == 'auto' else _hex_to_bgr(args.despill_bias))
    tag = f'{core}+{refine}'
    if keylight:
        log(f'{tag} matte: key={keyhex} balance={args.screen_balance} '
            f'clip=[{args.clip_black},{args.clip_white}] {w}x{h}@{fps:.3f} frames={n}')
    else:
        log(f'{tag} matte: key={keyhex} spread={spread:.3f} {w}x{h}@{fps:.3f} frames={n}')
    kmax = int(np.argmax(key))
    spill_before, spill_after = [], []

    def process(bgr, i):
        """One frame -> (F_rgb, alpha), plus per-frame spill accounting for keylight."""
        if keylight:
            alpha, F = keylight_alpha(
                bgr, key, balance=args.screen_balance, gain=args.screen_gain,
                clip_black=args.clip_black, clip_white=args.clip_white,
                pre_blur=args.screen_pre_blur, bias=bias, despill=despill)
            if refine == 'closed-form':
                # Hand the keylight core to the shared closed-form refiner (trimap
                # derived from the alpha, no plate priors). It owns the softening,
                # so the keylight-stage Gaussian feather is skipped.
                alpha, F = refine_edges(F.astype(np.float64), alpha=alpha.astype(np.float64),
                                        feath=args.feather)
                inside = load_mask(args.inside_mask, i, w, h)
                outside = load_mask(args.outside_mask, i, w, h)
                alpha = apply_masks(alpha, inside, outside)
            else:
                inside = load_mask(args.inside_mask, i, w, h)
                outside = load_mask(args.outside_mask, i, w, h)
                alpha = apply_masks(alpha, inside, outside)
                if args.feather > 0:
                    alpha = cv2.GaussianBlur(alpha.astype(np.float32), (0, 0), args.feather)
                    alpha = apply_masks(alpha, inside, outside)  # masks stay authoritative
            if despill:
                edge = edge_mask_alpha(alpha)
                spill_before.append(key_fraction(bgr, edge, kmax))
                spill_after.append(key_fraction(F[..., ::-1], edge, kmax))  # F is RGB
        else:
            alpha, F = matte(bgr, key, spread, feath=args.feather, despill=despill)
        return F, alpha  # F is RGB

    def guard(frames, mean_cov, tmp):
        # Never leave a plausible-but-wrong file on disk (mirrors python/matte.py).
        # A keyer that crushed everything to background or passed everything as
        # foreground has failed, whatever the exit code.
        if keylight and (mean_cov < 0.001 or mean_cov > 0.999):
            reject(tmp, f'degenerate keylight matte: mean coverage {mean_cov:.4f} — the key '
                        'collapsed to all-background or all-foreground (check --screen-colour '
                        'and --clip-black/--clip-white)')

    frames, mean_cov, elapsed = run_stream(
        args.input, args.output, args.format, w, h, fps, n, process, on_done=guard)

    spf = elapsed / max(frames, 1)
    report = {'frames': frames, 'secondsPerFrame': round(spf, 3),
              'meanCoverage': round(mean_cov, 4), 'method': 'plate',
              'matte': core, 'refine': refine, 'key': keyhex}
    if keylight:
        report.update({'screenBalance': args.screen_balance,
                       'clipBlack': args.clip_black, 'clipWhite': args.clip_white})
        if spill_before:
            report['edgeSpillBefore'] = round(float(np.mean(spill_before)), 4)
            report['edgeSpillAfter'] = round(float(np.mean(spill_after)), 4)
    else:
        report['plateSpread'] = round(spread, 4)
    print(json.dumps(report))


if __name__ == '__main__':
    main()
