"""Stage-0 attribution: the slow worker's duty tables from a headed-Chrome run.

usage: python3 duty_tables.py RUN_DIR/TAG-work.json [--skip 15]

Reads the once-a-second samples `memory-measure.mjs` writes (`acct`: the slow
worker's raw cumulative `WorkStatus`, with `detail` and `stage` under
`?debug`; `stage` is non-zero only for a WASM build with the `timing`
feature) and prints, for Discover (from `--skip` s after its first sample to
its last live frame; also in thirds) and for the Final settle (the samples
while the end settle fed frames):

* the duty table: ms per frame and share of the slow worker's wall time;
* the finer sums (`detail`): wasm calls vs JS around them, handlers vs
  duties (JS glue), wall outside every handler (deserialisation, GC, idle);
* the WASM observe split (ms per observe call) and the binding cost
  (JS-measured observe minus the Rust side);
* look-back worker 0's split for the end settle and the relay waits.
"""
import json
import sys

OBS = ["render", "whiten", "scale", "ncorr", "ledger", "fpstats", "clusters", "reservoir", "probes"]
DUTIES = ["live", "visit", "housekeep", "need", "csettle", "end", "publish", "setup"]


def load(path):
    rows = [r for r in json.load(open(path)) if r.get("acct")]
    if not rows:
        sys.exit("no `acct` samples (an older build or driver?)")
    return rows


def delta(a, b):
    """b - a for the parts of two cumulative accounting snapshots."""
    out = {"wall": b["wallMs"] - a["wallMs"]}
    for d in DUTIES:
        out[d] = b["busyMs"][d] - a["busyMs"][d]
    out["observed"] = (b.get("observedFrames") or 0) - (a.get("observedFrames") or 0)
    da, db = a.get("detail") or {}, b.get("detail") or {}
    out["detail"] = {k: db[k] - da.get(k, 0.0) for k in db}
    sa, sb = a.get("stage") or [], b.get("stage") or []
    out["stage"] = [y - x for x, y in zip(sa, sb)] if sa and sb else []
    lb = {}
    for kind in ("need", "csettle", "end"):
        x, y = a["lookback"][kind], b["lookback"][kind]
        lb[kind] = {k: y[k] - x[k] for k in y}
    out["lookback"] = lb
    wa, wb = a.get("lookbackWorkerBusyMs") or [], b.get("lookbackWorkerBusyMs") or []
    out["lbBusy"] = [y - x for x, y in zip(wa, wb)]
    return out


def fmt_table(title, d, per, per_name):
    wall = d["wall"]
    print(f"\n### {title}: {wall / 1000:.1f} s wall, {per:.0f} {per_name}"
          f" ({per / max(wall / 1000, 1e-9):.1f}/s)")
    print(f"| duty | ms per {per_name[:-1]} | share of wall |")
    print("|---|---:|---:|")
    busy = 0.0
    for k in DUTIES:
        if d[k] > 0:
            busy += d[k]
            print(f"| {k} | {d[k] / per:.3f} | {100 * d[k] / wall:.1f}% |")
    print(f"| **busy (all duties)** | {busy / per:.3f} | {100 * busy / wall:.1f}% |")
    print(f"| idle (no duty) | {(wall - busy) / per:.3f} | {100 * (wall - busy) / wall:.1f}% |")
    det = d["detail"]
    if det:
        hand = sum(v for k, v in det.items() if k.startswith("handler.") and not k.endswith("#"))
        print(f"\nhandlers (sync time inside onmessage, all sources): {hand / per:.3f} ms/{per_name[:-1]}"
              f" ({100 * hand / wall:.1f}%); JS glue inside handlers = handlers - duties = {(hand - busy) / per:.3f};"
              f" outside every handler (deserialisation, GC, promise hops, idle) = {(wall - hand) / per:.3f}"
              f" ({100 * (wall - hand) / wall:.1f}%)")
        print(f"\n| detail | ms per {per_name[:-1]} | share of wall | calls |")
        print("|---|---:|---:|---:|")
        for k in sorted(det):
            if k.endswith("#"):
                continue
            n = det.get(k + "#", 0)
            print(f"| {k} | {det[k] / per:.3f} | {100 * det[k] / wall:.1f}% | {n:.0f} |")
        for k in sorted(det):
            if k.endswith("#") and k[:-1] not in det:
                print(f"| {k} (count) | | | {det[k]:.0f} |")
    st = d["stage"]
    if st and st[0] > 0:
        calls = st[0]
        parts = st[1:1 + len(OBS)]
        rust = st[-2]
        print(f"\nWASM observe split ({calls:.0f} calls; ms per call):")
        print("| stage | ms/call |")
        print("|---|---:|")
        for n, v in zip(OBS, parts):
            print(f"| {n} | {v / calls:.3f} |")
        print(f"| **sum of stages** | {sum(parts) / calls:.3f} |")
        print(f"| Rust side of the call (lookup, trace copy, held-out note incl.) | {rust / calls:.3f} |")
        js = det.get("live.observe", 0) + det.get("end.observe", 0)
        jn = det.get("live.observe#", 0) + det.get("end.observe#", 0)
        if jn:
            print(f"| JS-measured observe call (incl. frame copy into wasm) | {js / jn:.3f} |")
            print(f"| binding cost (JS call - Rust side) | {(js / jn) - rust / calls:.3f} |")
    lb = d["lookback"]["end"]
    if lb["frames"] > 0:
        f = lb["frames"]
        print(f"\nlook-back worker, end settle: {f:.0f} frames in {lb['answers']:.0f} answers; ms per frame:"
              f" read {lb['readMs'] / f:.3f}, preprocess {lb['preprocessMs'] / f:.3f}, solve {lb['solveMs'] / f:.3f},"
              f" other {lb['otherMs'] / f:.3f}, wait {lb['waitMs'] / f:.3f}")
        if d["lbBusy"]:
            print(f"look-back worker 0 busy share {100 * d['lbBusy'][0] / wall:.1f}% of wall")
        n = det.get("relay.end.p0#", 0)
        if n:
            rtt = det.get("relay.end.p0.rtt", 0) / n
            q = det.get("relay.end.p0.queued", 0) / n
            busy_ans = (lb["readMs"] + lb["preprocessMs"] + lb["solveMs"] + lb["otherMs"]) / lb["answers"]
            print(f"relay (per 16-frame answer): request->handler {rtt:.1f} ms, of which look-back busy"
                  f" {busy_ans:.1f}, waits for rows {lb['waitMs'] / lb['answers']:.1f}, posted->handler (queued behind"
                  f" the slow worker + delivery) {q:.1f} ms")


