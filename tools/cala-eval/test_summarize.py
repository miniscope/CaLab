"""Tests for summarize.py: `python -m unittest discover tools/cala-eval` (or pytest)."""

import math
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import summarize as S  # noqa: E402


def write_run(d: Path, precision, cells_rows, adds=(), removals=()):
    """precision: {frame: (P, R, true_r)}; cells_rows: [(fp_class, edge_px, fp_r)] at the last frame."""
    d.mkdir(parents=True)
    g = ["frames\tgt_precision\tgt_recall\tgt_median_true_r"]
    for f, (p, r, tr) in sorted(precision.items()):
        g.append(f"{f - 50}\t{p}\t{r}\t{tr}")  # global.tsv counts from the slow start (50)
    g.append("100\tnan\tnan\tnan")  # non-checkpoint rows are ignored
    (d / "global.tsv").write_text("\n".join(g) + "\n")
    final = max(precision)
    c = ["frame\tfp_class\tedge_px\tfp_r"] + [f"{final}\t{k}\t{e}\t{r}" for k, e, r in cells_rows]
    c.append(f"{final - 300}\tnoise\t1\t0.1")  # earlier checkpoint: ignored
    (d / "cells.tsv").write_text("\n".join(c) + "\n")
    a = ["recording_frame\tclass"] + [f"{f}\t{k}" for f, k in adds]
    (d / "adds.tsv").write_text("\n".join(a) + "\n")
    r = ["recording_frame\tkind"] + [f"{f}\t{k}" for f, k in removals]
    (d / "removals.tsv").write_text("\n".join(r) + "\n")


class PairedStats(unittest.TestCase):
    def test_t_ci_formula(self):
        st = S.paired([0.0] * 5, [0.01, 0.02, 0.03, 0.02, 0.02])
        d = [0.01, 0.02, 0.03, 0.02, 0.02]
        sd = math.sqrt(sum((x - 0.02) ** 2 for x in d) / 4)
        self.assertAlmostEqual(st["mean"], 0.02)
        self.assertAlmostEqual(st["half"], 2.776 * sd / math.sqrt(5), places=9)
        self.assertEqual((st["pos"], st["neg"], st["zero"]), (5, 0, 0))
        self.assertTrue(S.excludes_zero(st))

    def test_noise_covers_zero(self):
        st = S.paired([0.9, 0.9, 0.9, 0.9, 0.9], [0.91, 0.89, 0.92, 0.88, 0.9])
        self.assertFalse(S.excludes_zero(st))
        self.assertEqual((st["pos"], st["neg"], st["zero"]), (2, 2, 1))

    def test_identical_runs_have_zero_width(self):
        st = S.paired([0.5, 0.6, 0.7], [0.5, 0.6, 0.7])
        self.assertEqual((st["mean"], st["half"]), (0.0, 0.0))
        self.assertFalse(S.excludes_zero(st))

    def test_single_seed_has_no_ci(self):
        st = S.paired([0.5], [0.6])
        self.assertTrue(math.isnan(st["half"]))
        self.assertFalse(S.excludes_zero(st))


