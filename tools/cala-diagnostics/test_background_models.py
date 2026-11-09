"""Numerical and independent-control regressions; no recordings required."""
import importlib.util
from pathlib import Path
import unittest

HAS_SCIPY = bool(importlib.util.find_spec('scipy'))
HAS_MATPLOTLIB = bool(importlib.util.find_spec('matplotlib'))


@unittest.skipUnless(HAS_SCIPY, 'optional SciPy is not installed')
class BackgroundModelTests(unittest.TestCase):
    def test_augmented_objective_matches_independent_bounded_fit(self):
        import numpy as np
        from scipy.optimize import lsq_linear
        from background_models import BackgroundNNLS, BackgroundSpec
        rng = np.random.default_rng(271)
        a, b = rng.normal(size=(100, 4)), rng.normal(size=(100, 3))
        penalty = np.diag([0.0, 0.2, 2.0])
        y = a @ np.array([2.0, 0.0, 0.5, 1.0]) + b @ np.array([-2.0, 3.0, -1.0]) + rng.normal(size=100)
        spec = BackgroundSpec('test', b, penalty)
        fit = BackgroundNNLS(a, spec).solve(y, direct_residual=True)
        design = np.block([[a, b], [np.zeros((3, 4)), penalty]])
        rhs = np.r_[y, np.zeros(3)]
        independent = lsq_linear(design, rhs, bounds=(np.r_[np.zeros(4), np.full(3, -np.inf)], np.full(7, np.inf)), method='bvls', tol=1e-12)
        self.assertTrue(independent.success)
        self.assertAlmostEqual(fit['objective'], float(np.sum((design @ independent.x - rhs)**2)), places=8)
        self.assertAlmostEqual(fit['objective'], fit['raw_residual'] + fit['penalty'], places=10)
        reduced = BackgroundNNLS(a[:, 1:], spec).solve(y, direct_residual=True)
        self.assertGreaterEqual(reduced['objective'] - fit['objective'], -1e-8)

    def test_background_basis_units_do_not_change_penalized_fit(self):
        import numpy as np
        from background_models import BackgroundNNLS, BackgroundSpec
        rng = np.random.default_rng(932)
        a, b = rng.normal(size=(100, 3)), rng.normal(size=(100, 2))
        y, penalty = rng.normal(size=100), np.diag([0.3, 2.0])
        base = BackgroundNNLS(a, BackgroundSpec('base', b, penalty)).solve(y, direct_residual=True)
        scales = np.array([0.1, -7.0])
        rescaled = BackgroundNNLS(a, BackgroundSpec('rescaled', b * scales, penalty * scales)).solve(y, direct_residual=True)
        self.assertAlmostEqual(base['objective'], rescaled['objective'], places=8)
        np.testing.assert_allclose(base['c'], rescaled['c'], atol=1e-9)


@unittest.skipUnless(HAS_SCIPY and HAS_MATPLOTLIB, 'optional control dependencies are not installed')
class ControlSeedTests(unittest.TestCase):
    def test_reproducible_cases_have_disjoint_calibration_and_evaluation_seeds(self):
        import numpy as np
        from background_models import Snapshot
        from background_controls import make_cases
        y, x = np.mgrid[:32, :32]
        target = np.exp(-((y-16)**2+(x-16)**2)/18).ravel()
        neighbor = np.exp(-((y-10)**2+(x-11)**2)/18).ravel()
        maps = [np.exp(-((y-cy)**2+(x-cx)**2)/200).ravel() for cy in [5, 16, 27] for cx in [5, 16, 27]]
        maps.append(np.exp(-((y-16)**2+(x-16)**2)/648).ravel())
        s = Snapshot(Path('.'), np.zeros((1, 1024)), np.column_stack([target, neighbor]), np.column_stack(maps), np.array([1, 2]), 0, {}, [], (32, 32), np.ones(1024), np.ones(1024, dtype=np.uint8))
        first, cases = make_cases(s, 'A', target, 'calibration', 1, 1)
        again, repeated = make_cases(s, 'A', target, 'calibration', 1, 1)
        _, heldout = make_cases(s, 'A', target, 'evaluation', 1, 1)
        np.testing.assert_array_equal(first, again)
        self.assertEqual(cases, repeated)
        self.assertFalse({c['seed'] for c in cases} & {c['seed'] for c in heldout})
        self.assertFalse({c['case_id'] for c in cases} & {c['case_id'] for c in heldout})


if __name__ == '__main__':
    unittest.main()
