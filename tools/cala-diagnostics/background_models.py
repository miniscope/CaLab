"""Frozen-input background alternatives; never modifies the CaLa algorithm.

All fits minimize ||y-Ac-B beta||² + ||L beta||², c >= 0, beta signed.
Full/reduced models must share B and L. The objective decrease is *not*
automatically a chi-square statistic when L is nonzero. Calibrate each model
using independently seeded controls; report raw RSS separately.
"""
from dataclasses import dataclass, field
from pathlib import Path
import argparse
import csv
import json

import numpy as np
from scipy.optimize import nnls


def read_tsv(path):
    with Path(path).open() as f:
        return list(csv.DictReader(f, delimiter="\t"))


@dataclass
class Snapshot:
    folder: Path
    y: np.ndarray
    a: np.ndarray
    b: np.ndarray
    ids: np.ndarray
    target_index: int
    meta: dict
    probes: list
    shape: tuple
    inv_sigma: np.ndarray
    fov: np.ndarray


@dataclass
class BackgroundSpec:
    name: str
    b: np.ndarray
    penalty_L: np.ndarray
    metadata: dict = field(default_factory=dict)


def load_snapshot(folder):
    folder = Path(folder)
    meta = {r["key"]: r["value"] for r in read_tsv(folder / "meta.tsv")}
    shape = (int(meta["rect_height"]), int(meta["rect_width"]))
    n = int(np.prod(shape))
    y = np.fromfile(folder / "y.f32", "<f4").reshape(-1, n).astype(float)
    b = np.fromfile(folder / "bg_maps.f32", "<f4").reshape(-1, n).T.astype(float)
    rows = read_tsv(folder / "full_columns.tsv")
    pixels = np.fromfile(folder / "full_pixels.u32", "<u4")
    values = np.fromfile(folder / "full_values.f32", "<f4")
    a = np.zeros((n, len(rows)))
    ids = []
    for j, row in enumerate(rows):
        start = int(row["start"])
        end = start + int(row.get("length", row.get("len")))
        a[pixels[start:end], j] = values[start:end]
        ids.append(int(row["id"]))
    ids = np.asarray(ids)
    return Snapshot(folder, y, a, b, ids, list(ids).index(int(meta["target_id"])),
                    meta, read_tsv(folder / "probes.tsv"), shape,
                    np.fromfile(folder / "inv_sigma.f32", "<f4").astype(float),
                    np.fromfile(folder / "fov.u8", "u1"))


def _penalty_root(gram):
    """Compact square root, preserving a physical-field penalty's exact scale."""
    w, v = np.linalg.eigh((gram + gram.T) / 2)
    return np.sqrt(np.maximum(w, 0))[:, None] * v.T


