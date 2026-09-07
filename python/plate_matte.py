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
import argparse, json, os, subprocess, sys, tempfile, time
import numpy as np, cv2
from pymatting import estimate_alpha_cf, estimate_foreground_ml


def log(msg): print(msg, file=sys.stderr, flush=True)
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


def matte(img, key, spread, tdark=0.34, ringpx=7, clight=0.42, cbias=1.3,
          feath=1.1, kcarve=0.22, kencl=0.32, despill=True):
    """img BGR float [0,1] -> (alpha HxW, F RGB HxW)."""
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
    alpha = estimate_alpha_cf(rgb, tri.astype(np.float64))
    alpha = np.maximum(alpha, (FG_def == 1).astype(np.float64))
    if feath > 0:
        alpha = cv2.GaussianBlur(alpha.astype(np.float32), (0, 0), feath).astype(np.float64)
        alpha = np.maximum(alpha, cv2.erode((FG_def == 1).astype(np.uint8), _k(5)).astype(np.float64))
    alpha = np.clip(alpha, 0, 1)
    F = estimate_foreground_ml(rgb, alpha)
    return alpha, F


# --- ffmpeg I/O (mirrors python/matte.py) -----------------------------------
def probe(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_frames',
         '-show_entries', 'stream=width,height,avg_frame_rate,nb_read_frames',
         '-of', 'json', path], capture_output=True, text=True, check=True)
    s = json.loads(out.stdout)['streams'][0]
    num, den = (s['avg_frame_rate'].split('/') + ['1'])[:2]
    fps = float(num)/float(den) if float(den) else 24.0
    return int(s['width']), int(s['height']), fps, int(s.get('nb_read_frames') or 0)


def encoder_args(fmt, w, h, fps, output, source):
    common = ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
              '-s', f'{w}x{h}', '-r', f'{fps}', '-i', 'pipe:0',
              '-i', source, '-map', '0:v:0', '-map', '1:a:0?', '-c:a', 'copy']
    if fmt == 'prores4444':
        return common + ['-c:v', 'prores_ks', '-profile:v', '4444',
                         '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', output]
    if fmt == 'webm':
        return common + ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', output]
    if fmt == 'png':
        return ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
                '-s', f'{w}x{h}', '-r', f'{fps}', '-i', 'pipe:0', os.path.join(output, '%05d.png')]
    raise SystemExit(f'unknown format: {fmt}')


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--format', default='prores4444', choices=['prores4444', 'webm', 'png'])
    ap.add_argument('--despill', default='true', choices=['true', 'false'])
    ap.add_argument('--feather', type=float, default=1.2)
    args = ap.parse_args()

    w, h, fps, n = probe(args.input)
    key, spread = detect_key(args.input, w, h, n)
    kr = (key[::-1]*255).astype(int)
    keyhex = '#%02x%02x%02x' % (kr[0], kr[1], kr[2])
    log(f'plate matte: key={keyhex} spread={spread:.3f} {w}x{h}@{fps:.3f} frames={n}')
    if args.format == 'png':
        os.makedirs(args.output, exist_ok=True)

    out_tmp = args.output if args.format == 'png' else args.output + '.tmp' + \
        os.path.splitext(args.output)[1]
    dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', args.input, '-f', 'rawvideo',
                            '-pix_fmt', 'rgb24', 'pipe:1'], stdout=subprocess.PIPE)
    enc = subprocess.Popen(encoder_args(args.format, w, h, fps, out_tmp, args.input),
                           stdin=subprocess.PIPE)
    despill = args.despill == 'true'
    fsz = w*h*3; i = 0; cov = 0.0; t0 = time.time()
    while True:
        buf = dec.stdout.read(fsz)
        if len(buf) < fsz: break
        bgr = np.frombuffer(buf, np.uint8).reshape(h, w, 3)[..., ::-1].astype(np.float32)/255.0
        alpha, F = matte(bgr, key, spread, feath=args.feather, despill=despill)
        rgba = np.dstack([F*255, alpha*255]).astype(np.uint8)   # F is RGB
        enc.stdin.write(rgba.tobytes())
        cov += float(alpha.mean()); i += 1
        if i % 20 == 0: log(f'  {i}/{n} frames')
    enc.stdin.close(); dec.wait(); rc = enc.wait()
    if rc != 0:
        raise SystemExit(f'ffmpeg encode failed (exit {rc})')
    if args.format != 'png':
        os.replace(out_tmp, args.output)

    spf = (time.time()-t0)/max(i, 1)
    print(json.dumps({'frames': i, 'secondsPerFrame': round(spf, 3),
                      'meanCoverage': round(cov/max(i, 1), 4), 'method': 'plate',
                      'key': keyhex, 'plateSpread': round(spread, 4)}))


if __name__ == '__main__':
    main()
