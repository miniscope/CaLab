"""Tests for demix_metrics.py and demix_report.py: `python -m unittest discover tools/cala-eval`.

Needs numpy and scipy; skipped without them.
"""

import json
import math
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import numpy as np
    import scipy  # noqa: F401

    import demix_metrics as DM
    import demix_report as REP
except ImportError:  # pragma: no cover
    np = None


def gauss(h, w, cy, cx, s):
    yy, xx = np.mgrid[0:h, 0:w]
    return np.exp(-((yy - cy) ** 2 + (xx - cx) ** 2) / (2 * s * s)).astype(np.float32)


def write_oracle(path, h, w, centres, traces, det=True, s=4.0):
    b = b"CALAORC1" + struct.pack("<4I", h, w, len(centres), traces.shape[1])
    for cy, cx in centres:
        g = gauss(h, w, cy, cx, s)
        patch = struct.pack("<4I", 0, 0, h, w) + g.tobytes()
        b += struct.pack("<I", 0) + bytes([1 if det else 0, 0, 0, 0]) + struct.pack("<2f", cy, cx) + patch + patch
    path.write_bytes(b + traces.astype("<f4").tobytes())


def write_footprints(path, h, w, imgs):
    b = b"CALAFP01" + struct.pack("<3I", h, w, len(imgs))
    for k, img in enumerate(imgs):
        idx = np.flatnonzero(img.ravel() > 0).astype("<u4")
        val = img.ravel()[idx].astype("<f4")
        b += struct.pack("<2I", k, len(idx)) + idx.tobytes() + val.tobytes() + val.tobytes()
    path.write_bytes(b)


