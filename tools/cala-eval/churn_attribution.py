"""Attribute large footprint changes (qc_eval --churn-log run) to causes.

usage: python3 tools/cala-eval/churn_attribution.py RUN_DIR [LABEL_BUNDLE_DIR] > note.md

RUN_DIR: a qc_eval real run with --churn-log (edits.tsv, fp_history.bin,
adds.tsv, removals.tsv; tests.tsv when built with --features diagnostics).
LABEL_BUNDLE_DIR: a cala-label bundle (manifest.json, labels.jsonl).
"""
import sys, struct, json, collections, math
import numpy as np

run = sys.argv[1]
labels_dir = sys.argv[2] if len(sys.argv) > 2 else None
SIGMA_L = 20.0  # glow flattener sigma, 2 x cell diameter (10 px)
BIG = 0.1
LATE = 12000  # recording frame: minutes 10-15
LAG = 120  # publication lag (commit interval 100 slow frames + batching): an
# edit made in the last LAG frames before a checkpoint is published after it


def read_hist(path):
    data = open(path, "rb").read()
    assert data[:8] == b"CALAFH01"
    off = 8
    cps = []
    while off < len(data):
        frame, n = struct.unpack_from("<QI", data, off)
        off += 12
        cells = {}
        for _ in range(n):
            cid, born, noise = struct.unpack_from("<QQd", data, off)
            off += 24
            fp = []
            for _k in range(2):
                (m,) = struct.unpack_from("<I", data, off)
                off += 4
                pix = np.frombuffer(data, "<u4", m, off)
                off += 4 * m
                val = np.frombuffer(data, "<f4", m, off).astype(np.float64)
                off += 4 * m
                fp.append((pix, val))
            cells[cid] = dict(born=born, noise=noise, f=fp[0], r=fp[1])
        cps.append((frame, cells))
    return cps


def rel(a, b):
    """(||a-b||/||a||, unit-norm distance) on sparse footprints, a newer."""
    pa, va = a
    pb, vb = b
    na = np.linalg.norm(va)
    nb = np.linalg.norm(vb)
    if na <= 0:
        return math.nan, math.nan
    allp = np.union1d(pa, pb)
    xa = np.zeros(len(allp))
    xb = np.zeros(len(allp))
    xa[np.searchsorted(allp, pa)] = va
    xb[np.searchsorted(allp, pb)] = vb
    d = np.linalg.norm(xa - xb) / na
    s = np.linalg.norm(xa / na - (xb / nb if nb > 0 else 0))
    return d, s


def geom(fp, W=600):
    pix, val = fp
    w = np.maximum(val, 0)
    if w.sum() <= 0:
        w = np.ones_like(val)
    y = pix // W
    x = pix % W
    cy = (w * y).sum() / w.sum()
    cx = (w * x).sum() / w.sum()
    r = math.sqrt(len(pix) / math.pi)
    return cy, cx, r


def read_tsv(path):
    try:
        lines = open(path).read().strip().split("\n")
    except FileNotFoundError:
        return []
    h = lines[0].split("\t")
    return [dict(zip(h, l.split("\t"))) for l in lines[1:]]


cps = read_hist(f"{run}/fp_history.bin")
edits = read_tsv(f"{run}/edits.tsv")
tests = read_tsv(f"{run}/tests.tsv")
adds = read_tsv(f"{run}/adds.tsv")
rems = read_tsv(f"{run}/removals.tsv")
frames = [f for f, _ in cps]
print(f"checkpoints {len(cps)} ({frames[0]}..{frames[-1]}), edits {len(edits)}, tests {len(tests)}")

# geometry of every cell at every checkpoint, for reach tests
geo = [{cid: geom(c["r"]) for cid, c in cells.items()} for _, cells in cps]


def last_geo(cid, v):
    for u in range(v, -1, -1):
        if cid in geo[u]:
            return geo[u][cid]
    for u in range(v + 1, len(geo)):
        if cid in geo[u]:
            return geo[u][cid]
    return None


