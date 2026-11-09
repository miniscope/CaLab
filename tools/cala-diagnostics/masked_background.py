"""Declared offline experiment: dilation radii 0 and 3; signed native B.

Outside valid FOV target mask, fit known neighbors (nonnegative) and B (signed).
Freeze B prediction; inside mask refit nonnegative cells, full/reduced, sharing B.
Mask RSS gain is descriptive: no universal null law or native pass threshold.
No tuning by true/negative controls. Native B is already in whitened coordinates.
"""
import numpy as np
from scipy.ndimage import binary_dilation
from scipy.optimize import nnls

from background_models import BackgroundNNLS, BackgroundSpec

DECLARED_RADII = (0, 3)


def _svd_info(x):
    u, s, vt = np.linalg.svd(x, full_matrices=False)
    tol = max(x.shape, default=0) * np.finfo(float).eps * (s[0] if len(s) else 0)
    good = s > tol
    rank = int(good.sum())
    return u[:, good], dict(rank=rank, columns=x.shape[1],
        singular_values=s.tolist(), tolerance=float(tol),
        condition=float(s[0]/s[-1]) if len(s) and rank == x.shape[1] else None)


class MaskedBackgroundKeep:
    """Prepare one fixed arm. Arrays use [pixels, columns], y uses [pixels].

    Dilation is a Euclidean integer-pixel disk. Support means exact nonzero A.
    Excludes FOV=0, nonfinite or nonpositive inv_sigma from both fit and score.
    Rank guard rejects unidentifiable background after removing neighbor span.
    """
    def __init__(self, a, b, target_index, shape, fov, inv_sigma, radius=0, local_noise=False):
        if radius not in DECLARED_RADII:
            raise ValueError('Only predeclared radii 0 and 3 are supported')
        self.a, self.b = np.asarray(a, float), np.asarray(b, float)
        self.target_index = int(target_index)
        self.local_noise = local_noise
        n = int(np.prod(shape))
        if self.a.shape[0] != n or self.b.shape[0] != n:
            raise ValueError('Shape does not match matrices')
        if not np.all(np.isfinite(self.a)) or not np.all(np.isfinite(self.b)):
            raise ValueError('Nonfinite design')
        valid = np.asarray(fov).reshape(-1).astype(bool) & np.isfinite(inv_sigma) & (np.asarray(inv_sigma)>0)
        support = (self.a[:, target_index] != 0).reshape(shape)
        if radius:
            yy, xx = np.mgrid[-radius:radius+1, -radius:radius+1]
            support = binary_dilation(support, structure=xx*xx+yy*yy <= radius*radius)
        self.mask = valid & support.ravel()
        self.outside = valid & ~support.ravel()
        self.keep = np.arange(self.a.shape[1]) != target_index
        if not self.mask.any() or not self.outside.any():
            raise ValueError('Empty valid scoring mask or outside region')
        neighbors = self.a[self.outside][:, self.keep]
        bo = self.b[self.outside]
        un, neighbor_info = _svd_info(neighbors)
        bp = bo - un @ (un.T @ bo)
        _, background_info = _svd_info(bp)
        # Residualization cancellation must be measured against native B scale.
        rank_tol = max(bo.shape) * np.finfo(float).eps * np.linalg.norm(bo, 2)
        background_info['rank'] = int(np.sum(np.asarray(background_info['singular_values']) > rank_tol))
        background_info['tolerance'] = float(rank_tol)
        if background_info['rank'] != bo.shape[1]:
            background_info['condition'] = None
        _, joint_info = _svd_info(np.column_stack((bo, neighbors)))
        if background_info['rank'] != bo.shape[1]:
            raise ValueError('Outside background is unidentifiable after accounting for neighbors')
        self.outside_nonzero = np.any(neighbors != 0, axis=0)
        self.outside_neighbors = neighbors[:, self.outside_nonzero]
        self.outside_solver = BackgroundNNLS(self.outside_neighbors, BackgroundSpec(
            'masked_native', bo, np.zeros((0, bo.shape[1]))))
        # Linear unconstrained-neighbor bound/reference; active-set derivative
        # is reported per observation. Both assume iid unit whitened noise.
        self._noise_cache = {}
        conservative_noise = _prediction_noise(self.b[self.mask], bp)
        self.diagnostics = dict(radius=radius, mask_pixels=int(self.mask.sum()),
            outside_pixels=int(self.outside.sum()), invalid_pixels=int((~valid).sum()),
            target_outside_energy=float(np.sum(self.a[self.outside,target_index]**2)),
            neighbor_design=neighbor_info, residualized_background=background_info,
            joint_outside_design=joint_info,
            dropped_zero_outside_neighbors=int((~self.outside_nonzero).sum()),
            all_neighbor_prediction_noise=conservative_noise,
            score='mask RSS reduced minus full; B frozen, mask cell coefficients refit',
            null_law='none asserted; empirical independent controls required')

    def solve(self, y):
        y = np.asarray(y, float)
        if y.shape != (self.a.shape[0],) or not np.all(np.isfinite(y[self.mask | self.outside])):
            raise ValueError('Invalid observation')
        outside_fit = self.outside_solver.solve(y[self.outside], direct_residual=True)
        return self._solve_inside(y, outside_fit)

    def _solve_inside(self, y, outside_fit):
        beta = outside_fit['beta']
        frozen = self.b[self.mask] @ beta
        z = y[self.mask] - frozen
        am = self.a[self.mask]
        cf = _nnls(am, z)
        cr = _nnls(am[:, self.keep], z)
        rf, rr = z-am@cf, z-am[:, self.keep]@cr
        active = outside_fit['c'] > 1e-10
        key = tuple(active.tolist())
        if self.local_noise and key not in self._noise_cache:
            na = self.outside_neighbors[:, active]
            ua, _ = _svd_info(na)
            bo = self.b[self.outside]
            bp = bo - ua @ (ua.T @ bo)
            self._noise_cache[key] = _prediction_noise(self.b[self.mask], bp)
        return dict(c=cf, reduced_c=cr, beta=beta,
            frozen_background_full=frozen, frozen_background_reduced=frozen.copy(),
            outside_neighbor_c=outside_fit['c'], outside_rss=outside_fit['raw_residual'],
            outside_kkt=outside_fit['kkt'], raw_full=float(rf@rf), raw_red=float(rr@rr),
            raw_gain=float(rr@rr-rf@rf), target_c=float(cf[self.target_index]),
            active_neighbor_count=int(active.sum()),
            local_active_set_prediction_noise=self._noise_cache.get(key))

    def solve_many(self, y):
        y = np.asarray(y, float)
        if y.ndim != 2 or y.shape[1] != self.a.shape[0] or not np.all(np.isfinite(y[:, self.mask | self.outside])):
            raise ValueError('Invalid observations')
        fits = self.outside_solver.solve_many(y[:, self.outside])
        return [self._solve_inside(row, fit) for row, fit in zip(y, fits)]


def _nnls(a, y):
    return nnls(a, y, maxiter=max(1000, 100*a.shape[1]))[0] if a.shape[1] else np.empty(0)


def _prediction_noise(bmask, bp):
    # Covariance via small B-dimensional factor, never mask-by-outside matrix.
    _, s, vt = np.linalg.svd(bp, full_matrices=False)
    factor = bmask @ (vt.T / s)
    singular = np.linalg.svd(factor, compute_uv=False)
    variance = np.sum(factor**2, axis=1)
    return dict(mean_pixel_variance=float(np.mean(variance)),
                max_pixel_variance=float(np.max(variance)),
                spectral_amplification=float(singular[0]) if len(singular) else 0.)


def from_snapshot(snapshot, radius=0):
    return MaskedBackgroundKeep(snapshot.a, snapshot.b, snapshot.target_index,
        snapshot.shape, snapshot.fov, snapshot.inv_sigma, radius)
