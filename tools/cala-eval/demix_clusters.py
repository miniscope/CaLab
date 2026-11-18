"""Overlap clusters of a cala library (Stage 0 of design_discover_lookback.md / design_joint_update.md).

    ρ_ij = G_ij / sqrt(G_ii G_jj),   G = Ãᵀ Ã over the library's FILTERED footprint columns (the second
                                      per-pixel array of `footprints.bin`; the Gram the fast loop uses, here
                                      without the per-pixel noise weights, which `footprints.bin` does not carry)
    edge i-j  iff ρ_ij >= RHO_MIN (0.05)
    clusters  = connected components cut greedily to at most K_MAX (6) members: edges taken in descending ρ
                (Kruskal), a union that would exceed K_MAX is refused (design_joint_update.md §2.1)

`cluster_stats` summarises one library; `membership_change` compares the clusters of two libraries of the same
run (checkpoints during Discover) and says how many surviving cells saw their cluster change, and why.
numpy and scipy only.
"""

from __future__ import annotations

import numpy as np
from scipy import sparse

RHO_MIN = 0.05
K_MAX = 6


def gram_rho(filt, n_px):
    """Sparse symmetric matrix of ρ_ij (diagonal removed) from filtered columns [(pix, val)]."""
    n = len(filt)
    if n == 0:
        return sparse.csr_matrix((0, 0))
    rows = np.concatenate([np.full(len(p), i) for i, (p, _) in enumerate(filt)])
    cols = np.concatenate([np.asarray(p, np.int64) for p, _ in filt])
    vals = np.concatenate([np.asarray(v, np.float64) for _, v in filt])
    A = sparse.csr_matrix((vals, (rows, cols)), shape=(n, n_px))
    G = (A @ A.T).tocsr()
    d = np.sqrt(np.maximum(G.diagonal(), 1e-30))
    R = sparse.diags(1.0 / d) @ G @ sparse.diags(1.0 / d)
    R = R.tocsr()
    R.setdiag(0)
    R.eliminate_zeros()
    return R


def cluster_labels(R, rho_min=RHO_MIN, k_max=K_MAX):
    """(cluster label per cell, component label per cell, number of edges cut by K_MAX).

    Components use every edge with ρ >= rho_min; clusters are the K_MAX-capped greedy unions.
    """
    n = R.shape[0]
    U = sparse.triu(R, 1).tocoo()
    keep = U.data >= rho_min
    i, j, r = U.row[keep], U.col[keep], U.data[keep]
    order = np.argsort(-r, kind="stable")
    cap, full = list(range(n)), list(range(n))
    size = [1] * n

    def find(p, x):
        while p[x] != x:
            p[x] = p[p[x]]
            x = p[x]
        return x

    cut = 0
    for e in order:
        a, b = int(i[e]), int(j[e])
        fa, fb = find(full, a), find(full, b)
        if fa != fb:
            full[fa] = fb
        ca, cb = find(cap, a), find(cap, b)
        if ca == cb:
            continue
        if size[ca] + size[cb] > k_max:
            cut += 1
            continue
        cap[ca] = cb
        size[cb] += size[ca]
    return (np.array([find(cap, x) for x in range(n)], dtype=int), np.array([find(full, x) for x in range(n)], dtype=int), cut)


def cluster_stats(filt, n_px, rho_min=RHO_MIN, k_max=K_MAX):
    """Size distribution of the clusters of one library.

    Keys: n_cells; `hist` {size: number of clusters} (sizes 1..k_max, as a dict of str); cells_in_2plus (cells in a
    cluster of 2 or more); share_clustered; mean_size_of_clustered (cell-weighted: the size a clustered cell
    sees); max_component (largest connected component, before the K_MAX cut); cells_in_big_component (cells whose
    component exceeds k_max, the cells the cut touches); edges / edges_cut; median_nbrs (neighbours with ρ >= rho_min per cell).
    """
    n = len(filt)
    if n == 0:
        return {"n_cells": 0, "hist": {}, "cells_in_2plus": 0, "share_clustered": float("nan"), "mean_size_of_clustered": float("nan"),
                "max_component": 0, "cells_in_big_component": 0, "edges": 0, "edges_cut": 0, "median_nbrs": float("nan")}  # fmt: skip
    R = gram_rho(filt, n_px)
    lab, comp, cut = cluster_labels(R, rho_min, k_max)
    sizes = np.bincount(np.unique(lab, return_inverse=True)[1])
    per_cell = sizes[np.unique(lab, return_inverse=True)[1]]
    comp_sizes = np.bincount(np.unique(comp, return_inverse=True)[1])
    comp_per_cell = comp_sizes[np.unique(comp, return_inverse=True)[1]]
    hist = {str(s): int((sizes == s).sum()) for s in range(1, k_max + 1)}
    nbrs = np.asarray((R >= rho_min).sum(1)).ravel()
    clustered = per_cell >= 2
    return {
        "n_cells": n, "hist": hist, "cells_in_2plus": int(clustered.sum()), "share_clustered": float(clustered.mean()),
        "mean_size_of_clustered": float(per_cell[clustered].mean()) if clustered.any() else float("nan"),
        "max_component": int(comp_sizes.max()), "cells_in_big_component": int((comp_per_cell > k_max).sum()),
        "edges": int(sparse.triu(R >= rho_min, 1).nnz), "edges_cut": int(cut), "median_nbrs": float(np.median(nbrs)),
    }  # fmt: skip


def membership(ids, filt, n_px, rho_min=RHO_MIN, k_max=K_MAX):
    """{cell id: frozenset of the ids in its cluster}."""
    if len(ids) == 0:
        return {}
    lab, _, _ = cluster_labels(gram_rho(filt, n_px), rho_min, k_max)
    groups = {}
    for i, c in enumerate(lab):
        groups.setdefault(int(c), set()).add(int(ids[i]))
    return {int(ids[i]): frozenset(groups[int(lab[i])]) for i in range(len(ids))}


def membership_change(m0, m1):
    """How the clusters of the cells present in both libraries changed from m0 to m1.

    For each surviving cell (id in both): its cluster member set at m0 and m1. `changed` = the sets differ.
    Causes (a changed cell counts once, first match): `birth` = the new set has an id absent from m0; `loss` = the
    old set has an id absent from m1; `regroup` = same ids, different grouping. Shares are of surviving cells and,
    separately, of surviving cells that sat in a cluster of 2+ in either library.
    """
    both = [c for c in m0 if c in m1]
    out = {"survivors": len(both), "changed": 0, "birth": 0, "loss": 0, "regroup": 0, "clustered": 0, "clustered_changed": 0}
    for c in both:
        a, b = m0[c], m1[c]
        multi = len(a) > 1 or len(b) > 1
        out["clustered"] += multi
        if a == b:
            continue
        out["changed"] += 1
        out["clustered_changed"] += multi
        if any(x not in m0 for x in b):
            out["birth"] += 1
        elif any(x not in m1 for x in a):
            out["loss"] += 1
        else:
            out["regroup"] += 1
    out["share_changed"] = out["changed"] / len(both) if both else float("nan")
    out["share_clustered_changed"] = out["clustered_changed"] / out["clustered"] if out["clustered"] else float("nan")
    return out