def window(rows, i, j):
    return delta(rows[i]["acct"], rows[j]["acct"])


def main():
    path = sys.argv[1]
    skip = float(sys.argv[sys.argv.index("--skip") + 1]) * 1000 if "--skip" in sys.argv else 15000.0
    rows = load(path)
    live = [k for k, r in enumerate(rows) if r["status"] == "running"]
    if live:
        t0 = rows[live[0]]["t"]
        a = next((k for k in live if rows[k]["t"] - t0 >= skip), live[0])
        # The last sample whose observed count still rose (Discover's last live frame).
        # (`status` turns `done` at frames-done, so `running` rows are Discover only.)
        obs = lambda k: rows[k]["acct"].get("observedFrames") or 0
        b = max((k for k in live[1:] if obs(k) > obs(k - 1)), default=live[-1])
        b = max(b, a + 1) if b <= a else b
        d = window(rows, a, b)
        fmt_table("Discover (steady)", d, max(d["observed"], 1), "frames observed")
        third = (b - a) // 3
        if third >= 2:
            for n, (x, y) in enumerate([(a, a + third), (a + third, a + 2 * third), (a + 2 * third, b)]):
                dd = window(rows, x, y)
                busy = sum(dd[k] for k in DUTIES)
                st = dd["stage"]
                obs = (sum(st[1:1 + len(OBS)]) / st[0]) if st and st[0] else float("nan")
                det = dd["detail"]
                jo = det.get("live.observe", 0) / max(det.get("live.observe#", 0), 1)
                print(f"third {n + 1}: {dd['observed'] / (dd['wall'] / 1000):.0f} fps observed, busy"
                      f" {100 * busy / dd['wall']:.0f}%, live {dd['live'] / max(dd['observed'], 1):.2f} ms/frame,"
                      f" JS observe {jo:.2f}, wasm stages {obs:.2f} ms/frame, visit {dd['visit'] / max(dd['observed'], 1):.2f},"
                      f" housekeep {dd['housekeep'] / max(dd['observed'], 1):.2f}, publish {dd['publish'] / max(dd['observed'], 1):.2f}")
    ends = [k for k in range(1, len(rows))
            if rows[k]["acct"]["lookback"]["end"]["frames"] > rows[k - 1]["acct"]["lookback"]["end"]["frames"]]
    if ends:
        a, b = ends[0] - 1, ends[-1]
        d = window(rows, a, b)
        fmt_table("Final settle", d, max(d["lookback"]["end"]["frames"], 1), "settle frames")


if __name__ == "__main__":
    main()
