"""PR H, floor and default eval (results/2026-11-22-floor-eval-plan.md).

  floor_eval_summary.py targets DIR      Max runs -> DIR/targets.txt (rule R1 of the plan)
  floor_eval_summary.py fp DIR TAG       DIR/TAG-final.json -> DIR/score/TAG/footprints.bin (CALAFP01)
  floor_eval_summary.py runs DIR         per-run table: time, cells, floor estimates, service readings
  floor_eval_summary.py quality DIR      quality proxies from the fixed-library scoring (DIR/score/TAG)
  floor_eval_summary.py all DIR          runs + quality + the plan's readings -> DIR/summary.md

Run tags are <rec>-<arm>-<rep>: rec sa | sb | ws; arm max | see | f14 | f10 | f07.
"""

from __future__ import annotations

import json
import re
import statistics as st
import struct
import sys
from pathlib import Path

import numpy as np

RECS = ["sa", "sb", "ws", "m5", "t6"]  # m5, t6: sims-v3 truth anchors
ARMS = ["max", "see", "f14", "f10", "f07"]  # fastest to slowest
ARM_NAME = {"max": "Max", "see": "seeAllFps", "f14": "1.4x floor", "f10": "floor", "f07": "0.7x floor"}
LADDER = [10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300]
FLOOR_RE = re.compile(
    r"floor (\S+) fps \(raw ([\d.]+)\) · set by (\S+) · (measured paced|measured at Max)( · ABOVE MAX)? · "
    r"sees every frame below (\d+)"
)
TERMS_RE = re.compile(r"terms: look-back need (\S+) settle (\S+) · slow worker (\S+) · visits (\S+)")
TIME_RE = re.compile(r"^(\d+)s (running|paused|done)")


def tags(d: Path) -> list[str]:
    out = []
    for p in sorted(d.glob("*-final.json")):
        t = p.name[: -len("-final.json")]
        if t.split("-")[0] in RECS and t.split("-")[1] in ARMS:
            out.append(t)
    return out


# ---------------------------------------------------------------- log parsing


def floor_readings(log: Path) -> list[dict]:
    """Every floor line of the ?debug readout while Discover runs: (sample seconds, published, raw, limiting,
    confidence, seeAll, terms). Stops at DISCOVER_FRAMES_DONE (the floor freezes after it)."""
    rows, t, cur = [], None, None
    for line in log.read_text(errors="replace").splitlines():
        if line.startswith("DISCOVER_FRAMES_DONE") or line.startswith("PROBE discover"):
            break
        m = TIME_RE.match(line)
        if m:
            t = int(m.group(1))
        m = FLOOR_RE.search(line)
        if m:
            cur = dict(
                t=t,
                published=None if m.group(1) == "-" else float(m.group(1)),
                raw=float(m.group(2)),
                limiting=m.group(3),
                confidence="paced" if m.group(4) == "measured paced" else "unpaced",
                above_max=bool(m.group(5)),
                see_all=float(m.group(6)),
            )
            rows.append(cur)
            continue
        m = TERMS_RE.search(line)
        if m and cur is not None and "terms" not in cur:
            f = lambda s: None if s == "-" else float(s)  # noqa: E731
            cur["terms"] = dict(need=f(m.group(1)), settle=f(m.group(2)), slow=f(m.group(3)), visits=f(m.group(4)))
    return rows


def last_floor(log: Path) -> dict | None:
    r = floor_readings(log)
    return r[-1] if r else None


def snap(fps: float) -> float:
    lo = [s for s in LADDER if s <= fps]
    return lo[-1] if lo else LADDER[0]


# ---------------------------------------------------------------- targets (rule R1)


def cmd_targets(d: Path) -> None:
    lines = []
    for rec in RECS:
        maxes = [t for t in tags(d) if t.startswith(f"{rec}-max-")]
        fl = [last_floor(d / f"{t}.log") for t in maxes]
        fl = [x for x in fl if x is not None and x["published"] is not None]
        if not fl:
            print(f"{rec}: no Max run with a published floor")
            continue
        pubs = [x["published"] for x in fl]
        F = min(pubs) if rec in ("m5", "t6") else st.median(pubs)  # sims: the lower of two (plan R1)
        S = st.median([x["see_all"] for x in fl])
        lines += [
            f"{rec} f10 {F:g}",
            f"{rec} f14 {round(1.4 * F)}",
            f"{rec} f07 {round(0.7 * F)}",
            f"{rec} see {int(S)}",
        ]
        print(rec, "Max runs", maxes, "published", [x["published"] for x in fl], "raw", [x["raw"] for x in fl],
              "seeAll", [x["see_all"] for x in fl])
    (d / "targets.txt").write_text("\n".join(lines) + "\n")
    print((d / "targets.txt").read_text())