def rawchanged(cid, u):
    a = cps[u - 1][1].get(cid)
    b = cps[u][1].get(cid)
    if a is None or b is None:
        return b is not None or a is not None
    return not (len(a["r"][0]) == len(b["r"][0]) and np.array_equal(a["r"][0], b["r"][0]) and np.array_equal(a["r"][1], b["r"][1]))


# events per interval v (frames[v-1], frames[v]]
ev_by_iv = collections.defaultdict(list)
for e in edits:
    f = int(e["recording_frame"])
    v = next((i for i, fr in enumerate(frames) if fr >= f), None)
    if v is None or v == 0:
        continue
    # an own edit is attributed to the first checkpoint (this one or the
    # next, publication lag) at which the cell's raw footprint changed
    if e["kind"] in ("refine", "absorb", "merge", "split"):
        i0 = int(e["id"])
        for u in (v, v + 1):
            if u < len(cps) and rawchanged(i0, u):
                v = u
                break
    e = dict(e)
    e["id"] = int(e["id"])
    e["other"] = int(e["other"])
    e["cy"] = float(e["cy"])
    e["cx"] = float(e["cx"])
    ev_by_iv[v].append(e)


def own_kinds(cid, v):
    ks = []
    for e in ev_by_iv.get(v, []):
        if e["id"] == cid and e["kind"] in ("refine", "absorb", "merge", "split"):
            ks.append(e["kind"] + ("_res" if e["kind"] == "refine" and e["other"] == 2 else ""))
    # refine_res (reservoir source) is reported as its own kind
    return ks


def neighbour_events(cid, v, moat):
    """Structural events (add/delete/merge/split) of other cells within reach."""
    g = geo[v].get(cid) or geo[v - 1].get(cid)
    cy, cx, r = g
    out = []
    for e in ev_by_iv.get(v, []):
        if e["kind"] not in ("add", "delete", "merge", "split"):
            continue
        ids = []
        if e["kind"] == "add":
            ids = [e["id"]]
        elif e["kind"] == "delete":
            ids = [e["id"]]
        elif e["kind"] == "merge":
            ids = [e["id"], e["other"]]
        elif e["kind"] == "split":
            ids = [e["id"], e["other"]]
        for j in ids:
            if j == cid:
                continue
            gj = last_geo(j, v)
            if gj is None:
                gj = (e["cy"], e["cx"], 5.0)
            d = math.hypot(gj[0] - cy, gj[1] - cx)
            lim = r + gj[2] + (2 * SIGMA_L if moat else 0.0)
            if d < lim:
                out.append(e["kind"])
                break
    return out


def neighbour_refines(cid, v):
    g = geo[v].get(cid)
    cy, cx, r = g
    n = 0
    for e in ev_by_iv.get(v, []):
        if e["kind"] in ("refine", "absorb") and e["id"] != cid:
            gj = last_geo(e["id"], v)
            if gj and math.hypot(gj[0] - cy, gj[1] - cx) < r + gj[2]:
                n += 1
    return n


# ---- per-cell lag-1 changes ------------------------------------------------
rows = []  # (v, cid, change, shape, noise, rawchange, age)
for v in range(1, len(cps)):
    f0, c0 = cps[v - 1]
    f1, c1 = cps[v]
    for cid, b in c1.items():
        a = c0.get(cid)
        if a is None:
            continue
        ch, sh = rel(b["f"], a["f"])
        rch, _ = rel(b["r"], a["r"])
        rows.append(
            dict(v=v, frame=f1, cid=cid, ch=ch, sh=sh, noise=b["noise"], rch=rch, age=f1 - b["born"])
        )
print(f"lag-1 pairs {len(rows)}")


def classify(r):
    ks = own_kinds(r["cid"], r["v"])
    if ks:
        pri = [k for k in ("merge", "split", "absorb", "refine_res", "refine") if k in ks][0]
        return "own", pri
    if neighbour_events(r["cid"], r["v"], moat=False):
        return "neighbour_support", None
    if neighbour_events(r["cid"], r["v"], moat=True):
        return "neighbour_moat", None
    if r["rch"] < 1e-6:
        return "filtered_only", None
    return "drift", None


