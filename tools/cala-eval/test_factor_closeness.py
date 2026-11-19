"""Tests for factor_closeness.py: `python -m unittest discover tools/cala-eval`."""

import math
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import factor_closeness as F

DIMS = (128, 128)


def write_run(
    d: Path,
    cells: dict[int, tuple[list[int], list[float]]],
    traces: dict[int, list[float]],
    qc: dict[int, tuple[int, float]] | None = None,
) -> None:
    """A minimal qc_eval run directory. `qc`: {id: (checkpoint frame, pass)} rows of cells.tsv."""
    d.mkdir(parents=True)
    h, w = DIMS
    with open(d / "footprints.bin", "wb") as f:
        f.write(b"CALAFP01" + struct.pack("<III", h, w, len(cells)))
        for cid, (pix, val) in cells.items():
            f.write(struct.pack("<II", cid, len(pix)))
            f.write(np.asarray(pix, "<u4").tobytes())
            f.write(np.asarray(val, "<f4").tobytes())
            f.write(np.asarray(val, "<f4").tobytes())
    final = ["slot\tid\tcy\tcx"]
    for s, (cid, (pix, val)) in enumerate(cells.items()):
        p, v = np.asarray(pix), np.asarray(val)
        final.append(
            f"{s}\t{cid}\t{(p // w * v).sum() / v.sum():.2f}\t{(p % w * v).sum() / v.sum():.2f}"
        )
    (d / "final.tsv").write_text("\n".join(final) + "\n")
    ids = list(traces)
    (d / "extract_ids.tsv").write_text(
        "slot\tid\n" + "".join(f"{k}\t{c}\n" for k, c in enumerate(ids))
    )
    data = (
        np.stack([np.asarray(traces[c], "<f4") for c in ids], axis=1)
        if ids
        else np.zeros(0, "<f4")
    )
    data.tofile(d / "extract_trace.f32")
    if qc is not None:
        rows = ["frame\tslot\tid\tpass"]
        rows += [f"{fr}\t0\t{cid:.5f}\t{p:.5f}" for cid, (fr, p) in qc.items()]
        (d / "cells.tsv").write_text("\n".join(rows) + "\n")


