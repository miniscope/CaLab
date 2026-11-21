"""Saddle test on merge-log pairs: is the union of the two current footprints one
single-peaked blob? Adds `sad_eq` (equal peaks) and `sad_tr` (weighted by each
cell's mean test-frame light) = min of the PSF-smoothed sum on the segment between
the two footprints' peaks over the lower end; < 1 means two peaks.
Usage: merge_saddle.py LABELS.tsv RUN_ROOT  (rewrites LABELS.tsv with the columns)"""
import json, sys
from pathlib import Path
import numpy as np
import pandas as pd


def dense(pix, val, w, box):
    y0, x0, h, ww = box
    img = np.zeros((h, ww))
    pix = np.asarray(pix, int)
    img[pix // w - y0, pix % w - x0] = val
    return img


def smooth(img, sigma=1.5):
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    img = np.apply_along_axis(lambda v: np.convolve(v, k, "same"), 0, img)
    return np.apply_along_axis(lambda v: np.convolve(v, k, "same"), 1, img)


def saddle(r):
    w = r["width"]
    a, b = r["a"], r["b"]
    pix = np.concatenate([a["pix"], b["pix"]]).astype(int)
    y0, x0 = pix // w, pix % w
    box = (y0.min() - 5, x0.min() - 5, y0.max() - y0.min() + 11, x0.max() - x0.min() + 11)
    fa = smooth(dense(a["pix"], a["filt"], w, box))
    fb = smooth(dense(b["pix"], b["filt"], w, box))
    pa = np.array(np.unravel_index(np.argmax(fa), fa.shape))
    pb = np.array(np.unravel_index(np.argmax(fb), fb.shape))
    out = {}
    ca = np.mean(np.abs(r.get("pair_c0", [1.0]))) if r.get("pair_id0") == a["id"] else np.mean(np.abs(r.get("pair_c1", [1.0])))
    cb = np.mean(np.abs(r.get("pair_c1", [1.0]))) if r.get("pair_id1") == b["id"] else np.mean(np.abs(r.get("pair_c0", [1.0])))
    for key, (wa, wb) in (("sad_eq", (1 / fa.max(), 1 / fb.max())), ("sad_tr", (ca, cb))):
        s = wa * fa + wb * fb
        n = max(int(np.ceil(np.hypot(*(pa - pb)) * 4)), 2)
        t = np.linspace(0, 1, n)
        yy = pa[0] + t * (pb[0] - pa[0])
        xx = pa[1] + t * (pb[1] - pa[1])
        # bilinear sample
        y0f, x0f = np.floor(yy).astype(int), np.floor(xx).astype(int)
        dy, dx = yy - y0f, xx - x0f
        y1f, x1f = np.minimum(y0f + 1, s.shape[0] - 1), np.minimum(x0f + 1, s.shape[1] - 1)
        prof = (s[y0f, x0f] * (1 - dy) * (1 - dx) + s[y1f, x0f] * dy * (1 - dx)
                + s[y0f, x1f] * (1 - dy) * dx + s[y1f, x1f] * dy * dx)
        lo = min(prof[0], prof[-1])
        out[key] = float(prof.min() / lo) if lo > 0 else np.nan
    return out


lab = pd.read_csv(sys.argv[1], sep="\t")
root = Path(sys.argv[2])
want = {(r.run, r.frame, r.lo, r.hi) for r in lab.itertuples()}
feat = {}
for run in lab.run.unique():
    for line in open(root / run / "merges.jsonl"):
        r = json.loads(line)
        k = (run, r["frame"], r["lo"], r["hi"])
        if k in want:
            feat[k] = saddle(r)
for c in ("sad_eq", "sad_tr"):
    lab[c] = [feat.get((r.run, r.frame, r.lo, r.hi), {}).get(c, np.nan) for r in lab.itertuples()]
lab.to_csv(sys.argv[1], sep="\t", index=False)
print("saddle features added for", len(feat))
