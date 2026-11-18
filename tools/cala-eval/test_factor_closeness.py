"""Tests for factor_closeness.py: `python -m unittest discover tools/cala-eval`."""

import math
import struct
import sys
import tempfile
import unittest
from pathlib import Path

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

    def test_report_judges_against_a_null_run(self) -> None:
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", CELLS, TRACES)
        noise = 0.05 * np.cos(np.arange(200) * 1.7)
        noisy = {c: list(np.asarray(TRACES[c]) + noise) for c in TRACES}
        write_run(self.root / "n", CELLS, noisy)
        text = F.report(self.root / "a", self.root / "b", [self.root / "n"])
        self.assertIn("| within |", text)
        write_run(
            self.root / "c", {7: CELLS[7], 9: CELLS[9]}, {7: TRACES[7], 9: TRACES[9]}
        )
        text = F.report(self.root / "a", self.root / "c", [self.root / "n"])
        self.assertIn("| dropped cells |", text)


if __name__ == "__main__":
    unittest.main()
