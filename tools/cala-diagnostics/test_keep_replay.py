"""Synthetic replay check; SciPy remains optional for other diagnostics."""
import importlib.util
import unittest


@unittest.skipUnless(importlib.util.find_spec('scipy'), 'optional SciPy is not installed')
class KeepReplayTests(unittest.TestCase):
    def test_nonnegative_cells_with_signed_free_background(self):
        import numpy as np
        from replay_keep import FreeBackgroundNNLS

        rng = np.random.default_rng(730)
        cells = rng.normal(size=(100, 4))
        background = rng.normal(size=(100, 3))
        expected_cells = np.array([3.0, 0.0, 1.0, 2.0])
        expected_background = np.array([-2.0, 1.0, -4.0])
        y = cells @ expected_cells + background @ expected_background

        fit = FreeBackgroundNNLS(cells, background).solve(y)

        np.testing.assert_allclose(fit['c'], expected_cells, atol=1e-10)
        np.testing.assert_allclose(fit['beta'], expected_background, atol=1e-10)
        self.assertLess(fit['chi2'], 1e-20)
        self.assertLess(fit['kkt'], 1e-10)


if __name__ == '__main__':
    unittest.main()
