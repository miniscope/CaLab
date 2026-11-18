"""Tests for the look-back metrics (birth order, late-born, undetected neighbours, clusters, stages):
`python -m unittest discover tools/cala-eval`. Synthetic fixtures only; needs numpy and scipy.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import numpy as np
    import scipy  # noqa: F401

    import demix_clusters as CL
    import demix_metrics as DM
    import demix_report as REP
    import demix_stages as ST
    from test_demix import Metrics, Stats, gauss, write_footprints, write_oracle
except ImportError:  # pragma: no cover
    np = None


def adds(path, births):
    """A minimal adds.tsv: {cell id: recording frame}."""
    rows = ["frame\trecording_frame\tid\tclass\tcy\tcx\tcos\tdist\tsince"]
    rows += [f"{f}\t{f}\t{i}\tnew\t0\t0\tNaN\tNaN\t-1" for i, f in births.items()]
    Path(path).write_text("\n".join(rows) + "\n")


@unittest.skipIf(np is None, "numpy/scipy not installed")
class Births(unittest.TestCase):
    def test_library_roundtrip_keeps_ids_and_filtered_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            h = w = 20
            imgs = [gauss(h, w, 5, 5, 2), gauss(h, w, 14, 14, 2)]
            p = Path(tmp) / "footprints.bin"
            write_footprints(p, h, w, imgs)
            hh, ww, ids, cells, filt = DM.read_library(p)
            self.assertEqual((hh, ww, ids), (h, w, [0, 1]))
            self.assertTrue(np.array_equal(cells[0][0], filt[0][0]))
            self.assertTrue(np.allclose(cells[1][1], filt[1][1]))  # the fixture writes the same values twice
            self.assertEqual(len(DM.read_footprints(p)[2]), 2)  # old signature intact

    def test_read_births(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(DM.read_births(Path(tmp)), {})  # no ledger: no births, no crash
            adds(Path(tmp) / "adds.tsv", {7: 120, 9: 4000})
            self.assertEqual(DM.read_births(Path(tmp)), {7: 120, 9: 4000})

    def run_dir(self, tmp, births, bite=True):
        sim, run = Metrics().make_run(tmp, bite)
        adds(run / "adds.tsv", births)
        return sim, run

    def test_birth_order_split_isolates_the_later_born_bite(self):
        # cell 0's footprint has cell 1's core cut out (the bite). Cell 0 is born late: the later-born rows bite, the earlier-born rows do not.
        with tempfile.TemporaryDirectory() as tmp:
            sim, run = self.run_dir(tmp, {0: 1700, 1: 100})
            det = DM.compute_run(sim, run)
            self.assertEqual((det["frames"], det["births_known"]), (2000, 2))
            r = REP.load_run(run)
            later = REP._sel(r, 0.5, 0.75, "ratio", "later")
            earlier = REP._sel(r, 0.5, 0.75, "ratio", "earlier")
            self.assertEqual((len(later), len(earlier)), (1, 1))
            self.assertAlmostEqual(float(later[0]), 0.0, delta=0.05)
            self.assertAlmostEqual(float(earlier[0]), 1.0, delta=0.05)
            self.assertEqual(float(REP.share_below(later)), 1.0)
            self.assertEqual(float(REP.share_below(earlier)), 0.0)
            # late-born: cell 0 (1700 of 2000 is in the last 20 %); the rows of cell 1 are not
            self.assertEqual(len(REP._sel(r, 0.0, 1.0, "ratio", "late_i")), 1)
            self.assertEqual(len(REP._sel(r, 0.0, 1.0, "ratio", "early_i")), 1)
            self.assertEqual((det["n_late"], det["matched_late"]), (1, 1))
            # correlation pairs carry the births: the pair's later member is late-born
            self.assertEqual(len(r["c_late"]), 1)
            self.assertTrue(bool(r["c_late"][0]))

    def test_reversing_birth_order_reverses_the_groups(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim, run = self.run_dir(tmp, {0: 100, 1: 1700})  # the bitten cell is now the older one
            DM.compute_run(sim, run)
            r = REP.load_run(run)
            self.assertAlmostEqual(float(REP._sel(r, 0.5, 0.75, "ratio", "later")[0]), 1.0, delta=0.05)
            self.assertAlmostEqual(float(REP._sel(r, 0.5, 0.75, "ratio", "earlier")[0]), 0.0, delta=0.05)

    def test_simultaneous_births_and_missing_ledger_are_in_neither_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim, run = self.run_dir(tmp, {0: 500, 1: 520})  # gap 1 % of the recording, under the 3 % tie
            DM.compute_run(sim, run)
            r = REP.load_run(run)
            self.assertEqual((int(r["later"].sum()), int(r["earlier"].sum())), (0, 0))
        with tempfile.TemporaryDirectory() as tmp:
            sim, run = Metrics().make_run(tmp, True)  # no adds.tsv at all
            det = DM.compute_run(sim, run)
            r = REP.load_run(run)
            self.assertEqual(det["births_known"], 0)
            self.assertEqual((int(r["later"].sum()), int(r["late_i"].sum())), (0, 0))

    def test_ledger_from_another_run(self):
        # stage / checkpoint libraries are scored in runs without a ledger: --ledger points at the main run
        with tempfile.TemporaryDirectory() as tmp:
            sim, run = Metrics().make_run(tmp, True)
            led = Path(tmp) / "main"
            led.mkdir()
            adds(led / "adds.tsv", {0: 1700, 1: 100})
            self.assertEqual(DM.compute_run(sim, run, ledger=led)["births_known"], 2)

    def test_corr_pairs_carry_births(self):
        rng = np.random.default_rng(0)
        gt = rng.normal(size=(2, 800))
        rows = DM.corr_pairs("s", gt, gt, np.array([[0.0, 0.0], [10.0, 0.0]]), 10.0, [0, 1], born=[300.0, 50.0])
        self.assertEqual((rows[0]["born_min"], rows[0]["born_max"]), (50.0, 300.0))
        rows = DM.corr_pairs("s", gt, gt, np.array([[0.0, 0.0], [10.0, 0.0]]), 10.0, [0, 1])
        self.assertTrue(np.isnan(rows[0]["born_max"]))


@unittest.skipIf(np is None, "numpy/scipy not installed")
class Undetected(unittest.TestCase):
    def run_with_missing_neighbour(self, tmp, overfill):
        """Two GT cells 6 px apart; the library holds only cell 0, optionally with cell 1's light added to it."""
        h = w = 80
        T = 2000
        rng = np.random.default_rng(5)
        C = rng.exponential(1, (2, T)).astype(np.float32)
        sim, run = Path(tmp) / "sim", Path(tmp) / "run"
        sim.mkdir()
        run.mkdir()
        write_oracle(sim / "oracle.bin", h, w, [(40, 34), (40, 40)], C)
        e0 = gauss(h, w, 40, 34, 4)
        if overfill:
            e0 = e0 + 1.5 * gauss(h, w, 40, 40, 3)  # absorbed the neighbour
        write_footprints(run / "footprints.bin", h, w, [e0])
        (run / "dump_trace.f32").write_bytes(C[:1].T.astype("<f4").tobytes())
        (run / "final.tsv").write_text("slot\tmatched\tbest_gt\n0\t1\t0\n")
        (run / "gt.tsv").write_text("gt\tcy\tcx\tdetectable\n0\t40\t34\t1\n1\t40\t40\t1\n")
        (run / "stdout.log").write_text("QC cost per frame: mean 0.250 ms\n")
        return sim, run

    def test_overfill_at_an_undetected_neighbour(self):
        for overfill in (False, True):
            with tempfile.TemporaryDirectory() as tmp:
                sim, run = self.run_with_missing_neighbour(tmp, overfill)
                DM.compute_run(sim, run)
                r = REP.load_run(run)
                self.assertEqual(len(r["ratio"]), 0)  # no matched neighbour: the existing bite metrics skip it
                ratio = REP._und(r, 0.5, 0.75)
                self.assertEqual(len(ratio), 1)
                if overfill:
                    self.assertGreater(ratio[0], REP.OVERFILL_THR)
                    self.assertEqual(float(REP.share_over(ratio)), 1.0)
                else:
                    self.assertAlmostEqual(float(ratio[0]), 1.0, delta=0.05)  # clean skirt: est equals true there
                    self.assertEqual(float(REP.share_over(ratio)), 0.0)

    def test_unmatched_but_not_detectable_neighbours_are_not_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim, run = self.run_with_missing_neighbour(tmp, True)
            # rewrite the oracle with the neighbour flagged not detectable
            h = w = 80
            b = bytearray((sim / "oracle.bin").read_bytes())
            # unit records start at byte 24; each is 4 + 4 + 8 + 2 * (16 + 4 h w) bytes, flags at offset 4 of the record
            rec = 4 + 4 + 8 + 2 * (16 + 4 * h * w)
            b[24 + rec + 4] = 0
            (sim / "oracle.bin").write_bytes(bytes(b))
            DM.compute_run(sim, run)
            self.assertEqual(len(REP._und(REP.load_run(run), 0.0, 1.0)), 0)