# ---------------------------------------------------------------- library conversion


def cmd_fp(d: Path, tag: str, dy: int = 0, dx: int = 0) -> Path:
    """Chrome final library (unfiltered values, `JsTraceLibrary.footprintValues`) -> CALAFP01.
    qc_eval `--library` reads the unfiltered column only and rebuilds the filter itself; the filtered column is
    written as a copy and ignored. `dy`, `dx`: shift every footprint (the alignment check), into
    score/TAG_shift{dy}{dx}; pixels shifted off the frame are dropped."""
    lib = json.loads((d / f"{tag}-final.json").read_text())
    h, w = lib["height"], lib["width"]
    ids, starts, pix, val = lib["ids"], lib["starts"], lib["pixels"], lib["values"]
    out = d / "score" / (tag if (dy, dx) == (0, 0) else f"{tag}_shift{dy}{dx}")
    out.mkdir(parents=True, exist_ok=True)
    b = bytearray(b"CALAFP01")
    b += struct.pack("<3I", h, w, len(ids))
    for i, cid in enumerate(ids):
        a, z = starts[i], starts[i + 1]
        p = np.asarray(pix[a:z], dtype=np.int64)
        v = np.asarray(val[a:z], dtype="<f4")
        if (dy, dx) != (0, 0):
            y, x = p // w + dy, p % w + dx
            ok = (y >= 0) & (y < h) & (x >= 0) & (x < w)
            p, v = y[ok] * w + x[ok], v[ok]
        p = p.astype("<u4")
        b += struct.pack("<2I", int(cid), len(p))
        b += p.tobytes() + v.tobytes() + v.tobytes()
    f = out / "footprints.bin"
    f.write_bytes(bytes(b))
    return f


def read_lib(d: Path, tag: str):
    """Chrome final library as (ids, list of (pixels, values)), unfiltered."""
    lib = json.loads((d / f"{tag}-final.json").read_text())
    s = lib["starts"]
    pix = np.asarray(lib["pixels"], dtype=np.int64)
    val = np.asarray(lib["values"], dtype=np.float64)
    cells = [(pix[s[i] : s[i + 1]], val[s[i] : s[i + 1]]) for i in range(len(lib["ids"]))]
    return lib["ids"], cells, lib["width"]


# ---------------------------------------------------------------- per-run readings (H1-H3)

FPS = {"sa": 30, "sb": 30, "ws": 20, "m5": 20, "t6": 20}


def load_txt(d: Path) -> dict:
    out = {}
    p = d / "load.txt"
    if p.exists():
        for line in p.read_text().splitlines():
            m = re.match(r"(\S+) (\S+) start load=\{ ([\d.]+)", line)
            if m:
                out.setdefault(m.group(2), {})["load_start"] = float(m.group(3))
            m = re.match(r"(\S+) (\S+) exit=(\d+) load=\{ ([\d.]+)", line)
            if m:
                out.setdefault(m.group(2), {}).update(exit=int(m.group(3)), load_end=float(m.group(4)))
    return out


def run_row(d: Path, tag: str) -> dict:
    rec, arm, rep = tag.split("-")
    p = json.loads((d / f"{tag}-probe.json").read_text())["probe"]
    disc = (p["framesDone"] - p["t0"]) / 1000
    end = (p["final"] - p["framesDone"]) / 1000
    a = p["atFramesDone"]
    lb = a.get("lb") or {}
    cs = lb.get("csettle") or {}
    live = cs.get("live") or 0
    work = json.loads((d / f"{tag}-work.json").read_text())
    run = [w for w in work if w.get("status") == "running" and w.get("work")]
    paced = [w for w in run if (w.get("pace") or {}).get("target", 0) > 0]
    gov = [w["governor"] for w in paced if w.get("governor")]
    vis = [np.mean(w["work"]["visit"]) for w in (paced or run) if w["work"].get("visit")]
    bw = [w["work"]["batchWait"]["meanMs"] for w in run if w["work"].get("batchWait")]
    caps = {g.get("cap") for g in gov}
    sw = {w.get("settleWorkers") for w in paced if w.get("settleWorkers") is not None}
    fl = floor_readings(d / f"{tag}.log")
    lf = fl[-1] if fl else {}
    row = dict(
        tag=tag, rec=rec, arm=arm, rep=rep,
        discover_s=disc, settle_s=end, total_s=disc + end, frames=p["frames"], achieved=p["frames"] / disc,
        cells=a.get("cells"),
        drop_share=a["drop"] / max(1, a["fwd"]),
        dose=(cs.get("fit", 0) + cs.get("heldOut", 0)) / live if live else 0.0,
        need_req=lb.get("requested", 0), births=lb.get("births", 0),
        need_per_birth=lb.get("requested", 0) / max(1, lb.get("births", 0)),
        in_need_end=lb.get("inNeed"),
        cap_share=(sum(g.get("limit") == "cap" for g in gov) / len(gov)) if gov else float("nan"),
        limits={k: sum(g.get("limit") == k for g in gov) / len(gov) for k in {g.get("limit") for g in gov}} if gov else {},
        visit_busy=float(np.mean(vis)) if vis else float("nan"),
        batch_wait_ms=float(np.mean(bw)) if bw else float("nan"),
        caps=sorted(c for c in caps if c is not None), settle_workers=sorted(sw),
        settle_fed=None,
        floor_pub=lf.get("published"), floor_raw=lf.get("raw"), floor_lim=lf.get("limiting"),
        floor_conf=lf.get("confidence"), see_all=lf.get("see_all"), terms=lf.get("terms"),
        floor_first=fl[0] if fl else None,
    )
    m = re.search(r'"settle":\{"fed":(\d+),"total":(\d+)', (d / f"{tag}.log").read_text(errors="replace"))
    if m:
        row["settle_fed"] = (int(m.group(1)), int(m.group(2)))
    prior = re.search(r"floor about (\d+) fps \(not measured yet\)", (d / f"{tag}.log").read_text(errors="replace"))
    row["prior"] = float(prior.group(1)) if prior else None
    row.update(load_txt(d).get(tag, {}))
    return row


