"""Per final cell of a real run: best Minian footprint r (mr, offset (1,0)) and
the correlation of cala's pass-2 trace with that unit's C (minian_tr).
usage: qc_snr_minian.py RUN  -> RUN/minian.tsv (needs zarr)"""
import sys
import struct

import numpy as np
import pandas as pd
import zarr


def read_fp(path):
    """`footprints.bin` (CALAFP01): per cell (id, pixels, values, split-half h)."""
    b = open(path, "rb").read()
    H, W, n = struct.unpack_from("<3I", b, 8)
    o = 20
    out = []
    for _ in range(n):
        cid, m = struct.unpack_from("<2I", b, o)
        o += 8
        p = np.frombuffer(b, "<u4", m, o).astype(np.int64)
        o += 4 * m
        a = np.frombuffer(b, "<f4", m, o).astype(np.float64)
        o += 4 * m
        h = np.frombuffer(b, "<f4", m, o).astype(np.float64)
        o += 4 * m
        out.append((cid, p, a, h))
    return H, W, out

run = sys.argv[1]
mout = "/Users/daharoni/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/minian_out"
A = zarr.open(mout + "/A.zarr", mode="r")["A"]
C = np.asarray(zarr.open(mout + "/C.zarr", mode="r")["C"], dtype=np.float64)
MW = A.shape[2]
mins = []
for u in range(A.shape[0]):
    a = np.nan_to_num(np.asarray(A[u], dtype=np.float64)).ravel()
    nz = np.flatnonzero(a > 0)
    if nz.size:
        w = a[nz] / a[nz].sum()
        mins.append((u, nz, a[nz], (nz // MW * w).sum(), (nz % MW * w).sum()))
mc = np.array([[m[3], m[4]] for m in mins])
DY, DX = 1, 0
H, W, fps = read_fp(f"{run}/footprints.bin")
fin = pd.read_csv(f"{run}/final.tsv", sep="\t")
n = len(fin)
tr = np.fromfile(f"{run}/dump_trace.f32", "<f4").reshape(-1, n)
T = min(tr.shape[0], C.shape[1])
rows = []
for s, (cid, p, a, _) in enumerate(fps):
    a = np.maximum(a, 0)
    y, x = p // W - DY, p % W - DX
    cy, cx = np.average(y, weights=np.maximum(a, 1e-9)), np.average(x, weights=np.maximum(a, 1e-9))
    d = np.hypot(mc[:, 0] - cy, mc[:, 1] - cx)
    best, bu = 0.0, -1
    q = y * MW + x
    for j in np.flatnonzero(d < 15):
        u, nz, v, _, _ = mins[j]
        un = np.union1d(q, nz)
        va = np.zeros(len(un)); vb = np.zeros(len(un))
        va[np.searchsorted(un, q)] = a
        vb[np.searchsorted(un, nz)] = v
        r = np.corrcoef(va, vb)[0, 1]
        if r > best:
            best, bu = r, u
    slot = int(np.flatnonzero(fin.id.values == cid)[0])
    trr = np.corrcoef(tr[:T, slot], C[bu, :T])[0, 1] if bu >= 0 else np.nan
    rows.append(dict(id=int(cid), mr=best, minian_unit=bu, minian_tr=trr))
pd.DataFrame(rows).to_csv(f"{run}/minian.tsv", sep="\t", index=False)
df = pd.DataFrame(rows)
print(len(df), "cells; mr>=.5:", int((df.mr >= .5).sum()), "median trace r (mr>=.5):", df[df.mr >= .5].minian_tr.median())