def blob(cy: int, cx: int) -> tuple[list[int], list[float]]:
    """A 3 x 3 footprint centred at (cy, cx)."""
    pix = [(cy + dy) * DIMS[1] + cx + dx for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
    return pix, [1.0, 2.0, 1.0, 2.0, 4.0, 2.0, 1.0, 2.0, 1.0]


T = np.sin(np.arange(200) * 0.3)
CELLS = {7: blob(20, 20), 9: blob(63, 90), 11: blob(100, 40)}
TRACES = {7: list(T), 9: list(np.roll(T, 5)), 11: list(np.roll(T, 11))}

CELLS_XY = {7: (20, 20), 9: (63, 90), 11: (100, 40)}


class Closeness(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_identical_runs_agree_exactly(self) -> None:
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", CELLS, TRACES)
        rows = F.compare(self.root / "a", self.root / "b")
        self.assertEqual([r["id"] for r in rows], [7, 9, 11])
        for r in rows:
            self.assertAlmostEqual(r["trace_r"], 1.0, places=6)
            self.assertAlmostEqual(r["fp_cos"], 1.0, places=6)
            self.assertAlmostEqual(r["trace_r1"], 1.0, places=6)
            self.assertEqual(r["in_test"], 1.0)

    def test_distance_to_tile_lines_and_border(self) -> None:
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", CELLS, TRACES)
        rows = {r["id"]: r for r in F.compare(self.root / "a", self.root / "b")}
        self.assertAlmostEqual(
            rows[9]["edge_px"], 0.5
        )  # row 63 beside the line at 63.5
        self.assertAlmostEqual(rows[7]["edge_px"], 43.5)
        self.assertAlmostEqual(rows[7]["border_px"], 20.0)
        self.assertEqual(F.line_distance(10.0, 40, 64), math.inf)

    def test_missing_cell_and_constant_trace_do_not_count_as_agreement(self) -> None:
        cells_b = {7: CELLS[7], 9: CELLS[9]}
        traces_b = {7: [0.0] * 200, 9: TRACES[9]}
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", cells_b, traces_b)
        rows = {r["id"]: r for r in F.compare(self.root / "a", self.root / "b")}
        self.assertEqual(rows[11]["in_test"], 0.0)
        self.assertTrue(math.isnan(rows[11]["fp_cos"]))
        self.assertTrue(math.isnan(rows[11]["trace_r"]))
        self.assertTrue(math.isnan(rows[7]["trace_r"]))
        self.assertTrue(math.isnan(rows[11]["trace_r1"]))
        self.assertTrue(math.isnan(rows[7]["trace_r1"]))
        self.assertAlmostEqual(F.loss(list(rows.values()), "trace_r"), 0.0, places=6)
        self.assertEqual(F.dropped(list(rows.values()), "trace_r"), 2)
        self.assertEqual(F.dropped(list(rows.values()), "fp_cos"), 1)
        self.assertEqual(F.verdict(0.0, [0.01], 2, [0]), "dropped cells")
        text = F.report(self.root / "a", self.root / "b", [])
        self.assertIn("1 of 3 cells are missing", text)

    def test_shifted_footprint_lowers_the_cosine(self) -> None:
        moved = dict(CELLS)
        moved[7] = blob(20, 21)
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", moved, TRACES)
        rows = {r["id"]: r for r in F.compare(self.root / "a", self.root / "b")}
        self.assertLess(rows[7]["fp_cos"], 0.9)
        self.assertGreater(rows[7]["fp_cos"], 0.3)

    def test_qc_comes_from_the_last_checkpoint(self) -> None:
        write_run(self.root / "a", CELLS, TRACES, qc={7: (300, 0.0)})
        with open(self.root / "a" / "cells.tsv", "a") as f:
            f.write("600\t0\t7.00000\t1.00000\n600\t1\t9.00000\t0.00000\n")
        self.assertEqual(F.read_qc(self.root / "a"), {7: True, 9: False})

    def test_lag1_correlation_ignores_white_noise(self) -> None:
        rng = np.random.default_rng(3)
        t = np.arange(4000)
        signal = np.sin(t * 0.05) + 0.5 * np.sin(t * 0.013)
        noisy = signal + rng.normal(0.0, 1.0, len(t))
        self.assertLess(F.pearson(noisy, signal), 0.75)
        self.assertGreater(F.lag1_r(noisy, signal), 0.97)
        self.assertAlmostEqual(F.lag1_r(signal, signal), 1.0, places=9)
        self.assertLess(F.lag1_r(signal, np.cos(t * 0.21)), 0.2)

    def test_lag1_correlation_is_undefined_without_slow_structure(self) -> None:
        self.assertTrue(
            math.isnan(F.lag1_r(np.zeros(100), np.sin(np.arange(100) * 0.1)))
        )
        self.assertTrue(
            math.isnan(F.lag1_r(np.asarray([1.0, 2.0]), np.asarray([1.0, 2.0])))
        )
        alternating = np.asarray([1.0, -1.0] * 50)
        self.assertTrue(math.isnan(F.lag1_r(alternating, np.sin(np.arange(100) * 0.1))))

    def test_lag1_correlation_of_noise_is_undefined_and_never_out_of_range(
        self,
    ) -> None:
        sine = np.sin(np.arange(300) * 0.1)
        values = []
        for seed in range(200):
            noise = np.random.default_rng(seed).normal(0.0, 1.0, 300)
            values.append(F.lag1_r(noise, sine))
        defined = [v for v in values if not math.isnan(v)]
        self.assertLess(len(defined), 5)
        self.assertTrue(all(-1.0 <= v <= 1.0 for v in defined))

    def test_lag1_correlation_is_clipped(self) -> None:
        t = np.arange(500)
        a = np.sin(t * 0.05)
        self.assertLessEqual(F.lag1_r(a, a * 3.0 + 1e-9 * np.cos(t)), 1.0)
        self.assertAlmostEqual(F.lag1_r(a, -a), -1.0, places=9)

    def test_verdict(self) -> None:
        self.assertEqual(F.verdict(0.01, [0.02, 0.005]), "within")
        self.assertEqual(F.verdict(0.03, [0.02, 0.005]), "outside")
        self.assertEqual(F.verdict(0.03, []), "not judged")
        self.assertEqual(F.verdict(float("nan"), [0.02]), "not judged")
        self.assertEqual(F.verdict(0.01, [0.02], 1, [1]), "within")
        self.assertEqual(F.verdict(0.01, [0.02], 2, [1]), "dropped cells")
        self.assertEqual(F.verdict(0.03, [0.02], 5, [0]), "outside")

    def test_a_run_without_cells_reports_and_does_not_crash(self) -> None:
        write_run(self.root / "a", {}, {})
        write_run(self.root / "b", {}, {})
        self.assertEqual(F.compare(self.root / "a", self.root / "b"), [])
        self.assertIn("0 cells", F.report(self.root / "a", self.root / "b", []))

    def test_truth_correlation_uses_units_near_the_cell(self) -> None:
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", CELLS, TRACES)
        h, w = DIMS
        pix, val = blob(21, 20)  # one unit, 1 px from cell 7
        np.savez(
            self.root / "truth.npz",
            A_data=np.asarray(val, "f4"),
            A_indices=np.asarray(pix, "i4"),
            A_indptr=np.asarray([0, len(pix)], "i4"),
            A_shape=np.asarray([1, h * w]),
            traces=np.asarray([TRACES[7]], "f4"),
        )
        rows = {
            r["id"]: r
            for r in F.compare(
                self.root / "a", self.root / "b", truth_path=self.root / "truth.npz"
            )
        }
        self.assertAlmostEqual(rows[7]["truth_r_ref"], 1.0, places=6)
        self.assertTrue(math.isnan(rows[11]["truth_r_ref"]))  # no unit within 6 px

    def _write_truth(
        self, units: list[tuple[tuple[list[int], list[float]], int]]
    ) -> Path:
        h, w = DIMS
        pix = [p for (b, _) in units for p in b[0]]
        val = [v for (b, _) in units for v in b[1]]
        ptr = [0]
        for b, _ in units:
            ptr.append(ptr[-1] + len(b[0]))
        path = self.root / "truth.npz"
        np.savez(
            path,
            A_data=np.asarray(val, "f4"),
            A_indices=np.asarray(pix, "i4"),
            A_indptr=np.asarray(ptr, "i4"),
            A_shape=np.asarray([len(units), h * w]),
            traces=np.asarray([TRACES[i] for (_, i) in units], "f4"),
        )
        return path

    def test_truth_offset_is_estimated_and_applied(self) -> None:
        a, b = self.root / "a", self.root / "b"
        write_run(a, CELLS, TRACES)
        write_run(b, CELLS, TRACES)
        truth = self._write_truth(
            [(blob(cy - 3, cx + 7), i) for i, (cy, cx) in CELLS_XY.items()]
        )
        dy, dx, n = F.truth_offset(
            F.read_traces(a), F.read_centroids(a), F.read_truth(truth, DIMS)
        )
        self.assertAlmostEqual(dy, -3.0, places=6)
        self.assertAlmostEqual(dx, 7.0, places=6)
        self.assertEqual(n, 3)
        rows = F.compare(a, b, truth_path=truth)
        self.assertEqual(len(rows), 3)
        for r in rows:
            self.assertAlmostEqual(r["truth_r_ref"], 1.0, places=6)
        text = F.report(a, b, [], truth_path=truth)
        self.assertIn(
            "Truth frame offset (dy, dx) = (-3.0, +7.0) px from 3 cells; 3 of 3 cells",
            text,
        )

    def test_truth_offset_needs_three_cells(self) -> None:
        a = self.root / "a"
        write_run(a, CELLS, TRACES)
        truth = self._write_truth([(blob(21, 20), 7)])
        self.assertEqual(
            F.truth_offset(
                F.read_traces(a), F.read_centroids(a), F.read_truth(truth, DIMS)
            ),
            (0.0, 0.0, 1),
        )

    def test_truth_footprint_correlation_follows_the_offset(self) -> None:
        a, b = self.root / "a", self.root / "b"
        write_run(a, CELLS, TRACES)
        moved = dict(CELLS)
        moved[9] = blob(63, 91)
        write_run(b, moved, TRACES)
        truth = self._write_truth(
            [(blob(cy - 3, cx + 7), i) for i, (cy, cx) in CELLS_XY.items()]
        )
        rows = {r["id"]: r for r in F.compare(a, b, truth_path=truth)}
        for cid in (7, 9, 11):
            self.assertAlmostEqual(rows[cid]["truth_fp_ref"], 1.0, places=6)
            self.assertEqual(
                rows[cid]["truth_overlap"], 0.0, "no cat_overlap: none overlaps"
            )
        self.assertAlmostEqual(rows[7]["truth_fp_test"], 1.0, places=6)
        self.assertLess(rows[9]["truth_fp_test"], 0.9, "a footprint 1 px off")
        text = F.report(a, b, [], truth_path=truth)
        self.assertIn(
            "Footprint correlation with the truth footprint, median: reference 1.0000",
            text,
        )
        last = [ln for ln in text.splitlines() if ln][-1]
        self.assertTrue(last.startswith("Gate A1: "), last)

    def test_a_paired_cell_is_measured_against_the_reference_cells_unit(self) -> None:
        a, b = self.root / "a", self.root / "b"
        write_run(a, CELLS, TRACES)
        traces_b = dict(TRACES)
        traces_b[9] = TRACES[11]  # follows the extra unit beside cell 9
        write_run(b, CELLS, traces_b)
        units = [(blob(cy - 3, cx + 7), i) for i, (cy, cx) in CELLS_XY.items()]
        units.append((blob(63 - 3 + 2, 90 + 7), 11))
        truth = self._write_truth(units)
        rows = {r["id"]: r for r in F.compare(a, b, truth_path=truth)}
        self.assertAlmostEqual(rows[9]["truth_fp_test"], 1.0, places=6)
        self.assertEqual(rows[9]["truth_other"], 1.0)
        self.assertEqual(rows[7]["truth_other"], 0.0)
        text = F.report(a, b, [], truth_path=truth)
        self.assertIn("1 paired cells whose test trace fits another truth unit", text)
        self.assertIn("reference 1.0000 over 3 cells", text)

    def test_cells_are_paired_by_footprint_not_by_id(self) -> None:
        a, b = self.root / "a", self.root / "b"
        write_run(a, CELLS, TRACES)
        # The test run numbers its cells otherwise, and its id 9 is another cell.
        cells_b = {107: CELLS[7], 9: CELLS[11], 109: CELLS[9]}
        traces_b = {107: TRACES[7], 9: TRACES[11], 109: TRACES[9]}
        write_run(b, cells_b, traces_b)
        _, fa = F.read_footprints(a / "footprints.bin")
        _, fb = F.read_footprints(b / "footprints.bin")
        pairs = F.match_cells(fa, fb, DIMS)
        self.assertEqual(pairs, {7: 107, 9: 109, 11: 9})
        rows = {r["id"]: r for r in F.compare(a, b, pairs=pairs)}
        for r in rows.values():
            self.assertAlmostEqual(r["fp_cos"], 1.0, places=6)
            self.assertAlmostEqual(r["trace_r"], 1.0, places=6)
        self.assertEqual(rows[9]["test_id"], 109.0)
        by_id = {r["id"]: r for r in F.compare(a, b)}
        self.assertLess(by_id[9]["fp_cos"], 0.5, "by id, cell 9 meets another cell")
        text = F.report(a, b, [], match=True)
        self.assertIn(": 3 pairs.", text)
        self.assertIn("0 cells of the test run are not in the reference run.", text)
        self.assertIn("0 of them are missing in the test run", text)

    def test_a_moved_cell_stays_unpaired_and_counts_as_lost(self) -> None:
        a, b = self.root / "a", self.root / "b"
        write_run(a, CELLS, TRACES)
        write_run(b, {7: CELLS[7], 9: CELLS[9], 11: blob(100, 50)}, TRACES)
        _, fa = F.read_footprints(a / "footprints.bin")
        _, fb = F.read_footprints(b / "footprints.bin")
        self.assertEqual(F.match_cells(fa, fb, DIMS), {7: 7, 9: 9})
        rows = {r["id"]: r for r in F.compare(a, b, pairs=F.match_cells(fa, fb, DIMS))}
        self.assertEqual(rows[11]["in_test"], 0.0)
        text = F.report(a, b, [], match=True)
        self.assertIn(": 2 pairs.", text)
        self.assertIn("1 cells of the test run are not in the reference run.", text)
        self.assertIn("1 of them are missing in the test run", text)

    def test_two_test_cells_on_one_reference_cell_pair_one_to_one(self) -> None:
        fa = {1: blob(20, 20)}
        fa = {k: (np.asarray(p), np.asarray(v)) for k, (p, v) in fa.items()}
        fb = {
            5: (np.asarray(blob(20, 20)[0]), np.asarray(blob(20, 20)[1])),
            3: (np.asarray(blob(20, 20)[0]), np.asarray(blob(20, 20)[1])),
        }
        # Equal cosines: the lower test id wins, and the other stays unpaired.
        self.assertEqual(F.match_cells(fa, fb, DIMS), {1: 3})

    def test_pairing_handles_empty_runs_and_empty_footprints(self) -> None:
        empty = np.zeros(0, dtype=np.int64), np.zeros(0)
        cell = (np.asarray(blob(5, 5)[0]), np.asarray(blob(5, 5)[1]))
        self.assertEqual(F.match_cells({}, {1: cell}, DIMS), {})
        self.assertEqual(F.match_cells({1: cell}, {}, DIMS), {})
        self.assertEqual(F.match_cells({1: empty}, {2: cell}, DIMS), {})
        self.assertEqual(F.match_cells({1: cell}, {2: empty}, DIMS), {})

    def test_pairing_works_at_the_frame_border(self) -> None:
        cell = (np.asarray([0, 1, 128, 129]), np.asarray([1.0, 2.0, 2.0, 4.0]))
        self.assertEqual(F.match_cells({4: cell}, {8: cell}, DIMS), {4: 8})
        self.assertEqual(F.footprint_centroid(cell, 128)[0] > 0, True)

    def test_footprint_correlation_is_nan_for_a_constant_footprint(self) -> None:
        flat = (np.arange(DIMS[0] * DIMS[1]), np.ones(DIMS[0] * DIMS[1]))
        unit = (np.asarray(blob(20, 20)[0]), np.asarray(blob(20, 20)[1]))
        self.assertTrue(math.isnan(F.fp_truth_r(flat, unit, (0, 0), DIMS)))
        self.assertTrue(math.isnan(F.fp_truth_r(unit, flat, (0, 0), DIMS)))

    def test_cells_only_in_the_test_run_are_reported(self) -> None:
        write_run(
            self.root / "a", {7: CELLS[7], 9: CELLS[9]}, {7: TRACES[7], 9: TRACES[9]}
        )
        write_run(self.root / "b", CELLS, TRACES)
        text = F.report(self.root / "a", self.root / "b", [])
        self.assertIn("1 cells of the test run are not in the reference run.", text)

    def test_a_cell_without_a_centroid_is_counted(self) -> None:
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", CELLS, TRACES)
        final = self.root / "a" / "final.tsv"
        kept = [
            ln for ln in final.read_text().splitlines() if ln.split("\t")[1] != "11"
        ]
        final.write_text("\n".join(kept) + "\n")
        rows = {r["id"]: r for r in F.compare(self.root / "a", self.root / "b")}
        self.assertTrue(math.isnan(rows[11]["edge_px"]))
        text = F.report(self.root / "a", self.root / "b", [])
        self.assertIn("1 cells have no centroid in final.tsv", text)

    def test_report_ends_with_gate_a1_and_counts_the_cells_it_ran_over(self) -> None:
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", CELLS, TRACES)
        text = F.report(self.root / "a", self.root / "b", [])
        last = [ln for ln in text.splitlines() if ln][-1]
        self.assertTrue(last.startswith("Gate A1: "), last)
        self.assertIn("QC-pass cells;", text)
        self.assertIn("missing in the test run", text)

    def test_report_measures_both_footprint_jumps_on_its_tile(self) -> None:
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", CELLS, TRACES)
        seen: list[int] = []

        def jump(cells: dict, dims: tuple[int, int], tile: int) -> float:
            seen.append(tile)
            return 1.0

        with mock.patch.object(F, "line_jump", side_effect=jump):
            F.report(self.root / "a", self.root / "b", [], tile=32)
        self.assertEqual(seen, [32, 32])

    def test_report_judges_against_a_null_run(self) -> None:
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", CELLS, TRACES)
        noise = 0.05 * np.cos(np.arange(200) * 1.7)
        noisy = {c: list(np.asarray(TRACES[c]) + noise) for c in TRACES}
        write_run(self.root / "n", CELLS, noisy)
        text = F.report(self.root / "a", self.root / "b", [self.root / "n"])
        self.assertIn("| within |", text)
        self.assertIn("| not gated |", text)
        self.assertIn("trace r, lag 1", text)
        write_run(
            self.root / "c", {7: CELLS[7], 9: CELLS[9]}, {7: TRACES[7], 9: TRACES[9]}
        )
        text = F.report(self.root / "a", self.root / "c", [self.root / "n"])
        self.assertIn("| dropped cells |", text)


class A1Gate(unittest.TestCase):
    @staticmethod
    def rows(
        n: int, ref: float, test: float, fp: float = 0.99, r1: float = 0.95
    ) -> list[dict[str, float]]:
        return [
            {
                "qc_pass": 1.0,
                "truth_r_ref": ref,
                "truth_r_test": test,
                "fp_cos": fp,
                "trace_r1": r1,
            }
            for _ in range(n)
        ]

    @staticmethod
    def passed(gate: list[tuple[str, str, bool | None]]) -> list[bool | None]:
        return [ok for _, _, ok in gate]

    def test_usable_truth_decides_and_the_trace_rule_does_not_apply(self) -> None:
        gate = F.a1_gate(self.rows(25, 0.85, 0.85, r1=0.80), 1.00, 1.05)
        self.assertEqual(self.passed(gate), [True, True, None, True])
        self.assertTrue(F.a1_passes(gate))

    def test_a_few_much_worse_cells_fail_the_truth_rule(self) -> None:
        rows = self.rows(22, 0.85, 0.85) + self.rows(3, 0.85, 0.70)
        gate = F.a1_gate(rows, 1.0, 1.0)
        self.assertEqual(self.passed(gate), [False, True, None, True])
        self.assertFalse(F.a1_passes(gate))

    def test_without_usable_truth_the_trace_loss_decides(self) -> None:
        nan = float("nan")
        none = F.a1_gate(self.rows(25, nan, nan, r1=0.90), 1.0, 1.0)
        self.assertEqual(self.passed(none), [None, True, False, True])
        # Truth that the raw run itself does not follow is not usable.
        weak = F.a1_gate(self.rows(25, 0.46, 0.60, r1=0.95), 1.0, 1.0)
        self.assertEqual(self.passed(weak), [None, True, True, True])
        few = F.a1_gate(self.rows(19, 0.9, 0.5, r1=0.95), 1.0, 1.0)
        self.assertEqual(self.passed(few), [None, True, True, True])

    def test_footprint_and_tile_line_limits(self) -> None:
        gate = F.a1_gate(self.rows(25, 0.85, 0.85, fp=0.97), 1.10, 1.25)
        self.assertEqual(self.passed(gate), [True, False, None, False])

    def test_cells_that_fail_qc_do_not_count(self) -> None:
        rows = self.rows(25, 0.85, 0.85)
        bad = self.rows(10, 0.85, 0.10, fp=0.1, r1=0.1)
        for r in bad:
            r["qc_pass"] = 0.0
        self.assertTrue(F.a1_passes(F.a1_gate(rows + bad, 1.0, 1.0)))

    def ok(self, rows: list[dict[str, float]], ref: float = 1.0, test: float = 1.0):
        return self.passed(F.a1_gate(rows, ref, test))

    @staticmethod
    def lost(n: int, ref: float) -> list[dict[str, float]]:
        nan = float("nan")
        return [
            {
                "qc_pass": 1.0,
                "in_test": 0.0,
                "truth_r_ref": ref,
                "truth_r_test": nan,
                "fp_cos": nan,
                "trace_r1": nan,
            }
            for _ in range(n)
        ]

    def test_truth_median_limit(self) -> None:
        self.assertEqual(self.ok(self.rows(25, 0.85, 0.85 - 0.009))[0], True)
        self.assertEqual(self.ok(self.rows(25, 0.85, 0.85 - 0.011))[0], False)

    def test_truth_fifth_percentile_limit(self) -> None:
        good = self.rows(22, 0.85, 0.85)
        self.assertEqual(self.ok(good + self.rows(3, 0.85, 0.85 - 0.049))[0], True)
        self.assertEqual(self.ok(good + self.rows(3, 0.85, 0.85 - 0.051))[0], False)

    def test_usable_truth_cell_count_and_raw_median_limits(self) -> None:
        self.assertEqual(self.ok(self.rows(20, 0.85, 0.85))[0], True)
        self.assertIsNone(self.ok(self.rows(19, 0.85, 0.85))[0])
        self.assertEqual(self.ok(self.rows(25, 0.80, 0.80))[0], True)
        self.assertIsNone(self.ok(self.rows(25, 0.79, 0.79))[0])

    def test_footprint_loss_limit(self) -> None:
        self.assertEqual(self.ok(self.rows(25, 0.85, 0.85, fp=0.985))[1], True)
        self.assertEqual(self.ok(self.rows(25, 0.85, 0.85, fp=0.975))[1], False)

    def test_trace_loss_limit_without_usable_truth(self) -> None:
        nan = float("nan")
        self.assertEqual(self.ok(self.rows(25, nan, nan, r1=0.93))[2], True)
        self.assertEqual(self.ok(self.rows(25, nan, nan, r1=0.91))[2], False)

    def test_jump_margin(self) -> None:
        rows = self.rows(25, 0.85, 0.85)
        self.assertEqual(self.ok(rows, 1.0, 1.09)[3], True)
        self.assertEqual(self.ok(rows, 1.0, 1.11)[3], False)

    def test_a_value_exactly_at_a_limit_passes(self) -> None:
        self.assertEqual(self.ok(self.rows(25, 0.85, 0.85, fp=0.98))[1], True)
        self.assertEqual(self.ok(self.rows(25, 0.85, 0.84))[0], True)
        nan = float("nan")
        self.assertEqual(self.ok(self.rows(25, nan, nan, r1=0.92))[2], True)
        self.assertEqual(self.ok(self.rows(25, 0.85, 0.85), 1.0, 1.10)[3], True)

    def test_cells_the_test_run_lost_count_as_the_worst_case(self) -> None:
        rows = self.rows(20, 0.85, 0.85) + self.lost(20, 0.85)
        gate = F.a1_gate(rows, 1.0, 1.0)
        self.assertEqual(self.passed(gate), [False, False, None, True])
        self.assertFalse(F.a1_passes(gate))

    def test_usable_truth_is_decided_on_the_raw_run_alone(self) -> None:
        half = self.rows(15, 0.85, 0.85) + self.lost(15, 0.85)
        self.assertEqual(self.ok(half)[0], False)
        # Raw median 0.70 over all matched cells, 0.85 over the kept ones: not usable.
        weak = self.rows(20, 0.85, 0.85) + self.lost(20, 0.55)
        self.assertIsNone(self.ok(weak)[0])

    @staticmethod
    def flagged(n: int, ref: float) -> list[dict[str, float]]:
        """QC-pass cells the test run lost (`in_test` 0) whose other columns are finite."""
        return [
            {
                "qc_pass": 1.0,
                "in_test": 0.0,
                "truth_r_ref": ref,
                "truth_r_test": ref,
                "fp_cos": 0.99,
                "trace_r1": 0.95,
            }
            for _ in range(n)
        ]

    def test_a_lost_cell_is_the_worst_case_even_with_finite_values(self) -> None:
        truth = self.rows(20, 0.85, 0.85) + self.flagged(20, 0.85)
        self.assertEqual(self.ok(truth)[0], False)
        nan = float("nan")
        traces = self.rows(20, nan, nan, r1=0.95) + self.flagged(20, nan)
        self.assertEqual(self.ok(traces)[2], False)

    def test_a_lost_cell_without_reference_truth_counts_in_rules_2_and_3(self) -> None:
        rows = self.rows(25, 0.85, 0.85) + self.lost(30, float("nan"))
        gate = F.a1_gate(rows, 1.0, 1.0)
        self.assertIn("over 25 cells", gate[0][1])
        self.assertEqual(gate[0][2], True)
        self.assertEqual(gate[1][1], "loss 1.0000")
        self.assertEqual(gate[1][2], False)
        self.assertEqual(gate[2][1], "loss 1.0000")
        self.assertIsNone(gate[2][2])

    def test_a_fifth_percentile_exactly_at_the_limit_passes(self) -> None:
        rows = self.rows(22, 0.85, 0.85) + self.rows(3, 0.85, 0.80)
        gate = F.a1_gate(rows, 1.0, 1.0)
        self.assertIn("5th pct -0.0500", gate[0][1])
        self.assertEqual(gate[0][2], True)

    def test_a_missing_jump_or_no_cells_fail(self) -> None:
        rows = self.rows(25, 0.85, 0.85)
        self.assertEqual(self.ok(rows, 1.0, float("nan"))[3], False)
        self.assertFalse(F.a1_passes(F.a1_gate([], 1.0, 1.0)))


class TraceGap(unittest.TestCase):
    def test_gap_is_the_largest_difference_in_units_of_the_first_traces_sd(
        self,
    ) -> None:
        a = np.array([0.0, 2.0, 0.0, 2.0], dtype=np.float32)  # sd 1
        bump = np.array([0.0, 0.5, 0.0, 0.0], dtype=np.float32)
        flat = np.zeros(4, dtype=np.float32)
        gap = F.trace_gap(
            {1: a, 2: a, 3: flat, 5: a}, {1: a + bump, 2: a, 3: flat + 1, 4: a}
        )
        self.assertAlmostEqual(gap[1], 0.5)
        self.assertEqual(gap[2], 0.0)
        self.assertTrue(math.isnan(gap[3]), "a constant first trace has no sd")
        self.assertEqual(sorted(gap), [1, 2, 3], "only cells of both runs")

    def test_traces_of_different_length_compare_over_the_common_part(self) -> None:
        a = np.array([0.0, 2.0, 0.0, 2.0, 9.0], dtype=np.float32)
        gap = F.trace_gap({1: a[:4]}, {1: a})
        self.assertEqual(gap[1], 0.0)


class EngineReport(unittest.TestCase):
    def test_report_counts_cells_without_a_centroid_and_states_the_footprints(
        self,
    ) -> None:
        # Cell 13 has traces but no footprint, so no centroid.
        ref = {7: TRACES[7], 9: TRACES[9], 13: TRACES[11]}
        test = {7: TRACES[7], 9: [v + 0.5 for v in TRACES[9]], 13: TRACES[11]}
        sd = float(np.std(np.asarray(TRACES[9], "<f4")))
        cells = {7: CELLS[7], 9: CELLS[9]}
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d) / "ref", Path(d) / "test"
            write_run(a, cells, ref)
            write_run(b, cells, test)
            text = F.engine_report(a, b, band=16.0)
            self.assertIn("same footprints: yes", text)
            self.assertIn("| all cells | 3 |", text)
            self.assertIn(f"{0.5 / sd:.4f} |", text)
            (b / "footprints.bin").write_bytes(
                b"x" + (a / "footprints.bin").read_bytes()
            )
            self.assertIn("same footprints: no", F.engine_report(a, b))

    def test_report_splits_cells_by_valid_share_when_the_file_is_there(self) -> None:
        ref = {7: TRACES[7], 9: TRACES[9], 13: TRACES[11]}
        test = {7: TRACES[7], 9: [v + 0.5 for v in TRACES[9]], 13: TRACES[11]}
        cells = {7: CELLS[7], 9: CELLS[9]}
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d) / "ref", Path(d) / "test"
            write_run(a, cells, ref)
            write_run(b, cells, test)
            plain = F.engine_report(a, b)
            self.assertNotIn("min_valid", plain)
            (b / "extract_min_valid.tsv").write_text(
                "id\tmin_valid\n7\t1.0000\n9\t0.7500\n13\t1.0000\n"
            )
            text = F.engine_report(a, b)
            sd = float(np.std(np.asarray(TRACES[9], "<f4")))
            self.assertIn(f"| min_valid below 1 | 1 | {0.5 / sd:.4f} |", text)
            self.assertIn("| min_valid equal to 1 | 2 | 0.0000 |", text)
            self.assertIn("never present in a window is stored as 0", text)


if __name__ == "__main__":
    unittest.main()