def big(r):
    return r["ch"] > BIG and (not math.isfinite(r["noise"]) or r["ch"] > r["noise"])


def big_noise(r):
    return r["ch"] > BIG and math.isfinite(r["noise"]) and r["ch"] > r["noise"]


out = []
P = out.append

for label, sel in (("all checkpoints", lambda r: True), (f"late (frame > {LATE})", lambda r: r["frame"] > LATE)):
    for crit_name, crit in (("> 10 % and > noise (when the cell has one)", big), ("> 10 % and > noise (noise required)", big_noise)):
        bigs = [r for r in rows if sel(r) and crit(r)]
        cnt = collections.Counter()
        kinds = collections.Counter()
        resc = collections.Counter()
        nbr_before = collections.Counter()
        for r in bigs:
            c, k = classify(r)
            cnt[c] += 1
            if k:
                kinds[k] += 1
                # own edit with a neighbour structural event in the same interval
                if neighbour_events(r["cid"], r["v"], moat=False):
                    nbr_before[k] += 1
            if r["sh"] < BIG:
                resc[c] += 1
        n = len(bigs)
        P(f"\n### {label}, change {crit_name}: {n} large changes (of {sum(1 for r in rows if sel(r))} lag-1 pairs)\n")
        P("| class | n | share | of which rescale only (shape < 10 %) |")
        P("| --- | --- | --- | --- |")
        for c in ("own", "neighbour_support", "neighbour_moat", "filtered_only", "drift"):
            P(f"| {c} | {cnt[c]} | {cnt[c]/max(n,1):.2f} | {resc[c]} |")
        P("")
        P("| own edit kind | n | share of own | with a structural neighbour event (support) same interval |")
        P("| --- | --- | --- | --- |")
        no = max(cnt["own"], 1)
        for k in ("refine", "refine_res", "absorb", "merge", "split"):
            P(f"| {k} | {kinds[k]} | {kinds[k]/no:.2f} | {nbr_before[k]} |")
        if bigs:
            P(f"\nmedian change {np.median([r['ch'] for r in bigs]):.2f}, median shape change {np.median([r['sh'] for r in bigs]):.2f}")

# also: how many own edits are small (not large)?
P("\n### Own edits by size of the published change (lag 1, all)\n")
P("| kind | edited cell-intervals | change > 10 % | > 10 % and > noise | median change |")
P("| --- | --- | --- | --- | --- |")
byk = collections.defaultdict(list)
for r in rows:
    ks = own_kinds(r["cid"], r["v"])
    if ks:
        pri = [k for k in ("merge", "split", "absorb", "refine_res", "refine") if k in ks][0]
        byk[pri].append(r)
for k in ("refine", "refine_res", "absorb", "merge", "split"):
    L = byk[k]
    if L:
        P(f"| {k} | {len(L)} | {sum(r['ch']>BIG for r in L)} | {sum(big_noise(r) for r in L)} | {np.median([r['ch'] for r in L]):.3f} |")
noedit = [r for r in rows if not own_kinds(r["cid"], r["v"])]
P(f"| none | {len(noedit)} | {sum(r['ch']>BIG for r in noedit)} | {sum(big_noise(r) for r in noedit)} | {np.median([r['ch'] for r in noedit]):.3f} |")
P(f"\nno-edit intervals with any filtered change > 0.1 %: {sum(r['ch']>1e-3 for r in noedit)}; raw change > 1e-6: {sum(r['rch']>1e-6 for r in noedit)}")