@unittest.skipIf(np is None, "numpy/scipy not installed")
class Clusters(unittest.TestCase):
    def blobs(self, centres, h=40, w=300, s=3.0):
        out = []
        for cy, cx in centres:
            g = gauss(h, w, cy, cx, s)
            idx = np.flatnonzero(g.ravel() > 1e-3)
            out.append((idx, g.ravel()[idx].astype(float)))
        return out, h * w

    def test_rho_matches_dense_gram(self):
        filt, n = self.blobs([(20, 20), (20, 26), (20, 120)])
        R = CL.gram_rho(filt, n).toarray()
        dense = np.zeros((3, n))
        for i, (p, v) in enumerate(filt):
            dense[i, p] = v
        G = dense @ dense.T
        want = G / np.sqrt(np.outer(np.diag(G), np.diag(G)))
        np.fill_diagonal(want, 0)
        self.assertTrue(np.allclose(R, want, atol=1e-9))
        self.assertAlmostEqual(R[0, 1], np.exp(-36 / 36), delta=0.01)  # Gaussians: exp(-d^2 / 4 s^2)
        self.assertLess(R[0, 2], 1e-6)

    def test_sizes_singletons_and_pairs(self):
        filt, n = self.blobs([(20, 20), (20, 26), (20, 200)])
        st = CL.cluster_stats(filt, n)
        self.assertEqual((st["hist"]["1"], st["hist"]["2"]), (1, 1))
        self.assertEqual((st["cells_in_2plus"], st["max_component"], st["edges"], st["edges_cut"]), (2, 2, 1, 0))
        self.assertAlmostEqual(st["share_clustered"], 2 / 3)

    def test_kmax_cut_on_a_chain(self):
        # 9 cells in a row, each overlapping its neighbours: one component of 9, cut into clusters of at most 6
        filt, n = self.blobs([(20, 15 + 6 * k) for k in range(9)])
        st = CL.cluster_stats(filt, n)
        self.assertEqual(st["max_component"], 9)
        self.assertEqual(st["cells_in_big_component"], 9)
        sizes = [int(k) for k, c in st["hist"].items() for _ in range(c)]
        self.assertLessEqual(max(sizes), CL.K_MAX)
        self.assertEqual(sum(sizes), 9)
        self.assertGreater(st["edges_cut"], 0)

    def test_greedy_takes_strongest_edges_first(self):
        # three cells on a line, 0-1 close, 1-2 farther; K_max 2 keeps the stronger 0-1 edge
        filt, n = self.blobs([(20, 20), (20, 24), (20, 31)])
        R = CL.gram_rho(filt, n)
        lab, comp, cut = CL.cluster_labels(R, 0.05, 2)
        self.assertEqual(lab[0], lab[1])
        self.assertNotEqual(lab[1], lab[2])
        self.assertEqual(len(set(comp)), 1)
        self.assertEqual(cut, 1)

    def test_membership_change_causes(self):
        filt, n = self.blobs([(20, 20), (20, 26), (20, 200)])
        ids = [10, 11, 12]
        m0 = CL.membership(ids, filt, n)
        self.assertEqual(m0[10], frozenset({10, 11}))
        self.assertEqual(m0[12], frozenset({12}))
        # a birth next to the pair: cells 10 and 11 gain a member
        filt2, n2 = self.blobs([(20, 20), (20, 26), (20, 200), (20, 32)])
        m1 = CL.membership([10, 11, 12, 13], filt2, n2)
        c = CL.membership_change(m0, m1)
        self.assertEqual((c["survivors"], c["changed"], c["birth"]), (3, 2, 2))
        self.assertAlmostEqual(c["share_changed"], 2 / 3)
        self.assertEqual(c["clustered"], 2)
        self.assertAlmostEqual(c["share_clustered_changed"], 1.0)
        # removal of cell 11: cell 10 loses a member
        m2 = CL.membership([10, 12], [filt[0], filt[2]], n)
        c = CL.membership_change(m0, m2)
        self.assertEqual((c["changed"], c["loss"], c["birth"]), (1, 1, 0))
        # nothing changes between a library and itself
        self.assertEqual(CL.membership_change(m0, m0)["changed"], 0)

    def test_empty_library(self):
        self.assertEqual(CL.cluster_stats([], 100)["n_cells"], 0)
        self.assertEqual(CL.membership([], [], 100), {})