def served(r: dict, need_ref: float | None) -> dict:
    """H1's served flags for one run (`need_ref`: the recording's f07 mean need frames per birth)."""
    return dict(
        settle=r["dose"] >= 1.8,
        need=(need_ref is not None and r["need_per_birth"] >= 0.95 * need_ref),
        slow=r["drop_share"] <= 0.005,
    )


def cmd_runs(d: Path) -> list[dict]:
    rows = [run_row(d, t) for t in tags(d)]
    out = ["| run | load start | Discover s | settle s | total s | achieved fps | cells | dose | need/birth | in need | drop % | cap share | visit busy | floor (raw) · set by · conf | seeAll |",
           "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |"]
    for r in rows:
        out.append(
            f"| {r['tag']} | {r.get('load_start', float('nan')):.1f} | {r['discover_s']:.0f} | {r['settle_s']:.0f} | {r['total_s']:.0f} | "
            f"{r['achieved']:.0f} | {r['cells']} | {r['dose']:.2f} | {r['need_per_birth']:.1f} | {r['in_need_end']} | "
            f"{100 * r['drop_share']:.2f} | {r['cap_share']:.2f} | {r['visit_busy']:.2f} | "
            f"{r['floor_pub']} ({r['floor_raw']}) · {r['floor_lim']} · {r['floor_conf']} | {r['see_all']} |"
        )
    print("\n".join(out))
    return rows


# ---------------------------------------------------------------- quality (Q1-Q5, T1-T5)


def read_tsv(p: Path) -> list[dict]:
    lines = p.read_text().splitlines()
    h = lines[0].split("\t")
    return [dict(zip(h, l.split("\t"))) for l in lines[1:] if l.strip()]