# ---- detail of large own-edit changes ----------------------------------------
P("\n### Large own-edit changes (> 10 %, > noise when present): what moved\n")
P("| kind | n | median age (frames) | share age > 6000 | median centroid shift px | median support ratio new/old | median noise | share noise NaN |")
P("| --- | --- | --- | --- | --- | --- | --- | --- |")
det = collections.defaultdict(list)
for r in rows:
    if not big(r):
        continue
    ks = own_kinds(r["cid"], r["v"])
    if not ks:
        continue
    k = [k for k in ("merge", "split", "absorb", "refine_res", "refine") if k in ks][0]
    b = cps[r["v"]][1][r["cid"]]
    a = cps[r["v"] - 1][1][r["cid"]]
    ga, gb = geom(a["r"]), geom(b["r"])
    det[k].append((r["age"], math.hypot(ga[0] - gb[0], ga[1] - gb[1]), len(b["r"][0]) / max(len(a["r"][0]), 1), r["noise"], r["frame"]))
for k in ("refine", "refine_res", "absorb", "merge", "split"):
    L = det[k]
    if not L:
        continue
    A = np.array(L)
    late = A[A[:, 4] > LATE]
    P(f"| {k} | {len(L)} (late {len(late)}) | {np.median(A[:,0]):.0f} | {np.mean(A[:,0]>6000):.2f} | {np.median(A[:,1]):.2f} | {np.median(A[:,2]):.2f} | {np.nanmedian(A[:,3]):.2f} | {np.mean(np.isnan(A[:,3])):.2f} |")

# ---- lag-4 replication of E7 headline ---------------------------------------
P("\n### Lag 4 (one minute) at the last checkpoints\n")
P("| frame | pairs | share > 10 % | share > 10 % and > noise | of those: with an own edit in the window |")
P("| --- | --- | --- | --- | --- |")
for v in range(len(cps) - 1, 3, -4):
    f1, c1 = cps[v]
    _, c0 = cps[v - 4]
    n = b10 = bn = own = 0
    for cid, b in c1.items():
        a = c0.get(cid)
        if a is None:
            continue
        n += 1
        ch, sh = rel(b["f"], a["f"])
        if ch > BIG:
            b10 += 1
            if math.isfinite(b["noise"]) and ch > b["noise"]:
                bn += 1
                if any(own_kinds(cid, u) for u in range(v - 3, v + 1)):
                    own += 1
    P(f"| {f1} | {n} | {b10/max(n,1):.3f} | {bn/max(n,1):.3f} | {own}/{bn} |")
    if f1 < LATE:
        break

# ---- oscillation -----------------------------------------------------------
# per cell trajectory of unit-norm filtered footprints; for each large own-edit
# change at v (state v-1 -> v), does a later state return close to v-1?
P("\n### Oscillation of own-edit changes\n")
traj = collections.defaultdict(dict)
for v, (f, cells) in enumerate(cps):
    for cid, c in cells.items():
        traj[cid][v] = c["f"]
big_own = [r for r in rows if big(r) and own_kinds(r["cid"], r["v"])]
ret = fwd = nolater = 0
ret_ratio = []
returns_by_cell = collections.Counter()
bigs_by_cell = collections.Counter()
for r in big_own:
    cid, v = r["cid"], r["v"]
    bigs_by_cell[cid] += 1
    t = traj[cid]
    later = [w for w in t if w > v]
    if not later:
        nolater += 1
        continue
    _, step = rel(t[v], t[v - 1])  # shape distance of the jump
    # closest later state to the pre-jump state, relative to the jump
    best = min(rel(t[w], t[v - 1])[1] for w in later)
    ret_ratio.append(best / step if step > 0 else math.nan)
    if best < 0.5 * step:
        ret += 1
        returns_by_cell[cid] += 1
    else:
        fwd += 1
P(f"large own-edit changes {len(big_own)} (> 10 % and > noise, all checkpoints); with later states {ret+fwd}")
P(f"- returns to within half the jump of the pre-jump shape later (A->B->A): {ret} ({ret/max(ret+fwd,1):.2f})")
P(f"- stays away (one-way): {fwd} ({fwd/max(ret+fwd,1):.2f})")
rr = np.array([x for x in ret_ratio if math.isfinite(x)])
if len(rr):
    P(f"- closest later return / jump size: quartiles {np.percentile(rr,25):.2f} {np.median(rr):.2f} {np.percentile(rr,75):.2f}")