@unittest.skipIf(np is None, "numpy/scipy not installed")
class ReportAdditions(unittest.TestCase):
    def runs(self, share_bad, excess, rng, seeds=4):
        return {r["name"]: r for r in Stats().arm(share_bad, excess, rng, seeds=seeds)}

    def test_new_metric_rows_exist_and_old_runs_give_na_not_errors(self):
        rng = np.random.default_rng(1)
        names, rows = REP.compare(list(self.runs(0.5, 0.2, rng).values()), list(self.runs(0.3, 0.1, rng).values()))
        by = {r["name"]: r for r in rows}
        for n in ("Bite share ratio < 0.5, later-born cell, 0.75-1.0 D", "Bite share ratio < 0.5, late-born cell, 0.5-0.75 D",
                  "Over-fill share est/true > 1.3 at undetected neighbour, < 1 D", "Trace corr excess < 1 D, pairs with a late-born member"):  # fmt: skip
            self.assertIn(n, by)
            self.assertEqual(by[n]["flag"], "n/a")  # fake runs carry no birth or neighbour data

    def birth_run(self, name, p_later_bad, p_earlier_bad, rng, n=80):
        """A run whose later-born rows are bitten with probability p_later_bad and earlier-born rows with p_earlier_bad."""
        later = np.r_[np.ones(n, bool), np.zeros(n, bool)]
        ratio = np.where(rng.random(2 * n) < np.where(later, p_later_bad, p_earlier_bad), 0.0, rng.uniform(0.6, 1.0, 2 * n))
        run = Stats().fake_run(name, ratio, np.full(2 * n, 0.9), np.zeros(4), np.array([0.5, 0.5, 2.0, 2.0]))
        run.update({"later": later, "earlier": ~later, "late_i": np.zeros(2 * n, bool), "early_i": np.ones(2 * n, bool), "c_late": np.zeros(4, bool),
                    "und_d": np.array([0.8] * 20), "und_ratio": np.r_[np.full(10, 2.0), np.full(10, 1.0)]})  # fmt: skip
        return run

    def test_birth_order_rows_recover_the_planted_asymmetry(self):
        rng = np.random.default_rng(3)
        arm = [self.birth_run(f"static_s{s}", 0.9, 0.1, rng) for s in range(4)]
        # base: later-born bitten 90 %; new: 40 % (earlier-born unchanged)
        new = [self.birth_run(f"static_s{s}", 0.4, 0.1, rng) for s in range(4)]
        _, rows = REP.compare(arm, new)
        by = {r["name"]: r for r in rows}
        later = by["Bite share ratio < 0.5, later-born cell, 0.75-1.0 D"]
        earlier = by["Bite share ratio < 0.5, earlier-born cell, 0.75-1.0 D"]
        self.assertAlmostEqual(later["base"], 0.9, delta=0.08)
        self.assertAlmostEqual(earlier["base"], 0.1, delta=0.08)
        self.assertEqual(later["flag"], "better")
        self.assertEqual(earlier["flag"], "within noise")
        self.assertEqual(later["n_base"], 4 * 80)
        # undetected neighbour: half the rows at 2.0 (over-fill) -> share 0.5, median between 1 and 2
        und = by["Over-fill share est/true > 1.3 at undetected neighbour, 0.75-1.0 D"]
        self.assertAlmostEqual(und["base"], 0.5, delta=0.01)

    def test_cluster_section_renders_pooled_counts(self):
        c = {"hist": {"1": 10, "2": 4}, "n_cells": 18, "cells_in_2plus": 8, "edges": 5, "edges_cut": 1, "cells_in_big_component": 0, "max_component": 3}
        runs = [{"name": "s5", "det": {"clusters": c}}, {"name": "s6", "det": {"clusters": c}}, {"name": "s7", "det": {}}]
        tot = REP.cluster_totals(runs, ["s5", "s6", "s7"])
        self.assertEqual((tot["cells"], tot["in2"], tot["hist"]["1"], tot["cut"], tot["maxc"]), (36, 16, 20, 2, 3))
        md = "\n".join(REP.cluster_section([tot, tot], ["a", "b"]))
        self.assertIn("clusters of size 2 | 8 | 8", md)
        self.assertIn("16 (44%)", md)
        self.assertEqual(REP.cluster_section([REP.cluster_totals([], []), REP.cluster_totals([], [])], ["a", "b"]), [])


