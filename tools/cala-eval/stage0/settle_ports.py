"""The Final settle from a headed-Chrome run, on any settle source and any number of look-back workers.

usage: python3 settle_ports.py RUN_DIR TAG [TAG ...]

For each run (`memory-measure.mjs --single --lookback`, `?debug`) prints one summary row, then the settle's
slow-worker duty table, the look-back workers' busy shares, and the relay per worker and answer. It generalises
`duty_tables.py`'s settle section, which reads look-back worker 0 only (`relay.end.p0`, `lbBusy[0]`).

* Times come from the 100 ms probe (`<tag>-probe.json`): Discover = framesDone - t0, Final settle = final -
  framesDone (it includes the wait for the factors, `end.factorWait`); fps = recording frames / Discover s and
  settle frames fed / settle s.
* The settle window is the work samples while the end settle fed frames (`acct.lookback.end.frames` rises), as
  in `duty_tables.py`; duty numbers are ms per settle frame over it.
* Settle source, workers and fed/total come from `LOOKBACK_CHECK`, else from the last work sample's `settle`.
* Settle visit jobs: the slow worker's job count at the last memory sample minus at the last `running` sample
  (Stage 1's method), per settle frame and per settle second.
* Per answer: `rtt` (request sent -> handler), look-back busy (read + rebuild/preprocess + solve + other),
  `queued` (answer posted -> handler: the slow worker was busy). rtt - busy - queued is the request waiting at
  the look-back worker plus delivery.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import duty_tables as DT  # noqa: E402


def lookback_check(d, tag):
    p = d / f"{tag}.stdout"
    if not p.exists():
        return None
    lines = [x for x in p.read_text().splitlines() if x.startswith("LOOKBACK_CHECK")]
    if not lines:
        return None
    try:
        return json.loads(lines[-1].split(" ", 2)[2])
    except (IndexError, json.JSONDecodeError):
        return None


def settle_jobs(d, tag):
    s = json.loads((d / f"{tag}.json").read_text())

    def jobs(x):
        return ((x.get("st") or {}).get("slow") or {}).get("jobs")

    run = [x for x in s if (x.get("st") or {}).get("pst") == "running" and jobs(x) is not None]
    last = [x for x in s if jobs(x) is not None]
    if not run or not last:
        return None
    return jobs(last[-1]) - jobs(run[-1])


def run(d, tag):
    p = json.loads((d / f"{tag}-probe.json").read_text())["probe"]
    disc = (p["framesDone"] - p["t0"]) / 1000
    sett = (p["final"] - p["framesDone"]) / 1000
    frames = p["frames"]
    chk = lookback_check(d, tag) or {}
    rows = DT.load(d / f"{tag}-work.json")
    last_settle = next((r.get("settle") for r in reversed(rows) if r.get("settle")), None) or {}
    st = chk.get("settle") or last_settle
    fed = st.get("fed", 0)
    S = json.loads((d / f"{tag}.json").read_text())
    def peak(xs):
        return max((max(x.get("rendererFoot") or 0, x.get("rendererRss") or 0) for x in xs), default=0) / 1024

    rss = peak(S)
    # Before the final library: Discover and the settle (after it, the app's Extract can run).
    rss_pre = peak([x for x in S if not (x.get("st") or {}).get("final")])
    cells = len(json.loads((d / f"{tag}-final.json").read_text())["ids"])
    comp = next((r.get("compress") for r in reversed(rows) if r.get("compress")), None) or {}
    ends = [k for k in range(1, len(rows))
            if rows[k]["acct"]["lookback"]["end"]["frames"] > rows[k - 1]["acct"]["lookback"]["end"]["frames"]]
    w = DT.window(rows, ends[0] - 1, ends[-1])
    det_all = rows[-1]["acct"].get("detail", {})
    jobs = settle_jobs(d, tag)
    return dict(tag=tag, disc=disc, dfps=frames / disc, sett=sett, sfps=fed / sett if sett else 0, rss=rss, rss_pre=rss_pre,
                cells=cells, source=st.get("source", "recording"), workers=st.get("workers"), fed=fed,
                total=st.get("total"), comp=comp, w=w, det_all=det_all, jobs=jobs)


def main():
    d = Path(sys.argv[1])
    runs = [run(d, t) for t in sys.argv[2:]]
    print("| run | Discover s | Discover fps | factor wait s | settle s | settle fps | source | workers | fed/total |"
          " peak RSS GB (to final / all) | cells | GPU waits s (n) | settle jobs/frame | jobs/s |")
    print("|---" * 14 + "|")
    for r in runs:
        fw = r["det_all"].get("end.factorWait")
        c = r["comp"]
        gw = f"{c['waitS']:.1f} ({c.get('waits', 0)})" if "waitS" in c else "-"
        jb = r["jobs"]
        jpf = "-" if jb is None or not r["fed"] else f"{jb / r['fed']:.3f}"
        jps = "-" if jb is None or not r["sett"] else f"{jb / r['sett']:.1f}"
        print(f"| {r['tag']} | {r['disc']:.0f} | {r['dfps']:.0f} | {'-' if fw is None else f'{fw / 1000:.1f}'} | "
              f"{r['sett']:.0f} | {r['sfps']:.1f} | {r['source']} | {r['workers']} | {r['fed']}/{r['total']} | "
              f"{r['rss_pre']:.2f} / {r['rss']:.2f} | {r['cells']} | {gw} {c.get('backend', '')} | "
              f"{jpf} | {jps} |")
    for r in runs:
        w = r["w"]
        lb = w["lookback"]["end"]
        f = max(lb["frames"], 1)
        det = w["detail"]
        wall = w["wall"]
        busy = sum(w[k] for k in DT.DUTIES)
        print(f"\n### {r['tag']}: Final settle window {wall / 1000:.1f} s, {lb['frames']:.0f} frames"
              f" ({lb['frames'] / (wall / 1000):.1f} fps in the window)")
        print("| slow worker | ms per settle frame | share of wall |")
        print("|---|---:|---:|")
        for k in DT.DUTIES:
            if w[k] > 0:
                print(f"| {k} | {w[k] / f:.2f} | {100 * w[k] / wall:.1f}% |")
        for k in ("end.observe", "end.request", "end.checkpoint", "visit.take", "visit.apply"):
            if det.get(k):
                print(f"| ({k}) | {det[k] / f:.2f} | {100 * det[k] / wall:.1f}% |")
        print(f"| **busy** | {busy / f:.2f} | {100 * busy / wall:.1f}% |")
        print(f"| idle | {(wall - busy) / f:.2f} | {100 * (wall - busy) / wall:.1f}% |")
        print(f"\nlook-back, all end-settle answers: {lb['answers']:.0f} answers, ms per frame read"
              f" {lb['readMs'] / f:.2f}, preprocess/rebuild {lb['preprocessMs'] / f:.2f}, solve {lb['solveMs'] / f:.2f},"
              f" other {lb['otherMs'] / f:.2f}, wait {lb['waitMs'] / f:.3f}")
        print("\n| worker | busy share | answers | rtt ms/answer | queued ms/answer | rtt-queued ms/answer |")
        print("|---|---:|---:|---:|---:|---:|")
        for i, b in enumerate(w["lbBusy"]):
            n = det.get(f"relay.end.p{i}#", 0)
            if not n and not b:
                continue
            rtt = det.get(f"relay.end.p{i}.rtt", 0) / max(n, 1)
            q = det.get(f"relay.end.p{i}.queued", 0) / max(n, 1)
            print(f"| {i} | {100 * b / wall:.1f}% | {n:.0f} | {rtt:.1f} | {q:.1f} | {rtt - q:.1f} |")
        fw = det.get("relay.end.p0.finalWait")
        if fw is not None:
            print(f"\nfinalWait (recording relay) {fw:.1f} ms in the window")


if __name__ == "__main__":
    main()