multi = [c for c, n in bigs_by_cell.items() if n >= 2]
P(f"- cells with >= 2 large own-edit changes: {len(multi)} of {len(bigs_by_cell)} cells with any; they hold {sum(bigs_by_cell[c] for c in multi)} of {len(big_own)} changes")
# path vs net over the late window for cells present the whole late window
vl = next(i for i, f in enumerate(frames) if f > LATE) - 1
ratios = []
for cid, t in traj.items():
    vs = [w for w in range(vl, len(cps)) if w in t]
    if len(vs) != len(cps) - vl:
        continue
    path = sum(rel(t[vs[i + 1]], t[vs[i]])[1] for i in range(len(vs) - 1))
    if path < 0.2:
        continue
    net = rel(t[vs[-1]], t[vs[0]])[1]
    ratios.append(net / path)
ratios = np.array(ratios)
if len(ratios):
    P(
        f"- late window (frame {frames[vl]}..{frames[-1]}), cells whose shape path >= 0.2: {len(ratios)}; net/path median {np.median(ratios):.2f}, share < 0.5 (back and forth): {np.mean(ratios<0.5):.2f}"
    )

# by kind
P("\n| kind of jump | n | returns | share |")
P("| --- | --- | --- | --- |")
bk = collections.Counter()
bkr = collections.Counter()
for r in big_own:
    cid, v = r["cid"], r["v"]
    k = [k for k in ("merge", "split", "absorb", "refine_res", "refine") if k in own_kinds(cid, v)][0]
    t = traj[cid]
    later = [w for w in t if w > v]
    if not later:
        continue
    _, step = rel(t[v], t[v - 1])
    best = min(rel(t[w], t[v - 1])[1] for w in later)
    bk[k] += 1
    bkr[k] += best < 0.5 * step
for k in ("refine", "refine_res", "absorb", "merge", "split"):
    P(f"| {k} | {bk[k]} | {bkr[k]} | {bkr[k]/max(bk[k],1):.2f} |")

# ---- refine mechanics ------------------------------------------------------
def P2(*a):
    P(" ".join(str(x) for x in a))
P("\n### Refine mechanics\n")
P("```")
P2("frame  cells  median_px  p90_px  share>1000px  share>3000px")
for v in range(9, len(cps), 10):
    n=np.array([len(c['r'][0]) for c in cps[v][1].values()])
    P2(cps[v][0], len(n), int(np.median(n)), int(np.percentile(n,90)), round(np.mean(n>1000),3), round(np.mean(n>3000),3))
# for each refine: energy share of new pixels (raw, unit norm), change on common pixels, outer ring mean value relative to peak
newE=[]; comm=[]; ringrel=[]
for v, L in ev_by_iv.items():
    for e in L:
        if e['kind']!='refine': continue
        a=cps[v-1][1].get(e['id']); b=cps[v][1].get(e['id'])
        if a is None or b is None: continue
        pa,va=a['r']; pb,vb=b['r']
        nb=np.linalg.norm(vb); na=np.linalg.norm(va)
        m=np.isin(pb,pa)
        newE.append(np.sum(vb[~m]**2)/nb**2)
        # change on common pixels, unit norm
        ia=np.searchsorted(pa,pb[m])
        comm.append(np.linalg.norm(vb[m]/nb - va[ia]/na))
        if (~m).any(): ringrel.append(np.mean(vb[~m])/vb.max())
newE=np.array(newE); comm=np.array(comm)
P2("refines", len(newE), "energy share on newly added pixels: quartiles", np.percentile(newE,[25,50,75]).round(3))
P2("unit-norm change on common pixels quartiles", np.percentile(comm,[25,50,75]).round(3))
P2("mean value on new pixels / peak quartiles", np.percentile(ringrel,[25,50,75]).round(3))
ref = collections.defaultdict(list)
for v, L in ev_by_iv.items():
    for e in L:
        if e['kind']=='refine': ref[e['id']].append(v)
