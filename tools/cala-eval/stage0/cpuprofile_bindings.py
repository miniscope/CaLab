"""Inclusive time of a CPU profile per JS binding (the release WASM has no function names).

usage: python3 cpuprofile_bindings.py PROFILE.cpuprofile [NAME ...]

Each sample is charged to the innermost ancestor frame whose function name is one of NAME (default: the
look-back worker's and slow worker's WASM entry points), so a WASM function with no name is attributed to the
binding that called it (e.g. `reconstruct` vs `processFrames` on the look-back side). Prints seconds and the
share of the sampled time and of the busy (non-idle) time.
"""
import json
import sys
from collections import Counter

DEFAULT = ["reconstruct", "processFrames", "lastBackground", "neverValid", "open", "fromBytes", "rebuildFrames",
           "observe", "observeSettle", "takeJob", "applyJob", "housekeep", "publish", "toBytes", "finalize",
           "TraceEngine", "new", "free"]


def main():
    prof = json.load(open(sys.argv[1]))
    names = set(sys.argv[2:] or DEFAULT)
    nodes = {n["id"]: n for n in prof["nodes"]}
    parent = {}
    for n in prof["nodes"]:
        for c in n.get("children", []):
            parent[c] = n["id"]
    memo = {}

    def owner(i):
        if i in memo:
            return memo[i]
        j, out = i, None
        while j is not None:
            fn = nodes[j]["callFrame"]["functionName"]
            if fn in names:
                out = fn
                break
            if fn == "(idle)":
                out = "(idle)"
                break
            j = parent.get(j)
        memo[i] = out or "(other)"
        return memo[i]

    deltas = prof.get("timeDeltas") or [0] * len(prof["samples"])
    tot = Counter()
    for s, d in zip(prof["samples"], deltas):
        tot[owner(s)] += d
    all_us = sum(tot.values())
    busy = all_us - tot["(idle)"]
    print(f"{sys.argv[1]}: {all_us / 1e6:.2f} s sampled, busy {busy / 1e6:.2f} s")
    print("| binding (inclusive) | s | share of sampled | share of busy |")
    print("|---|---:|---:|---:|")
    for k, v in tot.most_common():
        print(f"| {k} | {v / 1e6:.2f} | {100 * v / all_us:.1f}% | {'' if k == '(idle)' else f'{100 * v / busy:.1f}%'} |")


if __name__ == "__main__":
    main()