def fnum(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return float("nan")


def score_global(sd: Path) -> dict:
    g = read_tsv(sd / "global.tsv")
    num = den = 0.0
    for row in g:
        f, sig = fnum(row.get("ho_score_frac")), fnum(row.get("ho_signal"))
        if np.isfinite(f) and np.isfinite(sig) and sig > 0:
            num += f * sig
            den += sig
    last = g[-1]
    out = dict(q1=num / den if den else float("nan"), q3=fnum(last.get("residual_excess")))
    for k in ("gt_precision", "gt_recall", "gt_median_true_r", "median_neighbour_r", "pair_frac"):
        out[k] = fnum(last.get(k))
    return out


def common_cells(d: Path, rec: str, run_tags: list[str]) -> dict[str, set]:
    """Per run, the ids of cells matched one-to-one in every other run of the recording (no anchor run)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from beta_gate_summary import match  # noqa: E402
    from csettle_app_summary import load_lib  # noqa: E402

    libs = {t: load_lib(d / f"{t}-final.json") for t in run_tags}
    ids = {t: json.loads((d / f"{t}-final.json").read_text())["ids"] for t in run_tags}
    keep = {t: set(range(len(libs[t]))) for t in run_tags}
    for a in run_tags:
        for b in run_tags:
            if a != b:
                keep[a] &= set(match(libs[a], libs[b]).keys())
    return {t: {ids[t][i] for i in keep[t]} for t in run_tags}


def crosstalk(sd: Path, common: set, fps: int) -> float:
    """Q4: median |r| of high-passed traces over common-cell pairs with centroids within 1.5 D (D = 10 px)."""
    from scipy.ndimage import uniform_filter1d

    fin = read_tsv(sd / "final.tsv")
    n = len(fin)
    tr = np.fromfile(sd / "dump_trace.f32", "<f4").reshape(-1, n)
    sel = [i for i, r in enumerate(fin) if int(r["id"]) in common]
    if len(sel) < 2:
        return float("nan")
    cen = np.array([[fnum(fin[i]["cy"]), fnum(fin[i]["cx"])] for i in sel])
    X = tr[:, sel].T.astype(np.float64)
    X = X - uniform_filter1d(X, 15 * fps, axis=1, mode="nearest")
    X -= X.mean(1, keepdims=True)
    X /= np.linalg.norm(X, axis=1, keepdims=True) + 1e-12
    rs = []
    for i in range(len(sel)):
        dd = np.hypot(cen[i + 1 :, 0] - cen[i, 0], cen[i + 1 :, 1] - cen[i, 1])
        for j in np.nonzero(dd < 15.0)[0]:
            rs.append(abs(float(X[i] @ X[i + 1 + j])))
    return float(np.median(rs)) if rs else float("nan")


def score_run(d: Path, tag: str, common: set) -> dict:
    rec = tag.split("-")[0]
    sd = d / "score" / tag
    out = score_global(sd)
    fin = read_tsv(sd / "final.tsv")
    z = {int(r["id"]): fnum(r["ho_marginal_z"]) for r in fin}
    zc = [v for k, v in z.items() if k in common and np.isfinite(v)]
    za = [v for v in z.values() if np.isfinite(v)]
    out["q2"] = float(np.median(zc)) if zc else float("nan")
    out["q2_all"] = float(np.median(za)) if za else float("nan")
    unique = [r for r in fin if int(r["id"]) not in common]
    out["n_common"] = len(common)
    out["n_other"] = len(unique)
    out["other_z"] = float(np.nanmedian([fnum(r["ho_marginal_z"]) for r in unique])) if unique else float("nan")
    out["q4"] = crosstalk(sd, common, FPS[rec])
    if rec in ("m5", "t6"):
        m = [r for r in fin if r.get("matched") == "1"]
        out["t1"] = out["gt_precision"]
        out["t2"] = out["gt_recall"]
        out["t3"] = float(np.median([fnum(r["best_r"]) for r in m])) if m else float("nan")
        out["t4"] = out["gt_median_true_r"]
        out["t5"] = len(fin) - len(m)
    return out


def repeatability(d: Path, run_tags: list[str]) -> list[tuple]:
    """Q5: per pair of runs of one arm, (pair, median single-pair cosine of matched cells, matched share)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from beta_gate_summary import match  # noqa: E402
    from csettle_app_summary import load_lib  # noqa: E402

    out = []
    for i, a in enumerate(run_tags):
        for b in run_tags[i + 1 :]:
            la, lb = load_lib(d / f"{a}-final.json"), load_lib(d / f"{b}-final.json")
            m = match(la, lb)
            cos = [c for _, c in m.values()]
            out.append((f"{a}/{b}", float(np.median(cos)) if cos else float("nan"), len(m) / max(1, (len(la) + len(lb)) / 2)))
    return out


def size_px(d: Path, tag: str) -> tuple[float, float]:
    lib = json.loads((d / f"{tag}-final.json").read_text())
    s, v = lib["starts"], np.asarray(lib["values"])
    a = [(v[s[i] : s[i + 1]] > 0).sum() for i in range(len(lib["ids"]))]
    b = [(v[s[i] : s[i + 1]] >= 0.1 * v[s[i] : s[i + 1]].max()).sum() for i in range(len(lib["ids"])) if s[i + 1] > s[i]]
    return float(np.median(a)), float(np.median(b))


def cmd_quality(d: Path) -> dict:
    res = {}
    for rec in RECS:
        ts = [t for t in tags(d) if t.startswith(rec + "-") and (d / "score" / t / "done").exists()]
        if not ts:
            continue
        com = common_cells(d, rec, ts)
        res[rec] = {t: score_run(d, t, com[t]) | dict(zip(("size_px", "size10_px"), size_px(d, t))) for t in ts}
        res[rec]["_q5"] = {arm: repeatability(d, [t for t in ts if t.split("-")[1] == arm]) for arm in ARMS}
    return res


def main(argv: list[str]) -> None:
    cmd, d = argv[1], Path(argv[2]).expanduser()
    if cmd == "targets":
        cmd_targets(d)
    elif cmd == "runs":
        cmd_runs(d)
    elif cmd == "quality":
        q = cmd_quality(d)
        print(json.dumps(q, indent=1, default=str))
        (d / "quality.json").write_text(json.dumps(q, indent=1, default=str))
    elif cmd == "fp":
        print(cmd_fp(d, argv[3], *(int(a) for a in argv[4:6])))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
