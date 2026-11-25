"""Self time of a slow-worker CPU profile (`memory-measure.mjs --profile-slow`), by category.

usage: python3 cpuprofile_summary.py FILE.cpuprofile [--top 20]

Categories: (idle), (garbage collector), (program) (V8 work outside any JS or
WASM frame: message deserialisation, task scheduling), WASM frames, and JS
frames (top functions by self time, with their file).
"""
import json
import sys
from collections import defaultdict


def main():
    prof = json.load(open(sys.argv[1]))
    top = int(sys.argv[sys.argv.index("--top") + 1]) if "--top" in sys.argv else 20
    nodes = {n["id"]: n for n in prof["nodes"]}
    self_us = defaultdict(float)
    for sid, dt in zip(prof["samples"], prof["timeDeltas"]):
        self_us[sid] += dt
    total = sum(self_us.values())
    cat = defaultdict(float)
    js = defaultdict(float)
    wasm = defaultdict(float)
    for nid, us in self_us.items():
        cf = nodes[nid]["callFrame"]
        name, url = cf.get("functionName") or "(anonymous)", cf.get("url", "")
        if name in ("(idle)", "(garbage collector)", "(program)", "(root)"):
            cat[name] += us
        elif url.startswith("wasm://") or name.startswith("$") or "wasm-function" in name:
            cat["wasm"] += us
            wasm[name] += us
        else:
            cat["js"] += us
            js[f"{name} ({url.rsplit('/', 1)[-1].split('?')[0]}:{cf.get('lineNumber', -1) + 1})"] += us
    print(f"{sys.argv[1]}: {total / 1e6:.2f} s sampled")
    print("| category | s | share |")
    print("|---|---:|---:|")
    for k, v in sorted(cat.items(), key=lambda x: -x[1]):
        print(f"| {k} | {v / 1e6:.2f} | {100 * v / total:.1f}% |")
    busy = total - cat.get("(idle)", 0)
    print(f"\nbusy (not idle) {busy / 1e6:.2f} s; GC {100 * cat.get('(garbage collector)', 0) / max(busy, 1):.1f}% of busy,"
          f" (program) {100 * cat.get('(program)', 0) / max(busy, 1):.1f}%, JS {100 * cat.get('js', 0) / max(busy, 1):.1f}%,"
          f" wasm {100 * cat.get('wasm', 0) / max(busy, 1):.1f}%")
    for title, d in (("JS", js), ("WASM", wasm)):
        print(f"\ntop {title} self time:")
        for k, v in sorted(d.items(), key=lambda x: -x[1])[:top]:
            print(f"  {100 * v / max(busy, 1):5.1f}%  {k}")


if __name__ == "__main__":
    main()