@unittest.skipIf(np is None, "numpy/scipy not installed")
class Stages(unittest.TestCase):
    def stages(self, specs, rng):
        out = []
        for k, (bad, ex) in enumerate(specs):
            runs = {r["name"]: r for r in Stats().arm(bad, ex, rng)}
            out.append({"name": "Discover" if k == 0 else f"+{k} Refine", "idx": k, "wall": 100.0 * (k + 1), "runs": runs})
        return out

    def test_time_to_good_picks_the_first_stage_within_the_reference_ci(self):
        rng = np.random.default_rng(11)
        st = self.stages([(0.7, 0.30), (0.4, 0.16), (0.30, 0.10), (0.30, 0.10)], rng)
        self.assertEqual(ST.time_to_good(st, st[3])[0], 2)  # stage 1 is still clearly worse than the last stage
        self.assertEqual(ST.time_to_good(st, st[3])[2], 300.0)
        self.assertEqual(ST.time_to_good(st, st[3])[1], "+2 Refine")
        # judged against stage 1 instead: Discover is not good, stage 1 is
        self.assertEqual(ST.time_to_good(st, st[1])[0], 1)

    def test_not_reached_and_better_than_reference_counts_as_good(self):
        rng = np.random.default_rng(12)
        st = self.stages([(0.7, 0.30), (0.6, 0.25)], rng)
        great = self.stages([(0.1, 0.02)], rng)[0]
        self.assertIsNone(ST.time_to_good(st, great))  # nothing reaches a much better reference
        self.assertEqual(ST.time_to_good([great], st[1])[0], 0)  # a better-than-reference stage is good

    def test_good_requires_both_metrics(self):
        rng = np.random.default_rng(13)
        ref = self.stages([(0.3, 0.10)], rng)[0]
        # headline as good as the reference but bites far worse
        mixed = {r["name"]: r for r in Stats().arm(0.8, 0.10, rng)}
        _, rows = ST.stat_rows(ref["runs"], mixed)
        _, ref_rows = ST.stat_rows(ref["runs"], ref["runs"])
        self.assertFalse(ST.good_stage(rows, ref_rows))
        self.assertTrue(ST.good_stage(ref_rows, ref_rows))

    def test_table_renders_every_stage(self):
        rng = np.random.default_rng(14)
        st = self.stages([(0.6, 0.25), (0.3, 0.10)], rng)
        md = "\n".join(ST.table([(s["name"], s["runs"]) for s in st], st[1]["runs"], "T", "note"))
        self.assertIn("| corr excess < 1 D (headline) |", md)
        self.assertIn("Discover", md)
        self.assertIn("+1 Refine", md)
        self.assertIn("better", md)  # Discover is flagged against the last stage

    def test_lib_files_and_pass_walls(self):
        with tempfile.TemporaryDirectory() as tmp:
            main = Path(tmp)
            for n in ("footprints_wrap1.bin", "footprints_wrap2.bin", "footprints_t2400.bin", "footprints_t1200.bin", "footprints_pass1.bin", "footprints_pass2.bin"):
                (main / n).write_bytes(b"x")
            (main / "passes.tsv").write_text("pass\tframe\tcells\tslow_cells\tadds\tmerges\tdeletes\tsplits\tslow_frames\twall_s\n"
                                              "1\t9600\t5\t5\t5\t0\t0\t0\t9550\t180.5\n2\t19200\t5\t5\t5\t0\t0\t0\t19150\t170.0\n3\t28800\t5\t5\t5\t0\t0\t0\t28750\t171.0\n")  # fmt: skip
            got = ST.lib_files(main, 3)
            self.assertEqual([(k, key) for k, key, _ in got], [("stage", 0), ("stage", 1), ("ckpt", 1200), ("ckpt", 2400), ("ckpt", None)])
            self.assertEqual(ST.pass_walls(main), ([180.5, 170.0, 171.0], 9600))


if __name__ == "__main__":
    unittest.main()