class RunMetrics(unittest.TestCase):
    def test_metrics_from_synthetic_run(self):
        with tempfile.TemporaryDirectory() as t:
            run = Path(t) / "motion_s5"
            # P rises .90 .91 ... over 12 checkpoints 1200..9600 step 300 plus 2400
            prec = {f: (0.9 + 0.001 * (f - 1200) / 300, 0.5, 0.8) for f in range(1200, 9601, 300)}
            cells = (
                [("tp", 50, 0.9)] * 6
                + [("nondetectable", 50, 0.8)] * 2
                + [("noise", 5, 0.1), ("adjacent", 20, 0.3), ("partial", 8, 0.6), ("dup", 50, 0.7)]
            )
            adds = [(9000, "new"), (9100, "readd"), (9200, "new"), (100, "new")]
            rem = [(9300, "delete"), (9400, "merge"), (50, "delete")]
            write_run(run, prec, cells, adds, rem)
            m = S.run_metrics(run)
            self.assertAlmostEqual(m["P8"], prec[9600][0])
            self.assertAlmostEqual(m["P2"], prec[2400][0])
            # AUC over the 29 checkpoints from 1200
            xs = [prec[f][0] for f in range(1200, 9601, 300)]
            self.assertAlmostEqual(m["AUC_P"], sum(xs) / len(xs))
            # slope over the last five checkpoints: .001 per 300 frames = .00333 per 1000
            self.assertAlmostEqual(m["slope_P"], 0.001 / 0.3, places=9)
            self.assertEqual(m["cells"], 12)
            self.assertEqual(
                (m["fp_noise"], m["fp_adjacent"], m["fp_partial"], m["fp_dup"], m["fp_nondet"]),
                (1, 1, 1, 1, 2),
            )
            self.assertEqual(m["fp_edge10"], 2)  # noise at 5 px, partial at 8 px; tp never counts
            self.assertAlmostEqual(m["P8x"], 6 / 10)  # non-detectable matches left out
            self.assertAlmostEqual(m["r_fp"], 0.9)
            self.assertAlmostEqual(m["r_tr"], 0.8)
            # last 4 min = 4 min window: 3 adds (one re-add), 2 removals (one delete)
            self.assertAlmostEqual(m["adds_pm"], 3 / 4)
            self.assertAlmostEqual(m["readds_pm"], 1 / 4)
            self.assertAlmostEqual(m["deletes_pm"], 1 / 4)

    def test_report_claims_only_on_named_arms(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            for tree, shift in (("base", 0.0), ("new", 0.02)):
                for arm in ("static", "motion"):
                    for s in range(5, 10):
                        jitter = 0.002 * (s - 7)
                        prec = {f: (0.9 + shift + jitter, 0.5, 0.8) for f in range(1200, 9601, 300)}
                        write_run(root / tree / f"{arm}_s{s}", prec, [("tp", 50, 0.9)])
            base, new = S.collect(root / "base", None), S.collect(root / "new", None)
            md = S.report(base, new, ["static", "motion"], "P8", ["motion"])
            self.assertIn("effect claimed", md)
            self.assertIn("| motion | **P8** |", md)
            self.assertEqual(md.count("EXCLUDES 0"), 1)  # static is not a claim arm


class HeldOutMetrics(unittest.TestCase):
    def test_rank_statistics(self):
        self.assertAlmostEqual(S.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1.0)
        self.assertAlmostEqual(S.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1.0)
        self.assertAlmostEqual(S.auc([3, 4], [1, 2]), 1.0)
        self.assertAlmostEqual(S.auc([1, 2], [3, 4]), 0.0)
        self.assertAlmostEqual(S.auc([1, 3], [1, 2]), 0.625)  # ties count 1/2

    def test_metrics_from_synthetic_run(self):
        with tempfile.TemporaryDirectory() as t:
            run = Path(t) / "static_s5"
            frames = list(range(1200, 9601, 300))
            run.mkdir(parents=True)
            g = ["frames\tcells\tgt_precision\tgt_recall\tgt_median_true_r\tho_score"]
            for i, f in enumerate(frames):
                # TP = P x cells rises; S rises with it except one swap.
                s_ = i if i != 3 else 1.5
                g.append(f"{f - 50}\t{100 + 10 * i}\t0.9\t0.5\t0.8\t{s_}")
            (run / "global.tsv").write_text("\n".join(g) + "\n")
            c = ["frame\tslot\tfp_class\tedge_px\tfp_r"]
            h = ["frame\tslot\tid\tho_marginal\tho_frames\tho_marginal_z"]
            for slot, (cls, z) in enumerate([("tp", 5), ("tp", 3), ("noise", 4), ("dup", 0), ("tp", "nan")]):
                c.append(f"9600\t{slot}\t{cls}\t40\t0.9")
                h.append(f"9600\t{slot}\t{slot}\t1\t3\t{z}")
            (run / "cells.tsv").write_text("\n".join(c) + "\n")
            (run / "ho_cells.tsv").write_text("\n".join(h) + "\n")
            m = S.run_metrics(run)
            self.assertAlmostEqual(m["S8"], len(frames) - 1)
            self.assertAlmostEqual(m["AUC_S"], (sum(range(len(frames))) - 3 + 1.5) / len(frames))
            self.assertLess(m["rho_S_TP"], 1.0)
            self.assertGreater(m["rho_S_TP"], 0.99)
            # TP z = 5, 3, unscored (lowest); non-TP z = 4, 0: 3 of 6 pairs won.
            self.assertAlmostEqual(m["auc_hoz"], 3 / 6)


if __name__ == "__main__":
    unittest.main()