def make_variants(snapshot, diameter=18.0):
    """Fixed variants, chosen before evaluating true/negative controls.

    Native B columns live directly in whitened coordinates. In particular,
    native broad bumps are NOT multiplied by inv_sigma, so wider bumps retain
    that convention. A fractional power preserves the captured Gaussian's
    center without refitting it. The physical gradient penalty unwhitens B,
    then standardizes each physical first difference by its edge noise scale.
    """
    b = snapshot.b
    if b.shape[1] != 10:
        raise ValueError("Expected nine native grid maps followed by one bump")
    variants = {}

    def add(name, bv, gram=None, **metadata):
        gram = np.zeros((bv.shape[1], bv.shape[1])) if gram is None else gram
        variants[name] = BackgroundSpec(name, bv.copy(), _penalty_root(gram), metadata)

    add("original", b, family="unpenalized", bump_sigma_px=diameter)
    add("no_bump", b[:, :-1], family="unpenalized", bump_sigma_px=None)
    for factor in (1.5, 2.0, 3.0):
        wider = b.copy()
        wider[:, -1] = np.maximum(b[:, -1], 0) ** (1 / factor**2)
        add("wide_" + str(factor).replace(".0", "").replace(".", "p"), wider,
            family="unpenalized", bump_sigma_px=diameter * factor)
    grid = b[:, :-1]
    increment = b[:, -1] - grid @ np.linalg.lstsq(grid, b[:, -1], rcond=None)[0]
    for strength in (0.1, 1.0):
        gram = np.zeros((b.shape[1], b.shape[1]))
        gram[-1, -1] = strength * float(increment @ increment)
        add("incremental_ridge_" + str(strength).replace(".0", "").replace(".", "p"), b, gram,
            family="incremental_ridge", strength=strength,
            formula="lambda * ||(I-P_grid)bump * beta_last||^2",
            bump_increment_energy=float(increment @ increment), bump_sigma_px=diameter)
    precision = snapshot.inv_sigma.reshape(snapshot.shape)
    valid = (precision > 0) & snapshot.fov.reshape(snapshot.shape).astype(bool)
    physical = np.divide(b, snapshot.inv_sigma[:, None], out=np.zeros_like(b),
                         where=snapshot.inv_sigma[:, None] > 0).reshape(*snapshot.shape, b.shape[1])
    sigma = np.divide(1.0, precision, out=np.zeros_like(precision), where=precision > 0)
    edge_y = valid[1:] & valid[:-1]
    edge_x = valid[:, 1:] & valid[:, :-1]
    wy = np.sqrt(2 / (sigma[1:][edge_y]**2 + sigma[:-1][edge_y]**2))
    wx = np.sqrt(2 / (sigma[:, 1:][edge_x]**2 + sigma[:, :-1][edge_x]**2))
    dy = np.diff(physical, axis=0)[edge_y] * wy[:, None]
    dx = np.diff(physical, axis=1)[edge_x] * wx[:, None]
    roughness = diameter**2 * (dy.T @ dy + dx.T @ dx)
    for strength in (0.01, 0.1):
        add("shape_gradient_" + str(strength).replace(".", "p"), b, strength * roughness,
            family="shape_gradient", strength=strength,
            formula="lambda * diameter^2 * sum_edges [sqrt(2/(sigma_i^2+sigma_j^2)) * D(B beta / inv_sigma)]^2",
            coordinates="signed physical background; one-pixel forward differences; valid FOV edges only",
            units="whitened squared intensity; dimensionless lambda and diameter measured in pixels",
            bump_sigma_px=diameter)
    return variants


class BackgroundNNLS:
    """Reusable exact augmented least-squares projection + small NNLS.

    solve_many avoids per-observation pixel residuals. Raw residual is computed
    from sufficient-statistic quadratics. Float64 cancellation may affect the
    last few ulps; use solve(..., direct_residual=True) when checking a tiny RSS.
    """
    def __init__(self, a, spec):
        self.a = np.asarray(a, dtype=float)
        self.spec = spec
        self.b = np.asarray(spec.b, dtype=float)
        self.penalty_L = np.asarray(spec.penalty_L, dtype=float)
        self.penalty_gram = self.penalty_L.T @ self.penalty_L
        if self.a.shape[0] != self.b.shape[0]:
            raise ValueError("A and B row counts differ")
        ba = np.vstack((self.b, self.penalty_L))
        aa = np.vstack((self.a, np.zeros((self.penalty_L.shape[0], self.a.shape[1]))))
        u, s, vt = np.linalg.svd(ba, full_matrices=False)
        valid = s > (max(ba.shape) * np.finfo(float).eps * s[0]) if len(s) else np.zeros(0, bool)
        self.u = u[:, valid]
        self.beta_operator = (vt[valid].T / s[valid]) @ self.u.T
        self.ap = aa - self.u @ (self.u.T @ aa)
        self.q = self.ap.T @ self.ap
        cu, cs, cv = np.linalg.svd(self.ap, full_matrices=False)
        # Keep the full thin SVD: nnls handles dependent columns, avoiding any
        # extra threshold that could change the declared model across cases.
        self.cell_operator = cu[:self.a.shape[0]].T
        self.reduced_a = cs[:, None] * cv
        self.beta_y_operator = self.beta_operator[:, :self.a.shape[0]]
        self.beta_c_operator = self.beta_operator @ aa
        self.gaa = self.a.T @ self.a
        self.gba = self.b.T @ self.a
        self.gbb = self.b.T @ self.b

    def solve_many(self, y):
        y = np.asarray(y, dtype=float)
        if y.ndim != 2 or y.shape[1] != self.a.shape[0]:
            raise ValueError("Y must have shape [observations, pixels]")
        score = y @ self.cell_operator.T
        beta0 = y @ self.beta_y_operator.T
        ya = y @ self.a
        yb = y @ self.b
        yy = np.einsum("ij,ij->i", y, y)
        rows = []
        for i in range(len(y)):
            c = nnls(self.reduced_a, score[i], maxiter=max(1000, 100*self.a.shape[1]))[0] if self.a.shape[1] else np.empty(0)
            beta = beta0[i] - self.beta_c_operator @ c
            raw = float(yy[i] - 2*(ya[i] @ c + yb[i] @ beta)
                        + c @ self.gaa @ c + 2*beta @ self.gba @ c + beta @ self.gbb @ beta)
            penalty = float(np.sum((self.penalty_L @ beta)**2))
            grad = self.reduced_a.T @ (self.reduced_a @ c - score[i])
            scale = np.maximum(np.sqrt(np.diag(self.q)), 1e-15)
            kkt = np.max(np.where(c > 1e-10, np.abs(grad), np.maximum(-grad, 0))/scale, initial=0.0)
            rows.append(dict(c=c, beta=beta, raw_residual=raw, penalty=penalty,
                             objective=raw+penalty, kkt=float(kkt)))
        return rows

    def solve(self, y, direct_residual=False):
        result = self.solve_many(np.asarray(y)[None, :])[0]
        if direct_residual:
            r = y - self.a @ result["c"] - self.b @ result["beta"]
            result["raw_residual"] = float(r @ r)
            result["objective"] = result["raw_residual"] + result["penalty"]
        return result


