#!/usr/bin/env python3
"""Join 2-4 clips with WaveSpeed's hosted Wan VACE Video Joiner ($0.20 per join).
Key: ~/.wavespeed/key (one line). Usage:
  vace_join.py A.mp4 B.mp4 [C.mp4 ...] --out joined.mp4 [--dry-run] [--pushin SECS]
--pushin: for two clips framed differently (wide -> close), first digitally push A's last SECS
onto B's framing (free, stitch.py's reframe) so the joiner only blends the small leftover gap
instead of snapping between framings.
"""
import argparse, json, os, sys, time, subprocess, urllib.request

API = "https://api.wavespeed.ai/api/v3"
KEY_FILE = os.path.expanduser("~/.wavespeed/key")

def key():
    try:
        k = open(KEY_FILE).read().strip()
    except FileNotFoundError:
        sys.exit(f"No WaveSpeed key at {KEY_FILE}. Save your WaveSpeed API key in that file first.")
    if not k: sys.exit("WaveSpeed key file is empty.")
    return k

def curl_json(args):
    out = subprocess.run(["curl", "-sS", "--fail-with-body"] + args, capture_output=True, text=True)
    try:
        j = json.loads(out.stdout)
    except Exception:
        sys.exit(f"Bad response: {out.stdout[:500]} {out.stderr[:500]}")
    if out.returncode != 0 or j.get("code") not in (200, None):
        sys.exit(f"WaveSpeed error: {json.dumps(j)[:800]}")
    return j

def upload(path, k):
    j = curl_json(["-X", "POST", f"{API}/media/upload/binary",
                   "-H", f"Authorization: Bearer {k}", "-F", f"file=@{path}"])
    url = (j.get("data") or {}).get("download_url")
    if not url: sys.exit(f"Upload gave no URL: {j}")
    print(f"uploaded {os.path.basename(path)}")
    return url

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pushin", type=float, default=0.0)
    a = ap.parse_args()
    if not 2 <= len(a.clips) <= 4: sys.exit("Give 2 to 4 clips.")
    cost = 0.20 * (len(a.clips) - 1)
    print(f"{len(a.clips)} clips, {len(a.clips)-1} join(s), about ${cost:.2f}")
    if a.dry_run: return
    k = key()
    if a.pushin and len(a.clips) == 2:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import stitch
        A = stitch.read_all(a.clips[0]); B = stitch.read_all(a.clips[1])
        fps = stitch.probe(a.clips[0])["fps"]
        M, info = stitch.estimate_similarity(A[-1], B[0])
        if M is None: sys.exit(f"Couldn't match framing between the clips: {info}")
        n = min(len(A) - 1, int(round(a.pushin * fps)))
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        pushed = os.path.splitext(a.out)[0] + "_A_pushin.mp4"
        stitch.write_video(stitch.reframe_tail(A, M, n), pushed, fps)
        print(f"pushed A's last {n} frames onto B's framing: {info}")
        a.clips[0] = pushed
    urls = [upload(c, k) for c in a.clips]
    j = curl_json(["-X", "POST", f"{API}/wavespeed-ai/vace-video-joiner",
                   "-H", f"Authorization: Bearer {k}", "-H", "Content-Type: application/json",
                   "-d", json.dumps({"videos": urls})])
    pid = j["data"]["id"]; print("job", pid)
    t0 = time.time()
    while True:
        time.sleep(3)
        r = curl_json(["-H", f"Authorization: Bearer {k}", f"{API}/predictions/{pid}/result"])["data"]
        s = r.get("status")
        if s == "completed": break
        if s in ("failed", "cancelled", "timeout", "deleted"):
            sys.exit(f"Job {s}: {r.get('error')}")
        if time.time() - t0 > 1800: sys.exit("Timed out after 30 min")
    out_url = r["outputs"][0]
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    urllib.request.urlretrieve(out_url, a.out)
    json.dump(r, open(os.path.splitext(a.out)[0] + "_wavespeed.json", "w"), indent=2)
    print(f"done in {time.time()-t0:.0f}s -> {a.out}")

if __name__ == "__main__":
    main()
