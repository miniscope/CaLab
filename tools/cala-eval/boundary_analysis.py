"""Trace artifacts at a session boundary: one qc_eval run per arm, scored against GT.

    python3 tools/cala-eval/boundary_analysis.py analyze <run> <sim> [--boundary 4800]
    python3 tools/cala-eval/boundary_analysis.py report <runs root> <out dir> [--boundary 4800]

`analyze` reads a `qc_eval sim ... --motion --churn-log --boundary-log` run (diagnostics
build) of a sim made by `stitch_sessions.py`, and writes `<run>/boundary.json` and
`<run>/boundary_curves.npz`. `report` reads every `<root>/<base>_s<seed>_<arm>/` run,
prints markdown tables and writes PNG plots to `<out dir>`.

Per final cell matched to a detectable GT unit (footprint r >= 0.7, `final.tsv`) whose
GT centre is at least 30 px from the frame edge, and whose online trace covers frames
1500..9600 (`boundary_traces.bin`):

* Fit `x = a c + b` (cala's online trace `x`, the GT trace `c` of `oracle.bin`) on the
  session-A reference window, frames 1500..4700. Peak signal `P = a * max(c)` there.
* Residual `e = x - (a c + b)`, in units of `P` (so 0.05 = 5 % of the cell's peak).
* In each window after the boundary B (0-10, 10-100, 100-1000, 1000-3000 frames after,
  and the mid-session B window 3000-4800 after) and in a session-A control window
  (1000-100 frames before B): `off` = median over cells of the window mean of `e`
  (baseline / offset error) and `scale` = median over cells of `1 + da / a` from the
  regression `e = da c + db` (windows of 100+ frames). `rms` = median of the window RMS
  of `e` (all errors, the excess over the A control is the artifact).
* Curves (median over cells per frame, B-500 .. end): `e / P`, the ring-background level
  change `(bg - mean_A bg) / P`, and the preprocessing records (`boundary_pre.tsv`).
"""

import argparse
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from summarize import run_metrics  # noqa: E402

REF = (1500, 4700)
EDGE_PX = 30
WINDOWS = [("A ctl", -1000, -100), ("0-10", 0, 10), ("10-100", 10, 100), ("100-1000", 100, 1000),
           ("1000-3000", 1000, 3000), ("mid B", 3000, 4800)]  # fmt: skip


def read_tsv(p: Path) -> list[dict]:
    lines = p.read_text().splitlines()
    h = lines[0].split("\t")
    return [dict(zip(h, l.split("\t"))) for l in lines[1:] if l]


def read_oracle_c(p: Path) -> np.ndarray:
    with open(p, "rb") as f:
        assert f.read(8) == b"CALAORC1"
        h, w, n, t = struct.unpack("<4I", f.read(16))
        for _ in range(n):
            f.seek(4 + 4 + 8, 1)
            for _ in range(2):
                y0, x0, ph, pw = struct.unpack("<4I", f.read(16))
                f.seek(4 * ph * pw, 1)
        return np.frombuffer(f.read(4 * n * t), dtype="<f4").reshape(n, t)


def read_traces(p: Path) -> dict[int, tuple[int, np.ndarray, np.ndarray]]:
    b = p.read_bytes()
    assert b[:8] == b"CALABTL1"
    (n,) = struct.unpack_from("<I", b, 8)
    o = 12
    out = {}
    for _ in range(n):
        cid, t0, ln = struct.unpack_from("<QII", b, o)
        o += 16
        c = np.frombuffer(b, "<f4", ln, o)
        o += 4 * ln
        bg = np.frombuffer(b, "<f4", ln, o)
        o += 4 * ln
        out[cid] = (t0, c, bg)
    return out