def compare_snapshot(folder, diameter=18.0, variant_names=None):
    snap = load_snapshot(folder)
    variants = make_variants(snap, diameter)
    keep = np.arange(snap.a.shape[1]) != snap.target_index
    rows = []
    for name, spec in variants.items():
        if variant_names is not None and name not in variant_names:
            continue
        full = BackgroundNNLS(snap.a, spec)
        red = BackgroundNNLS(snap.a[:, keep], spec)
        for i, (ff, rr) in enumerate(zip(full.solve_many(snap.y), red.solve_many(snap.y))):
            rows.append(dict(snapshot=snap.folder.name, variant=name, probe_index=i,
                             probe_original_frame=int(snap.probes[i]["probe_original_frame"]),
                             target_id=int(snap.ids[snap.target_index]),
                             target_c=float(ff["c"][snap.target_index]),
                             raw_full=ff["raw_residual"], raw_red=rr["raw_residual"],
                             penalty_full=ff["penalty"], penalty_red=rr["penalty"],
                             objective_full=ff["objective"], objective_red=rr["objective"],
                             raw_gain=rr["raw_residual"]-ff["raw_residual"],
                             objective_gain=rr["objective"]-ff["objective"],
                             profile_curvature_fraction=float(full.q[snap.target_index, snap.target_index] /
                                                              (snap.a[:, snap.target_index] @ snap.a[:, snap.target_index])),
                             full_kkt=ff["kkt"], red_kkt=rr["kkt"],
                             native_threshold_reference_only=float(snap.meta["pass_at"])))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--diameter", type=float, default=18.0)
    parser.add_argument("--variant", action="append")
    args = parser.parse_args()
    folders = ([args.capture] if (args.capture / "y.f32").exists() else
               sorted(p.parent for p in args.capture.rglob("meta.tsv") if p.parent.name.startswith("keep_")))
    rows = [row for folder in folders for row in compare_snapshot(folder, args.diameter, args.variant)]
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "frozen.json").write_text(json.dumps(rows, indent=2, allow_nan=False))
    if rows:
        with (args.out / "frozen.tsv").open("w") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]), delimiter="\t")
            writer.writeheader()
            writer.writerows(rows)
    print(json.dumps({"snapshots": len(folders), "comparisons": len(rows), "output": str(args.out)}))


if __name__ == "__main__":
    main()
