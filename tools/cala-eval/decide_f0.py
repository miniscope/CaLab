#!/usr/bin/env python3
"""Score the S2.1c F0 falsifier from `qc_eval --decide-shadow` runs.

    python3 tools/cala-eval/decide_f0.py --sims <run>/out ... --real <run>/out ...

Each run directory holds the shadow logs `decide_{fp,pairs,keep,silent}.tsv`
(see `crates/cala/src/discover/shadow.rs`). Frames in the logs are slow-loop
frames; `--start` (qc_eval's, default 50) converts them to recording frames.

F0 (plan section 3.4):
  1. sims: among refine proposals the current rule tested, AUC of the new
     statistic (t of the energy-weighted Δ test) for proposals that raise the
     footprint's correlation with its GT unit, against the paired z's AUC;
  2. real, late (recording frame > 12000): proposals the new rule would
     publish over refines + absorbs the current rule published (≤ 25 %;
     > 50 % stops);
  3. sims, power: early refines (frame < 3000) that raise the GT correlation
     by more than the cell's split-half noise: share the new rule would
     publish (≥ 50 %; < 20 % stops);
  4. keep θ per cell, TP vs non-TP (AUC ≥ .8); merge per-frame net loss,
     same-GT-unit pairs vs distinct units.
Also tabulates what the shadow merge / keep / silent rules would have done
against what the current rules did.
"""

from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path


def read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path) as f:
        return list(csv.DictReader(f, delimiter="\t"))


def num(x: str) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return math.nan


def auc(pos: list[float], neg: list[float]) -> float:
    """P(pos > neg) + ½ P(tie), NaN-free inputs."""
    pos = [p for p in pos if not math.isnan(p)]
    neg = [n for n in neg if not math.isnan(n)]
    if not pos or not neg:
        return math.nan
    allv = sorted([(v, 1) for v in pos] + [(v, 0) for v in neg])
    # Rank-sum with average ranks for ties.
    ranks = [0.0] * len(allv)
    i = 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]:
            j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[k] = r
        i = j + 1
    rp = sum(r for r, (_, lab) in zip(ranks, allv) if lab == 1)
    n1, n0 = len(pos), len(neg)
    return (rp - n1 * (n1 + 1) / 2) / (n1 * n0)


def tstat(r: dict, sfx: str = "") -> float:
    th, se = num(r["theta" + sfx]), num(r["se" + sfx])
    if math.isnan(th):
        return math.nan
    if se == 0:
        return math.copysign(1e9, th)
    return th / se if not math.isnan(se) else math.nan


def fmt(x: float, nd: int = 3) -> str:
    return "–" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.{nd}f}"