def analyze(run: Path, sim: Path, boundary: int) -> dict:
    gt = read_tsv(run / "gt.tsv")
    final = read_tsv(run / "final.tsv")
    C = read_oracle_c(sim / "oracle.bin")
    tr = read_traces(run / "boundary_traces.bin")
    T = C.shape[1]
    cells = []
    for r in final:
        if r["matched"] != "1":
            continue
        g = gt[int(r["best_gt"])]
        if g["detectable"] != "1":
            continue
        cy, cx = float(g["cy"]), float(g["cx"])
        if min(cy, cx, 599 - cy, 599 - cx) < EDGE_PX:
            continue
        cid = int(r["id"])
        if cid not in tr:
            continue
        t0, x, bg = tr[cid]
        if t0 > REF[0] or t0 + len(x) < T:
            continue
        x = np.asarray(x[REF[0] - t0 : T - t0], np.float64)
        bg = np.asarray(bg[REF[0] - t0 : T - t0], np.float64)
        c = C[int(g["unit"])][REF[0] :].astype(np.float64)
        cells.append((cid, x, bg, c))
    off0 = REF[0]
    rs = slice(0, REF[1] - off0)
    sB = slice(boundary + 3000 - off0, boundary + 4800 - off0)

    def fit(x, c, sl):
        m = np.zeros(len(x), bool)
        m[sl] = True
        m &= np.isfinite(x)
        if m.sum() < 100 or c[m].std() == 0:
            return math.nan, math.nan
        A = np.vstack([c[m], np.ones(m.sum())]).T
        (a, b), *_ = np.linalg.lstsq(A, x[m], rcond=None)
        return a, b

    EA, EB, BG, ratios = [], [], [], []
    for cid, x, bg, c in cells:
        a, b = fit(x, c, rs)
        aB, bB = fit(x, c, sB)
        peak = a * c[rs].max()
        if not (a > 0 and peak > 0 and math.isfinite(aB)):
            continue
        EA.append((x - (a * c + b)) / peak)
        EB.append((x - (aB * c + bB)) / peak)
        BG.append((bg - np.nanmean(bg[rs])) / peak)
        ratios.append(aB / a)
    EA, EB, BG = np.array(EA), np.array(EB), np.array(BG)
    out = {"cells": len(EA), "windows": {}, "scale_ratio_midB": float(np.median(ratios))}
    q = lambda v: float(np.median(v)) if len(v) else math.nan  # noqa: E731
    for name, lo, hi in WINDOWS:
        s_, t_ = boundary + lo - off0, boundary + hi - off0
        wa, wb = EA[:, s_:t_], EB[:, s_:t_]
        oka = np.isfinite(wa).sum(1) >= 0.8 * (t_ - s_)
        offA = np.nanmean(wa[oka], axis=1)
        offB = np.nanmean(wb[oka], axis=1)
        rms = np.sqrt(np.nanmean(wb[oka] ** 2, axis=1))
        out["windows"][name] = {
            "off": q(offA),  # vs the session-A model: includes the lasting B change
            "offB": q(offB),  # vs B's own steady state (mid B): the transient alone
            "offB_p90abs": float(np.percentile(np.abs(offB), 90)) if len(offB) else math.nan,
            "rms": q(rms),
            "n": int(oka.sum()),
        }
    curve_from = boundary - 500 - off0
    curves = {
        "t": np.arange(boundary - 500, boundary - 500 + EA.shape[1] - curve_from),
        "e_med": np.nanmedian(EA[:, curve_from:], axis=0),
        "eB_med": np.nanmedian(EB[:, curve_from:], axis=0),
        "eB_q25": np.nanpercentile(EB[:, curve_from:], 25, axis=0),
        "eB_q75": np.nanpercentile(EB[:, curve_from:], 75, axis=0),
        "bg_med": np.nanmedian(BG[:, curve_from:], axis=0),
    }
    # The transient: the B-referenced median curve minus its mid-B level, smoothed
    # over 10 frames; its peak (0-500 frames after B) and an exponential fit
    # e(t) = amp exp(-t / tau) from the peak on (grid search on tau, 4000 frames).
    eb = curves["eB_med"]
    ctl = float(np.nanmean(eb[500 + 3000 : 500 + 4800]))  # B's steady state (mid B)
    k = np.convolve(np.nan_to_num(eb - ctl), np.ones(10) / 10, mode="same")[500:]
    pk = int(np.argmax(np.abs(k[:500])))
    out["transient"] = {"peak": float(k[pk]), "peak_frame": pk, "ctl_level": ctl}
    seg = k[pk : pk + 4000]
    tt = np.arange(len(seg))
    best = (math.inf, math.nan, math.nan)
    for tau in np.geomspace(2, 20000, 160):
        g = np.exp(-tt / tau)
        amp = float(g @ seg / (g @ g))
        r = float(np.sum((amp * g - seg) ** 2))
        if r < best[0]:
            best = (r, float(tau), amp)
    out["decay"] = {"tau_frames": best[1], "amp": best[2], "from_frame": pk}
    # Preprocessing, motion and edits around the boundary.
    pre = read_tsv(run / "boundary_pre.tsv")
    fr = np.array([int(r["frame"]) for r in pre])
    col = lambda k: np.array([float(r[k]) for r in pre])  # noqa: E731
    for k in ("input_mean", "flicker_gain", "flicker_offset", "floor_mean", "noise_mean", "motion_quality",
              "lowpass_mean", "floor_lowered"):  # fmt: skip
        curves["pre_" + k] = col(k)
    curves["pre_frame"] = fr
    curves["pre_flags"] = np.array([int(r["motion_flags"]) for r in pre])
    mot = read_tsv(run / "motion.tsv")
    md = np.array([[float(r["dy"]), float(r["dx"])] for r in mot])
    curves["motion"] = md
    sh = sim / "shifts.npy"
    if sh.exists():
        m = np.load(sh)[: len(md)]
        resid = md + m  # constant when registration is right
        base = np.median(resid[boundary - 1000 : boundary], axis=0)
        err = np.hypot(*(resid - base).T)
        curves["reg_err"] = err
        after = err[boundary : boundary + 200]
        caught = np.nonzero(after < 0.5)[0]
        out["registration"] = {
            "err_first_frame": float(after[0]),
            "frames_to_0.5px": int(caught[0]) if len(caught) else -1,
            "err_med_B": float(np.median(err[boundary + 100 :])),
            "err_med_A": float(np.median(err[1000:boundary])),
            "err_max_B": float(err[boundary:].max()),
        }
    flags = curves["pre_flags"]
    bi = np.searchsorted(fr, boundary)
    out["motion_flags_anomalous_0_100"] = int(np.sum((flags[bi : bi + 100] & 2) != 0))
    out["motion_flags_anomalous_A_ctl"] = int(np.sum((flags[bi - 1000 : bi - 900] & 2) != 0))
    def jump(k, lo=-50, hi=50):
        v = curves["pre_" + k]
        return float(np.nanmean(v[bi : bi + hi]) - np.nanmean(v[bi + lo : bi]))
    out["pre_jumps"] = {k: jump(k) for k in ("input_mean", "floor_mean", "lowpass_mean")}
    nm = curves["pre_noise_mean"]
    okn = np.isfinite(nm)
    nA = np.nanmean(nm[(fr >= boundary - 500) & (fr < boundary) & okn])
    nB = lambda a_, b_: float(np.nanmean(nm[(fr >= boundary + a_) & (fr < boundary + b_) & okn]) / nA)  # noqa: E731
    out["noise_ratio"] = {"0-100": nB(0, 100), "100-1000": nB(100, 1000), "mid B": nB(3000, 4800)}
    fg = curves["pre_flicker_gain"]
    out["flicker_gain_first"] = float(fg[bi])
    out["flicker_gain_10"] = float(fg[bi + 10])
    out["flicker_gain_40"] = float(fg[bi + 40])
    # Structural edits per kind: 1000 frames after vs 1000 before.
    ed = read_tsv(run / "edits.tsv")
    cnt = {}
    for r in ed:
        f = int(r["recording_frame"])
        w = "after" if boundary <= f < boundary + 1000 else "before" if boundary - 1000 <= f < boundary else None
        if w:
            cnt.setdefault(r["kind"], {"before": 0, "after": 0})[w] += 1
    out["edits"] = cnt
    # Final false positives near the frame edge (<= 25 px; where a moved session loses
    # its registered data) vs interior.
    crow = read_tsv(run / "cells.tsv")
    last = max(int(float(r["frame"])) for r in crow)
    fin = [r for r in crow if int(float(r["frame"])) == last]
    fps = [r for r in fin if r["fp_class"] not in ("tp", "nondetectable")]
    out["fp_edge25"] = sum(1 for r in fps if float(r["edge_px"]) <= 25)
    out["fp_interior"] = len(fps) - out["fp_edge25"]
    rm = run_metrics(run)
    out["P8"], out["R8"], out["r_fp"], out["n_cells"] = rm["P8"], rm["R8"], rm["r_fp"], rm["cells"]
    # Footprint stability through the boundary (global.tsv, per checkpoint).
    g = read_tsv(run / "global.tsv")
    fc = [(float(r["frames"]), float(r["footprint_changes_per_min"]), float(r["median_fp_last_r"])) for r in g
          if r.get("gt_precision", "nan") not in ("nan", "NaN", "")]  # fmt: skip
    out["fp_checkpoints"] = fc
    (run / "boundary.json").write_text(json.dumps(out, indent=1))
    np.savez_compressed(run / "boundary_curves.npz", **curves)
    return out