# jump vs noise
rat=[]; jumps=[]; noises=[]; fr=[]
for cid, vs in ref.items():
    for v in vs:
        a=cps[v-1][1].get(cid); b=cps[v][1].get(cid)
        if a is None or b is None: continue
        d,sh=rel(b['f'],a['f'])
        if math.isfinite(b['noise']): rat.append(sh/b['noise']); jumps.append(sh); noises.append(b['noise']); fr.append(cps[v][0])
rat=np.array(rat); fr=np.array(fr); jumps=np.array(jumps); noises=np.array(noises)
for lo,hi in ((0,6000),(6000,12000),(12000,18001)):
    m=(fr>lo)&(fr<=hi)
    P2(f"frames {lo}-{hi}: refines {m.sum()} jump(shape) median {np.median(jumps[m]):.3f}  noise median {np.median(noises[m]):.3f}  jump/noise median {np.median(rat[m]):.2f} q25 {np.percentile(rat[m],25):.2f} q75 {np.percentile(rat[m],75):.2f}")
# successive refines A->B->C (states just before refine 1, after refine1, after refine2)
r_ac=[]; ratio=[]
for cid, vs in ref.items():
    vs=sorted(set(vs))
    for v1,v2 in zip(vs,vs[1:]):
        A=cps[v1-1][1].get(cid); B=cps[v1][1].get(cid); C=cps[v2][1].get(cid)
        if None in (A,B,C): continue
        ab=rel(B['f'],A['f'])[1]; bc=rel(C['f'],B['f'])[1]; ac=rel(C['f'],A['f'])[1]
        ratio.append(ac/(ab+bc)); r_ac.append((ab,bc,ac))
ratio=np.array(ratio); R=np.array(r_ac)
P2("consecutive refine pairs", len(ratio), "d(A,C)/(d(A,B)+d(B,C)) quartiles", np.percentile(ratio,[25,50,75]).round(2), " (1 = directed, 0.71 = random walk / independent increments, 0.5 = independent re-samples of a fixed truth, 0 = return)")
P2("median d(A,B) d(B,C) d(A,C):", np.median(R,axis=0).round(3))
# does the jump scale with the cell's own noise? (late refines, across cells)
m = (fr > LATE) & (jumps > 0) & (noises > 0)
lj, ln = np.log(jumps[m]), np.log(noises[m])
slope = np.polyfit(ln, lj, 1)[0]
P2(f"late refines: log jump vs log noise across cells: slope {slope:.2f}, r {np.corrcoef(ln, lj)[0,1]:.2f} (1 = jump proportional to the cell's noise)")
qs = np.percentile(noises[m], [33, 67])
for lo, hi, nm in ((0, qs[0], "low-noise third"), (qs[0], qs[1], "mid third"), (qs[1], 9, "high-noise third")):
    k = m & (noises >= lo) & (noises < hi)
    P2(f"  {nm}: noise median {np.median(noises[k]):.3f} jump median {np.median(jumps[k]):.3f}")
P("```")

# ---- acceptance rates --------------------------------------------------------
if tests:
    P("\n### Held-out edit tests and acceptance, per 2-minute bin\n")
    P("| minutes | kind | tests | accepted | rate | distinct cells tested | tests per cell |")
    P("| --- | --- | --- | --- | --- | --- | --- |")
    binf = 2400
    T = collections.defaultdict(lambda: [0, 0, set()])
    for t in tests:
        b = int(t["recording_frame"]) // binf
        k = t["kind"]
        T[(b, k)][0] += 1
        T[(b, k)][1] += int(t["accepted"])
        T[(b, k)][2].add(int(t["id"]))
    for b in sorted({b for b, _ in T}):
        for k in ("refine", "absorb", "merge", "split"):
            if (b, k) in T:
                n, a, s = T[(b, k)]
                P(f"| {b*2}-{b*2+2} | {k} | {n} | {a} | {a/n:.3f} | {len(s)} | {n/len(s):.1f} |")
    # per cell, late: refine tests and accepts
    late_tests = [t for t in tests if int(t["recording_frame"]) > LATE and t["kind"] == "refine"]
    pc = collections.defaultdict(lambda: [0, 0])
    for t in late_tests:
        pc[int(t["id"])][0] += 1
        pc[int(t["id"])][1] += int(t["accepted"])
    if pc:
        acc = np.array([a for n, a in pc.values()])
        nt = np.array([n for n, a in pc.values()])
        P(
            f"\nLate (frame > {LATE}) refine tests per tested cell: median {np.median(nt):.0f}, max {nt.max()}; accepted per cell: share with 0 {np.mean(acc==0):.2f}, 1 {np.mean(acc==1):.2f}, >= 2 {np.mean(acc>=2):.2f}, >= 4 {np.mean(acc>=4):.2f}"
        )
        zs = np.array([float(t["z"]) for t in late_tests])
        P(f"late refine z quartiles {np.nanpercentile(zs,25):.2f} {np.nanmedian(zs):.2f} {np.nanpercentile(zs,75):.2f}")