def pct(a: int, b: int) -> str:
    return f"{a}/{b} ({100 * a / b:.0f} %)" if b else f"{a}/0"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sims", nargs="*", default=[], type=Path)
    ap.add_argument("--real", nargs="*", default=[], type=Path)
    ap.add_argument("--start", type=int, default=50)
    ap.add_argument("--late", type=int, default=12000, help="real: late from this recording frame")
    ap.add_argument("--early", type=int, default=3000, help="sims: early before this recording frame")
    ap.add_argument("--sim-late", type=int, default=4800, help="sims: late from this frame (last 4 min)")
    ap.add_argument("--fps", type=float, default=20.0)
    A = ap.parse_args()
    out: list[str] = []
    P = out.append

    # ---- F0.1 and F0.3 (sims) ------------------------------------------------
    P("## F0.1 / F0.3 — refine Δ test vs GT (sims)\n")
    P("| run | refines tested | GT-matched | improving | AUC new t | AUC new t (frame-wt) | AUC paired z | early improving > noise | new publishes | new passes (test only) | frame-wt publishes | t > margin (dof ignored) |")
    P("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    pool = {"pos": [], "neg": [], "pos_fw": [], "neg_fw": [], "pos_z": [], "neg_z": []}
    pw = [0, 0, 0, 0, 0]
    for run in A.sims:
        rows = [r for r in read(run / "decide_fp.tsv") if r["kind"] == "refine"]
        m = [r for r in rows if int(r["gt"]) >= 0 and num(r["gt_r_cur"]) >= 0.5]
        pos = [r for r in m if num(r["gt_r_new"]) > num(r["gt_r_cur"])]
        neg = [r for r in m if not num(r["gt_r_new"]) > num(r["gt_r_cur"])]
        a = auc([tstat(r) for r in pos], [tstat(r) for r in neg])
        afw = auc([tstat(r, "_fw") for r in pos], [tstat(r, "_fw") for r in neg])
        az = auc([num(r["old_z"]) for r in pos], [num(r["old_z"]) for r in neg])
        for k, rs in (("pos", pos), ("neg", neg)):
            pool[k] += [tstat(r) for r in rs]
            pool[k + "_fw"] += [tstat(r, "_fw") for r in rs]
            pool[k + "_z"] += [num(r["old_z"]) for r in rs]
        early = [
            r
            for r in m
            if int(r["frame"]) + A.start < A.early
            and not math.isnan(num(r["fp_noise"]))
            and num(r["gt_r_new"]) - num(r["gt_r_cur"]) > num(r["fp_noise"])
        ]
        npub = sum(r["publish"] == "1" for r in early)
        npass = sum(r["pass"] == "1" for r in early)
        nfw = sum(r["publish_fw"] == "1" for r in early)
        nz = sum(tstat(r) > num(r["margin"]) for r in early)
        pw[4] += nz
        pw[0] += len(early)
        pw[1] += npub
        pw[2] += npass
        pw[3] += nfw
        P(
            f"| {run.parent.name} | {len(rows)} | {len(m)} | {len(pos)} | {fmt(a)} | {fmt(afw)} | {fmt(az)} | "
            f"{len(early)} | {pct(npub, len(early))} | {pct(npass, len(early))} | {pct(nfw, len(early))} | {pct(nz, len(early))} |"
        )
    if A.sims:
        P(
            f"| **pooled** | | | {len(pool['pos'])} / {len(pool['pos']) + len(pool['neg'])} | "
            f"**{fmt(auc(pool['pos'], pool['neg']))}** | {fmt(auc(pool['pos_fw'], pool['neg_fw']))} | "
            f"{fmt(auc(pool['pos_z'], pool['neg_z']))} | {pw[0]} | **{pct(pw[1], pw[0])}** | {pct(pw[2], pw[0])} | {pct(pw[3], pw[0])} | {pct(pw[4], pw[0])} |"
        )
    P("")
    P("GT-matched: the cell's current footprint correlates ≥ .5 with its best GT unit; improving: the proposal's")
    P("correlation with that unit is higher. Early: recording frame < " + str(A.early) + "; noise: the cell's split-half")
    P("footprint noise. 'Publishes' = trigger fired and the Δ test passed at the look margin; 'test only' ignores the trigger.\n")

    # ---- F0.2 (real; also sims for reference) --------------------------------
    P("## F0.2 — late publications, new rule over current rule\n")
    P("| run | late from | old published (refine + absorb) | new publishes | ratio | of old published, new would publish | frame-wt publishes | ratio fw | triggered | declined-but-triggered |")
    P("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    tot = [0, 0, 0, 0]
    for run, late in [(r, A.late) for r in A.real] + [(r, A.sim_late) for r in A.sims]:
        rows = [r for r in read(run / "decide_fp.tsv") if int(r["frame"]) + A.start > late]
        tested = [r for r in rows if r["kind"] in ("refine", "absorb")]
        old = [r for r in tested if r["old_accept"] == "1"]
        new = [r for r in tested if r["publish"] == "1"]
        both = [r for r in old if r["publish"] == "1"]
        fw = [r for r in tested if r["publish_fw"] == "1"]
        trig = sum(r["triggered"] == "1" for r in tested)
        decl = sum(r["kind"] == "declined" for r in rows)
        if run in A.real:
            tot[0] += len(old)
            tot[1] += len(new)
            tot[2] += len(both)
            tot[3] += len(fw)
        ratio = len(new) / len(old) if old else math.nan
        rfw = len(fw) / len(old) if old else math.nan
        P(
            f"| {run.parent.name} | {late} | {len(old)} | {len(new)} | {fmt(ratio, 2)} | {pct(len(both), len(old))} | "
            f"{len(fw)} | {fmt(rfw, 2)} | {trig} | {decl} |"
        )
    if A.real:
        P(
            f"| **real pooled** | | {tot[0]} | {tot[1]} | **{fmt(tot[1] / tot[0] if tot[0] else math.nan, 2)}** | "
            f"{pct(tot[2], tot[0])} | {tot[3]} | {fmt(tot[3] / tot[0] if tot[0] else math.nan, 2)} | | |"
        )
    P("")

    # ---- F0.4 keep ------------------------------------------------------------
    P("## F0.4 — keep θ per cell (last record) and merge net loss\n")
    P("| run | cells with a keep record | TP | AUC θ_all TP vs non-TP | shadow delete (cells) | of which TP | old Unsupported deletes | of which shadow ever delete |")
    P("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for run in A.sims + A.real:
        keep = read(run / "decide_keep.tsv")
        last: dict[str, dict] = {}
        ever_del: set[str] = set()
        for r in keep:
            last[r["id"]] = r
            if r["verdict"] == "delete":
                ever_del.add(r["id"])
        tp = {i for i, r in last.items() if r["gt_det"] == "1" and num(r["gt_r"]) >= 0.7}
        th = {i: num(r["theta_all"]) for i, r in last.items()}
        a = auc([th[i] for i in tp], [th[i] for i in last if i not in tp]) if run in A.sims else math.nan
        sil = read(run / "decide_silent.tsv")
        olddel = {r["id"] for r in sil if r["event"] == "old_unsupported"}
        P(
            f"| {run.parent.name} | {len(last)} | {len(tp) if run in A.sims else '–'} | {fmt(a)} | {len(ever_del)} | "
            f"{len(ever_del & tp) if run in A.sims else '–'} | {len(olddel)} | {len(olddel & ever_del)} |"
        )
    P("")
    P("| run | merge evaluations | old merges | shadow merge | shadow apart | undecided | held / skip | old merge & shadow merge | AUC −net same unit vs distinct |")
    P("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for run in A.sims + A.real:
        pr = read(run / "decide_pairs.tsv")
        v = {k: sum(r["verdict"] == k for r in pr) for k in ("merge", "apart", "undecided", "held", "skip")}
        om = sum(r["old_accept"] == "1" for r in pr)
        both = sum(r["old_accept"] == "1" and r["verdict"] == "merge" for r in pr)
        a = math.nan
        if run in A.sims:
            def best_net(r):
                v = [num(r[f"net{k}"]) for k in range(3)]
                v = [x for x in v if not math.isnan(x)]
                return min(v) if v else math.nan
            ok = [r for r in pr if int(r["gt_lo"]) >= 0 and int(r["gt_hi"]) >= 0 and num(r["gt_r_lo"]) >= 0.5 and num(r["gt_r_hi"]) >= 0.5]
            same = [-best_net(r) for r in ok if r["gt_lo"] == r["gt_hi"]]
            diff = [-best_net(r) for r in ok if r["gt_lo"] != r["gt_hi"]]
            a = auc(same, diff)
        P(
            f"| {run.parent.name} | {len(pr)} | {om} | {v['merge']} | {v['apart']} | {v['undecided']} | "
            f"{v['held']} / {v['skip']} | {both} | {fmt(a)} |"
        )
    P("")
    P("| run | claims | would delete silent | old Silent deletes | old Silent & would delete | would delete & TP-matched |")
    P("| --- | --- | --- | --- | --- | --- |")
    for run in A.sims + A.real:
        sil = read(run / "decide_silent.tsv")
        claims = sum(r["event"] == "claim" for r in sil)
        wd = {r["id"]: r for r in sil if r["event"] == "would_delete"}
        os_ = {r["id"] for r in sil if r["event"] == "old_silent"}
        tpw = sum(r["gt_det"] == "1" and num(r["gt_r"]) >= 0.7 for r in wd.values())
        P(f"| {run.parent.name} | {claims} | {len(wd)} | {len(os_)} | {len(os_ & set(wd))} | {tpw if run in A.sims else '–'} |")
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