ARM_ORDER = ["ctl", "shift5", "shift15", "shift25", "rot1", "gain0.8", "gain1.25", "off10", "realstep", "shift15gain1.25",
             "gain0.8__bgreset", "gain1.25__bgreset", "shift15gain1.25__bgreset"]


def report(root: Path, out_dir: Path, boundary: int) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out_dir.mkdir(parents=True, exist_ok=True)
    runs = {}
    for d in sorted(root.iterdir()):
        if (d / "boundary.json").exists():
            base, seed, arm = d.name.split("_", 2)
            runs.setdefault((base, arm), {})[seed] = d
    for base in ("static", "motion"):
        print(f"\n### {base}\n")
        hdr = ["arm", "seeds", "cells"] + [f"offB {w[0]}" for w in WINDOWS] + [
            "off(A model) mid B", "peak % @frame", "tau", "rms 0-10", "rms 10-100", "rms A ctl", "scale B/A",
            "P8", "R8", "r_fp", "FP edge/int"]  # fmt: skip
        print("| " + " | ".join(hdr) + " |")
        print("|" + "---|" * len(hdr))
        for arm in ARM_ORDER:
            ds = runs.get((base, arm))
            if not ds:
                continue
            js = [json.loads((d / "boundary.json").read_text()) for d in ds.values()]
            mean = lambda f: float(np.nanmean([f(j) for j in js]))  # noqa: E731
            cells = [
                arm, str(len(js)), f"{mean(lambda j: j['cells']):.0f}",
                *[f"{100 * mean(lambda j, w=w: j['windows'][w[0]]['offB']):+.2f}" for w in WINDOWS],
                f"{100 * mean(lambda j: j['windows']['mid B']['off']):+.2f}",
                f"{100 * mean(lambda j: j['transient']['peak']):+.2f} @{mean(lambda j: j['transient']['peak_frame']):.0f}",
                f"{mean(lambda j: j['decay']['tau_frames']):.0f}",
                *[f"{100 * mean(lambda j, w=w: j['windows'][w]['rms']):.2f}" for w in ("0-10", "10-100", "A ctl")],
                f"{mean(lambda j: j['scale_ratio_midB']):.3f}",
                f"{mean(lambda j: j['P8']):.3f}", f"{mean(lambda j: j['R8']):.3f}", f"{mean(lambda j: j['r_fp']):.3f}",
                f"{mean(lambda j: j['fp_edge25']):.1f}/{mean(lambda j: j['fp_interior']):.1f}",
            ]  # fmt: skip
            print("| " + " | ".join(cells) + " |")
        print(f"\n#### {base}: registration, preprocessing, edits\n")
        hdr = ["arm", "reg err 1st frame px", "frames to <0.5 px", "reg err med A/B", "anomalous flags 0-100",
               "input_mean jump", "floor_mean jump", "flicker gain B+0/+10/+40", "noise B/A 0-100/100-1000/mid",
               "edits before->after (add/merge/delete/split/refine)"]  # fmt: skip
        print("| " + " | ".join(hdr) + " |")
        print("|" + "---|" * len(hdr))
        for arm in ARM_ORDER:
            ds = runs.get((base, arm))
            if not ds:
                continue
            for seed, d in sorted(ds.items()):
                j = json.loads((d / "boundary.json").read_text())
                rg = j.get("registration", {})
                ed = j["edits"]
                es = "/".join(
                    f"{ed.get(k, {}).get('before', 0)}->{ed.get(k, {}).get('after', 0)}"
                    for k in ("add", "merge", "delete", "split", "refine")
                )
                nr = j["noise_ratio"]
                print(
                    f"| {arm} {seed} | {rg.get('err_first_frame', math.nan):.2f} | {rg.get('frames_to_0.5px', -1)} | "
                    f"{rg.get('err_med_A', math.nan):.2f}/{rg.get('err_med_B', math.nan):.2f} | "
                    f"{j['motion_flags_anomalous_0_100']} | {j['pre_jumps']['input_mean']:+.2f} | "
                    f"{j['pre_jumps']['floor_mean']:+.2f} | {j['flicker_gain_first']:+.3f}/{j['flicker_gain_10']:+.3f}/"
                    f"{j['flicker_gain_40']:+.3f} | {nr['0-100']:.3f}/{nr['100-1000']:.3f}/{nr['mid B']:.3f} | {es} |"
                )
    # Plots: residual curves per arm (first seed of each), two zooms.
    for base in ("static", "motion"):
        if not any(k[0] == base for k in runs):
            continue
        fig, axes = plt.subplots(2, 1, figsize=(10, 7))
        for arm in ARM_ORDER:
            ds = runs.get((base, arm))
            if not ds:
                continue
            curves = [np.load(d / "boundary_curves.npz") for d in ds.values()]
            t = curves[0]["t"] - boundary
            e = np.nanmean([c["eB_med"] for c in curves], axis=0)
            sm = np.convolve(np.nan_to_num(e), np.ones(20) / 20, mode="same")
            axes[0].plot(t, 100 * e, label=arm, lw=0.8)
            axes[1].plot(t, 100 * sm, label=arm, lw=1)
        axes[0].set_xlim(-50, 150)
        axes[0].set_title(f"{base}: median trace residual vs B's steady state (% of peak)")
        axes[1].set_xlim(-500, 4700)
        axes[1].set_title("20-frame running mean")
        for a in axes:
            a.axvline(0, color="k", lw=0.5)
            a.axhline(0, color="k", lw=0.5)
            a.set_ylabel("residual, % of peak")
        axes[1].set_xlabel("frames after boundary")
        axes[0].legend(fontsize=7, ncol=4)
        fig.tight_layout()
        fig.savefig(out_dir / f"residual_{base}.png", dpi=110)
        plt.close(fig)
        fig, axes = plt.subplots(5, 1, figsize=(10, 12), sharex=True)
        for arm in ARM_ORDER:
            ds = runs.get((base, arm))
            if not ds:
                continue
            c = np.load(next(iter(ds.values())) / "boundary_curves.npz")
            f = c["pre_frame"] - boundary
            axes[0].plot(f, c["pre_input_mean"], lw=0.7, label=arm)
            axes[1].plot(f, c["pre_flicker_gain"], lw=0.7)
            axes[2].plot(f, c["pre_floor_mean"], lw=0.7)
            nm = c["pre_noise_mean"]
            ok = np.isfinite(nm)
            axes[3].plot(f[ok], nm[ok], lw=0.7)
            if "reg_err" in c:
                axes[4].plot(np.arange(len(c["reg_err"])) - boundary, c["reg_err"], lw=0.7)
        for a, n in zip(axes, ["input mean (grey)", "flicker gain m", "background floor mean", "noise map mean σ",
                               "registration error px"]):  # fmt: skip
            a.set_ylabel(n, fontsize=8)
            a.axvline(0, color="k", lw=0.5)
        axes[0].legend(fontsize=7, ncol=4)
        axes[4].set_xlim(-300, 3000)
        axes[4].set_xlabel("frames after boundary")
        fig.suptitle(f"{base}: preprocessing and motion state around the boundary (first seed)")
        fig.tight_layout()
        fig.savefig(out_dir / f"state_{base}.png", dpi=110)
        plt.close(fig)
        fig, ax = plt.subplots(figsize=(10, 4))
        for arm in ARM_ORDER:
            ds = runs.get((base, arm))
            if not ds:
                continue
            curves = [np.load(d / "boundary_curves.npz") for d in ds.values()]
            b = np.nanmean([c["bg_med"] for c in curves], axis=0)
            ax.plot(curves[0]["t"] - boundary, 100 * np.convolve(np.nan_to_num(b), np.ones(20) / 20, "same"), lw=1,
                    label=arm)  # fmt: skip
        ax.axvline(0, color="k", lw=0.5)
        ax.set_xlim(-500, 4700)
        ax.set_ylabel("ring level change, % of peak")
        ax.set_xlabel("frames after boundary")
        ax.set_title(f"{base}: fast loop ring-background level (median over cells, vs session A)")
        ax.legend(fontsize=7, ncol=4)
        fig.tight_layout()
        fig.savefig(out_dir / f"ring_{base}.png", dpi=110)
        plt.close(fig)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a1 = sub.add_parser("analyze")
    a1.add_argument("run", type=Path)
    a1.add_argument("sim", type=Path)
    a1.add_argument("--boundary", type=int, default=4800)
    a2 = sub.add_parser("report")
    a2.add_argument("root", type=Path)
    a2.add_argument("out", type=Path)
    a2.add_argument("--boundary", type=int, default=4800)
    a = ap.parse_args()
    if a.cmd == "analyze":
        o = analyze(a.run, a.sim, a.boundary)
        print(json.dumps({k: o[k] for k in ("cells", "windows", "scale_ratio_midB", "transient", "decay", "P8", "R8")}))
    else:
        report(a.root, a.out, a.boundary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