# ---- add / removal breakdown (the "24 cells per minute" claim) ---------------
P("\n### Adds and removals per minute\n")
P("| minute | adds new | adds re-add | split births | deletes | merges | of removals: churned (< 2 min old) |")
P("| --- | --- | --- | --- | --- | --- | --- |")
am = collections.Counter()
for a in adds:
    am[(int(a["recording_frame"]) // 1200, a["class"])] += 1
rm = collections.Counter()
for r_ in rems:
    m = int(r_["recording_frame"]) // 1200
    rm[(m, r_["kind"])] += 1
    rm[(m, "churned")] += int(r_["churned"])
sm = collections.Counter(int(e["recording_frame"]) // 1200 for e in edits if e["kind"] == "split")
for m in range(0, frames[-1] // 1200 + 1):
    P(f"| {m} | {am[(m,'new')]} | {am[(m,'readd')]} | {sm[m]} | {rm[(m,'delete')]} | {rm[(m,'merge')]} | {rm[(m,'churned')]} |")

# ---- labels ------------------------------------------------------------------
if labels_dir:
    man = json.load(open(f"{labels_dir}/manifest.json"))
    cand = {c["cid"]: c for c in man["selection"]["candidates"]}
    labs = {}
    for l in open(f"{labels_dir}/labels.jsonl"):
        x = json.loads(l)
        labs[x["cid"]] = x["label"]  # last wins
    final = cps[-1][1]
    fg = {cid: geo[-1][cid] for cid in final}
    # flip-flop: >= 2 large own-edit changes, or any return
    flip = {c for c, n in bigs_by_cell.items() if n >= 2} | set(returns_by_cell)
    anybig = set(bigs_by_cell)
    tab = collections.defaultdict(collections.Counter)
    matched = 0
    for cid, lab in labs.items():
        c = cand.get(cid)
        if not c:
            continue
        best = None
        for fid, (cy, cx, r) in fg.items():
            d = math.hypot(cy - c["cy"], cx - c["cx"])
            if d < 4.0 and (best is None or d < best[0]):
                best = (d, fid)
        if best is None:
            tab[lab]["no match in final library"] += 1
            continue
        matched += 1
        fid = best[1]
        k = "flip-flop" if fid in flip else ("one large own edit" if fid in anybig else "no large own edit")
        tab[lab][k] += 1
    P(f"\n### PI labels vs flip-flopping (match: final-library cell centroid within 4 px; {matched} of {len(labs)} labels matched)\n")
    cols = ["flip-flop", "one large own edit", "no large own edit", "no match in final library"]
    P("| label | " + " | ".join(cols) + " | flip-flop share of matched |")
    P("| --- | " + " | ".join("---" for _ in cols) + " | --- |")
    for lab in sorted(tab):
        t = tab[lab]
        m = t["flip-flop"] + t["one large own edit"] + t["no large own edit"]
        P(f"| {lab} | " + " | ".join(str(t[c]) for c in cols) + f" | {t['flip-flop']/max(m,1):.2f} |")
    P(f"\nflip-flop cells in final library: {len(flip & set(final))} of {len(final)}")

print("\n".join(out))
