"""Per-GT-unit matched-filter SNR and cala recovery, for one sim and its qc_eval run.

usage: $MINISIM_PY recovery_vs_snr.py SIM_DIR RUN_DIR OUT_TSV        (minisim >= 1.1)

One row per GT unit that qc_eval scores (its gt.tsv, aligned to oracle.bin by a
monotone DP on centroids): depth, centre, the oracle.bin detectable flag, qc_eval's
own peak SNR, minisim's matched-filter SNR (`mf_snr`) and its parts (transient energy,
effective footprint and active-frame counts) and `recovered` (a final cala cell matched
it). Used to calibrate DETECT_SNR_THRESHOLD (minisim 1.1.0): see
results/2026-11-12-matched-filter-detectable.md. Pool rows over runs and fit a logistic
in log SNR for the 50 % point.
"""
import struct, sys
from pathlib import Path
import numpy as np
from minisim import Spec, load_ground_truth, matched_filter_snr
from minisim.recording import transient_energy

sim, run, out = map(Path, sys.argv[1:4])
spec = Spec.model_validate_json((sim / "spec.json").read_text())
gt, _ = load_ground_truth(sim / "daq/ground_truth/ground_truth.zarr")
snr = matched_filter_snr(gt, spec)
energy = transient_energy(gt.C, gt.bleaching)
n_frames = gt.C.shape[1]
from minisim.recording import detection_noise_fields
gain_e, mean_e = detection_noise_fields(gt, spec)
inv_var = gain_e**2 / (mean_e + spec.acquisition.image_sensor.read_noise_e**2)
n_s, peak2 = [], []
for fp in gt.observed_footprints():
    if fp.is_empty:
        n_s.append(np.nan); peak2.append(0.0); continue
    y0, x0 = fp.offset; ph, pw = fp.patch.shape
    q = fp.patch.astype(float)**2 * inv_var[y0:y0+ph, x0:x0+pw]
    n_s.append(q.sum()**2 / (q*q).sum()); peak2.append(q.max())
n_s = np.array(n_s); peak2 = np.array(peak2)
dl = gt.C - gt.C.min(axis=1, keepdims=True)
if gt.bleaching is not None: dl = dl * gt.bleaching
d2 = dl**2
n_t = d2.sum(1)**2 / np.maximum((d2*d2).sum(1), 1e-300)
pkt = d2.max(1)

# oracle.bin unit headers
b = (sim / "oracle.bin").read_bytes()
H, W, n, T = struct.unpack("<4I", b[8:24]); off = 24
units = []
for _ in range(n):
    i, det, foc, cy, cx = struct.unpack("<IBBxxff", b[off:off + 16]); off += 16
    nz = []
    for _f in range(2):
        y0, x0, ph, pw = struct.unpack("<iiII", b[off:off + 16]); off += 16
        v = np.frombuffer(b, np.float32, ph * pw, off); off += 4 * ph * pw
        if _f == 0:
            if v.sum() > 0:
                m = v.reshape(ph, pw).astype(float); yy, xx = np.mgrid[0:ph, 0:pw]
                gy, gx = y0 + (m * yy).sum() / m.sum(), x0 + (m * xx).sum() / m.sum()
            else:
                gy = gx = -1e6
        nz.append(bool((v > 0).any()))
    units.append((i, det, foc, gy, gx, nz[0], cy, cx))
rows = [l.split("\t") for l in (run / "gt.tsv").read_text().splitlines()[1:]]
# gt.tsv is the subsequence of oracle units inside qc_eval's sensor mask: align by DP
# (monotone, one unit per row, cost = centroid distance, det flags must agree).
m = len(rows)
U = np.array([[u[3], u[4]] for u in units]); Ud = np.array([u[1] for u in units])
Rxy = np.array([[float(r[1]), float(r[2])] for r in rows]); Rd = np.array([int(r[3]) for r in rows])
cost = np.hypot(Rxy[:, None, 0] - U[None, :, 0], Rxy[:, None, 1] - U[None, :, 1])
cost = np.minimum(cost, 200.0) + np.where(Rd[:, None] == Ud[None, :], 0.0, 1e6)
INF = 1e18
D = np.full((m + 1, n + 1), INF); D[0, :] = 0.0
for i in range(1, m + 1):
    prev = D[i - 1]
    for j in range(1, n + 1):
        D[i, j] = min(D[i, j - 1], prev[j - 1] + cost[i - 1, j - 1])
kept = [None] * m; i, j = m, n
while i > 0:
    if D[i, j] == D[i, j - 1]:
        j -= 1
    else:
        kept[i - 1] = units[j - 1]; i -= 1; j -= 1
d = np.array([np.hypot(float(r[1]) - u[3], float(r[2]) - u[4]) for r, u in zip(rows, kept)])

lines = (run / "cells.tsv").read_text().splitlines()
hdr = lines[0].split("\t"); last = lines[-1].split("\t")[0]
fin = [l.split("\t") for l in lines[1:] if l.split("\t")[0] == last]
im, ig = hdr.index("matched"), hdr.index("gt")
hit = {int(r[ig]) for r in fin if r[im] == "1" and int(r[ig]) >= 0}
n_matched = sum(r[im] == "1" for r in fin)
with open(out, "w") as fh:
    fh.write("j\tunit\tdepth_um\tcy\tcx\told_det\tin_focus\tqc_snr\tmf_snr\tenergy\tn_s\tn_t\tpeak2_s\tpeak2_t\trecovered\n")
    for j, (r, u) in enumerate(zip(rows, kept)):
        k = u[0]
        fh.write(f"{j}\t{k}\t{gt.centers_um[k,0]:.1f}\t{u[6]:.1f}\t{u[7]:.1f}\t{u[1]}\t{u[2]}\t{r[4]}\t{snr[k]:.3f}\t{energy[k]:.4g}\t{n_s[k]:.2f}\t{n_t[k]:.2f}\t{peak2[k]:.4g}\t{pkt[k]:.4g}\t{int(j in hit)}\n")
print(sim.name, "units", n, "kept", len(kept), "centroid-peak dist p95", np.percentile(d, 95).round(2),
      "final cells", len(fin), "matched", n_matched, "matched w/ gt id", len(hit), "frames", n_frames)