@unittest.skipIf(np is None, "numpy/scipy not installed")
class Stats(unittest.TestCase):
    def test_statistics(self):
        x = np.array([0.0, 0.2, 0.6, 0.9])
        self.assertAlmostEqual(float(REP.share_below(x)), 0.5)
        self.assertAlmostEqual(float(REP.med(x)), 0.4)
        self.assertAlmostEqual(float(REP.excess(np.array([0.3, 0.5, 0.7]), np.array([0.1, 0.1, 0.3]))), 0.4)
        # vectorised over resamples
        self.assertEqual(REP.share_below(np.zeros((4, 7))).shape, (4,))

    def test_bootstrap_ci_covers_and_is_deterministic(self):
        rng = np.random.default_rng(1)
        x = rng.normal(0.5, 0.1, 400)
        d1 = REP.boot(REP.med, [x], np.random.default_rng(3), 400)
        d2 = REP.boot(REP.med, [x], np.random.default_rng(3), 400)
        self.assertTrue(np.array_equal(d1, d2))
        self.assertLess(REP.pct(d1, 2.5), 0.5)
        self.assertGreater(REP.pct(d1, 97.5), 0.5)
        self.assertTrue(math.isnan(REP.point(REP.med, [x[:3]])))  # too few pairs
        self.assertTrue(np.isnan(REP.boot(REP.med, [x[:3]], rng, 10)).all())

    def test_median_of_half_zero_ratios_is_unstable_but_share_is_not(self):
        # the failure that motivated the suite: half the pairs sit at exactly 0
        rng = np.random.default_rng(0)
        meds, shares = [], []
        for _ in range(200):
            r = np.where(rng.random(60) < 0.5, 0.0, rng.uniform(0.6, 1.0, 60))
            meds.append(float(REP.med(r)))
            shares.append(float(REP.share_below(r)))
        self.assertGreater(np.std(meds), 3 * np.std(shares))

    def test_t_ci(self):
        m, lo, hi = REP.t_ci([1.0, 1.2, 0.8, 1.1])
        self.assertAlmostEqual(m, 1.025)
        self.assertGreater(lo, 0)
        self.assertTrue(math.isnan(REP.t_ci([1.0, 2.0])[1]))  # below 3 sims

    def test_classify(self):
        self.assertEqual(REP.classify(-0.2, -0.1, [-0.1, -0.2, -0.1, 0.0, -0.3], "lower")[0], "better")
        self.assertEqual(REP.classify(0.1, 0.2, [0.1, 0.2, 0.1], "lower")[0], "worse")
        self.assertEqual(REP.classify(0.1, 0.2, [0.1, 0.2, 0.1], "higher")[0], "better")
        self.assertEqual(REP.classify(-0.1, 0.2, [0.1, 0.2, -0.1], "lower")[0], "within noise")
        self.assertEqual(REP.classify(0.1, 0.2, [0.1, -0.2, -0.1], "lower")[0], "within noise (seeds disagree)")
        self.assertEqual(REP.classify(0.1, 0.2, [0.1, 0.2, 0.1], None)[0], "changed")
        self.assertEqual(REP.classify(math.nan, math.nan, [0.1], "lower")[0], "n/a")
        self.assertEqual(REP.classify(0.1, 0.2, [0.1, 0.2, 0.1, 0.1], "lower")[1], "4/4")

    def fake_run(self, name, ratios, d, cc, cd, **det):
        n = len(ratios)
        return {
            "name": name, "d": np.asarray(d, float), "ratio": np.asarray(ratios, float), "ring": np.full(n, 0.95),
            "leak": np.full(n, 0.05), "cd": np.asarray(cd, float), "cc": np.asarray(cc, float),
            "det": {"matched": 500, "false": 20, "net": 480, "merges": 20, "splits": 5, "area_support": 580, "area_halfmax": 150, "ms_per_frame": 0.35, **det},
        }  # fmt: skip

    def arm(self, share_bad, excess, rng, matched=500, seeds=4):
        runs = []
        for s in range(seeds):
            n = 120
            ratio = np.where(rng.random(n) < share_bad, 0.0, rng.uniform(0.6, 1.0, n))
            cd = np.r_[rng.uniform(0, 1, 100), rng.uniform(1.5, 3, 100)]
            cc = np.r_[rng.normal(excess, 0.1, 100), rng.normal(0.0, 0.1, 100)]
            runs.append(self.fake_run(f"static_s{s}", ratio, rng.uniform(0.75, 1.0, n), cc, cd, matched=matched + rng.integers(-2, 3)))
        return runs

    def test_compare_flags_known_direction_and_noise(self):
        rng = np.random.default_rng(7)
        base = self.arm(0.6, 0.20, rng)
        new = self.arm(0.3, 0.10, rng, matched=505)
        names, rows = REP.compare(base, new)
        by = {r["name"]: r for r in rows}
        head = by["Trace corr excess < 1 D (15 s high-pass; vs 1.5-3 D) HEADLINE"]
        self.assertEqual(head["flag"], "better")
        self.assertLess(head["diff"], -0.05)
        self.assertEqual(by["Bite share ratio < 0.5, 0.75-1.0 D"]["flag"], "better")
        self.assertEqual(by["Control ring ratio median, < 1 D"]["flag"], "within noise")
        self.assertEqual(by["Matched cells"]["flag"], "better")
        # same-distribution arms: nothing is flagged
        _, rows0 = REP.compare(self.arm(0.4, 0.15, rng), self.arm(0.4, 0.15, rng))
        self.assertFalse([r["name"] for r in rows0 if r["flag"] in ("better", "worse") and r["group"] != "run"])

    def test_render_has_headline_and_flags(self):
        rng = np.random.default_rng(2)
        names, rows = REP.compare(self.arm(0.6, 0.2, rng), self.arm(0.3, 0.1, rng))
        md = REP.render(names, rows, "z3", "z0", "T", {"tier": "quick"})
        self.assertIn("**Headline**", md)
        self.assertIn("| metric |", md)
        self.assertIn("**better**", md)
        self.assertIn("## Per sim", md)


