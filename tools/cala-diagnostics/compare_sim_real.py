"""Side-by-side real vs sim arms with one fixed display range (no auto-contrast).

  compare_sim_real.py [REAL_START_FRAME]

Rows: one frame, mean, max and temporal std of 1200 frames. The display range of each row is
the real recording's 99.5th percentile, shared by every column. Edit ARMS for the sim dirs
(each holds daq/Miniscope/*.avi). Writes compare_projections.png and compare_zoom.png next to
this script's working directory. RAM: one recording at a time, 1200 frames as float32, about 2 GB.
"""
import os, re, sys
import numpy as np, cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.getcwd()
REAL = "/Users/daharoni/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw"
ARMS = {"real": REAL, "static/motion": HERE + "/prev/motion/daq/Miniscope",
        "halo": HERE + "/prev/halo/daq/Miniscope", "oof": HERE + "/prev/oof/daq/Miniscope"}
NF = 1200
START = 6000 if len(sys.argv) < 2 else int(sys.argv[1])


def read(d, start, n):
    fs = sorted([f for f in os.listdir(d) if re.fullmatch(r"\d+\.avi", f)], key=lambda f: int(f[:-4]))
    out, pos = [], 0
    for f in fs:
        cap = cv2.VideoCapture(os.path.join(d, f))
        m = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if pos + m <= start:
            pos += m
            continue
        if start > pos:
            cap.set(cv2.CAP_PROP_POS_FRAMES, start - pos)
            pos = start
        while len(out) < n:
            ok, fr = cap.read()
            if not ok:
                break
            out.append(fr[..., 0].astype(np.float32))
            pos += 1
        if len(out) >= n:
            break
    return np.array(out)


data = {}
for k, d in ARMS.items():
    s = START if k == "real" else 0
    v = read(d, s, NF)
    data[k] = dict(frame=v[600], mean=v.mean(0), mx=v.max(0), std=v.std(0))
    print(k, v.shape, "mean", v.mean().round(1), "p1/p99 of mean", np.percentile(v.mean(0), [1, 99]).round(1))
ref = data["real"]
rng = {"frame": (np.percentile(ref["mean"], 1) * 0, np.percentile(ref["frame"], 99.5)),
       "mean": (0, np.percentile(ref["mean"], 99.5)),
       "mx": (0, np.percentile(ref["mx"], 99.5)),
       "std": (0, np.percentile(ref["std"], 99.5))}
print("fixed ranges", rng)
fig, ax = plt.subplots(4, 4, figsize=(16, 16))
for j, (k, v) in enumerate(data.items()):
    for i, key in enumerate(["frame", "mean", "mx", "std"]):
        lo, hi = rng[key]
        ax[i, j].imshow(v[key], cmap="gray", vmin=lo, vmax=hi)
        ax[i, j].set_xticks([]); ax[i, j].set_yticks([])
        if i == 0:
            ax[i, j].set_title(k)
        if j == 0:
            ax[i, j].set_ylabel({"frame": "single frame", "mean": "mean proj", "mx": "max proj", "std": "temporal std"}[key])
fig.suptitle("fixed display ranges per row = real data p99.5 (no auto-contrast); sims 60 s, real frames %d-%d" % (START, START + NF))
plt.tight_layout()
plt.savefig(HERE + "/compare_projections.png", dpi=70)
# zoomed crops of the mean projection (300x300 centre)
fig, ax = plt.subplots(2, 4, figsize=(16, 8))
for j, (k, v) in enumerate(data.items()):
    for i, key in enumerate(["frame", "std"]):
        lo, hi = rng[key]
        ax[i, j].imshow(v[key][150:450, 150:450], cmap="gray", vmin=lo, vmax=hi)
        ax[i, j].set_xticks([]); ax[i, j].set_yticks([])
        ax[0, j].set_title(k)
plt.tight_layout()
plt.savefig(HERE + "/compare_zoom.png", dpi=70)