@unittest.skipIf(np is None, "numpy/scipy not installed")
class Metrics(unittest.TestCase):
    def test_leak_sd_recovers_mixing(self):
        rng = np.random.default_rng(0)
        Ci, Cj = rng.exponential(1, 3000), rng.exponential(1, 3000)
        est = 1.0 * Ci + 0.3 * Cj + 0.01 * rng.normal(size=3000)
        self.assertAlmostEqual(DM.leak_sd(est, Ci, Cj), 0.3 * Cj.std() / Ci.std(), places=2)
        self.assertLess(abs(DM.leak_sd(Ci + 0.01 * rng.normal(size=3000), Ci, Cj)), 0.01)

    def test_corr_pairs_excess_of_near_pairs(self):
        rng = np.random.default_rng(1)
        T = 4000
        shared = rng.normal(size=T)
        gt = rng.normal(size=(3, T))
        est = gt.copy()
        est[0] += 0.7 * shared  # cells 0 and 1 (1 D apart) share a signal, cell 2 is far away
        est[1] += 0.7 * shared
        cen = np.array([[0.0, 0.0], [10.0, 0.0], [0.0, 30.0]])
        rows = DM.corr_pairs("s", est, gt, cen, 10.0, [4, 5, 6])
        self.assertEqual(len(rows), 1)  # only the pair closer than 3 D
        self.assertEqual((rows[0]["ui"], rows[0]["uj"]), (4, 5))
        self.assertGreater(rows[0]["c_est"], 0.2)
        self.assertLess(abs(rows[0]["c_true"]), 0.1)

    def test_pearson_matrix_matches_numpy_and_offset_is_found(self):
        h = w = 60
        gts = [gauss(h, w, 15, 15, 3), gauss(h, w, 40, 42, 3)]
        G = np.stack([g.ravel() for g in gts])
        est = [gauss(h, w, 15, 16.5, 3) * (gauss(h, w, 15, 16.5, 3) > 0.05), gauss(h, w, 40, 43.5, 3) * (gauss(h, w, 40, 43.5, 3) > 0.05)]
        cells = [(np.flatnonzero(e.ravel()), e.ravel()[e.ravel() > 0].astype(float)) for e in est]
        R = DM.pearson_matrix(cells, G, h, w)
        self.assertAlmostEqual(R[0, 0], np.corrcoef(est[0].ravel(), gts[0].ravel())[0, 1], places=5)
        self.assertEqual(DM.match(R, [0, 1], 0.5), {0: 0, 1: 1})
        units = [{"full": (0, 0, g)} for g in gts]
        dy, dx = DM.estimate_offset(cells * 6, units * 6, {i: i % 2 for i in range(12)}, w)
        self.assertAlmostEqual(dy, 0.0, delta=0.15)
        self.assertAlmostEqual(dx, 1.5, delta=0.15)

    def make_run(self, tmp, bite):
        """Two GT cells 6 px apart on an 80 px frame; the estimate of cell 0 optionally has cell 1's core cut out."""
        h = w = 80
        T = 2000
        rng = np.random.default_rng(3)
        C = rng.exponential(1, (2, T)).astype(np.float32)
        sim, run = Path(tmp) / "sim", Path(tmp) / "run"
        sim.mkdir()
        run.mkdir()
        write_oracle(sim / "oracle.bin", h, w, [(40, 34), (40, 40)], C)
        e0, e1 = gauss(h, w, 40, 34, 4), gauss(h, w, 40, 40, 4)
        if bite:
            e0 = e0 * (np.hypot(*np.mgrid[0:h, 0:w] - np.array([40, 40])[:, None, None]) > 3.5)
        write_footprints(run / "footprints.bin", h, w, [e0, e1])
        (run / "dump_trace.f32").write_bytes(C.T.astype("<f4").tobytes())  # perfect traces, frames x cells
        (run / "final.tsv").write_text("slot\tmatched\tbest_gt\n0\t1\t0\n1\t1\t1\n")
        (run / "gt.tsv").write_text("gt\tcy\tcx\tdetectable\n0\t40\t34\t1\n1\t40\t40\t1\n2\t10\t10\t1\n")
        (run / "passes.tsv").write_text("pass\tmerges\tsplits\n1\t0\t0\n2\t3\t1\n")
        (run / "stdout.log").write_text("QC cost per frame: mean 0.250 ms, p50 0.1\n")
        return sim, run

    def test_compute_run_end_to_end(self):
        for bite, expect in ((False, 1.0), (True, 0.0)):
            with tempfile.TemporaryDirectory() as tmp:
                sim, run = self.make_run(tmp, bite)
                det = DM.compute_run(sim, run)
                self.assertEqual((det["cells"], det["matched"], det["false"], det["net"]), (2, 2, 0, 2))
                self.assertEqual((det["merges"], det["splits"]), (3, 1))
                self.assertAlmostEqual(det["ms_per_frame"], 0.25)
                self.assertEqual(det["pair_res"]["0.5-0.75"], [1, 0, 0])  # the two close GT cells, both matched
                self.assertEqual(det["pair_res"]["0.75-1.0"], [0, 0, 0])
                self.assertEqual(det["both_0.5-0.75"], 1)
                # the two GT footprints overlap strongly, so each estimate also correlates >= 0.5 with the neighbour
                self.assertEqual(det["multi_gt"], 1 if bite else 2)  # the bitten estimate no longer resembles the neighbour
                r = REP.load_run(run)
                self.assertEqual(len(r["ratio"]), 2)  # both ordered pairs
                self.assertAlmostEqual(float(r["ratio"][0]), expect, delta=0.05)  # cell 0 at cell 1's centre
                self.assertAlmostEqual(float(r["ratio"][1]), 1.0, delta=0.05)  # cell 1 unbitten
                self.assertLess(float(np.nanmax(r["leak"])), 0.05)  # perfect traces: no leak
                self.assertEqual(len(r["cc"]), 1)
                self.assertTrue(json.loads((run / "demix_det.json").read_text())["traces"])
                self.assertEqual(DM.compute_run(sim, run)["n_pairs"], det["n_pairs"])  # cached


if __name__ == "__main__":
    unittest.main()
