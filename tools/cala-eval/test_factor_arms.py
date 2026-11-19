"""Tests for factor_arms.py: `python -m unittest discover tools/cala-eval`."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import factor_arms as A


class Arms(unittest.TestCase):
    def test_remedy_arms_are_plain_recal_with_another_cut_and_not_run_by_default(
        self,
    ) -> None:
        a = A.arms(5)
        self.assertEqual(
            a["recal_full"],
            a["plain_recal"] + ["--factors-rho-min", "-1", "--factors-z", "-100"],
        )
        self.assertEqual(a["recal_k80"], a["plain_recal"] + ["--factors-k0", "80"])
        self.assertEqual(
            a["recal_r40"][-8:],
            ["--factors-rho-min", "-1", "--factors-z", "-100"]
            + ["--factors-k0", "40", "--factors-max-rank", "40"],
        )
        self.assertEqual(a["recal_iter2"], a["plain_recal"] + ["--factors-n-iter", "2"])
        self.assertEqual(sorted(set(a) - set(A.default_arms(a))), sorted(A.REMEDIES))

    def test_arm_names(self) -> None:
        self.assertEqual(
            sorted(A.default_arms(A.arms(5))),
            sorted(
                [
                    "raw",
                    "null_lo",
                    "null_hi",
                    "plain",
                    "overlap8",
                    "overlap16",
                    "offset",
                    "plain_recal",
                    "chosen",
                    "c_chosen",
                ]
                + ["x_raw", "x_plain", "x_overlap8", "x_overlap16", "x_offset"]
            ),
        )

    def test_the_factor_engine_arm_differs_from_chosen_only_in_the_extract_engine(
        self,
    ) -> None:
        a = A.arms(5)
        self.assertEqual(a["c_chosen"], a["chosen"] + ["--extract-engine", "factors"])
        self.assertEqual(A.line_step(a["c_chosen"]), 32)
        self.assertIn("c_chosen", A.default_arms(a))

    def test_extract_row_reads_the_extract_stage(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "c_chosen"
            run.mkdir()
            (run / "stage_times.tsv").write_text(
                "stage\tread_s\tpre_s\tcompress_s\tsolve_s\tslow_s\twall_s\n"
                "pass1\t1.00\t2.00\t0.00\t3.00\t4.00\t11.00\n"
                "extract\t0.10\t0.20\t0.00\t0.70\t0.00\t1.10\n"
            )
            self.assertEqual(A.extract_row(run), ("c_chosen", 0.2, 0.7, 1.1))
            self.assertIsNone(A.extract_row(Path(d) / "missing"))

    def test_the_chosen_arm_is_offset_grids_on_recalibrated_factors(self) -> None:
        a = A.arms(5)
        self.assertEqual(
            a["chosen"],
            a["raw"]
            + ["--replay-source", "factors", "--tiling", "offset"]
            + ["--factors-pass", "2"],
        )
        self.assertIn("chosen", A.default_arms(a))
        self.assertEqual(
            [
                A.line_step(a[n])
                for n in ("chosen", "offset", "x_offset", "plain", "raw")
            ],
            [32, 32, 32, 64, 64],
        )
        self.assertEqual(A.line_step(["--x", "--tiling", "offset"]), 32)
        self.assertEqual(A.line_step(["--tiling", "overlap:16", "offset"]), 64)
        self.assertEqual(A.line_step(["--tiling"]), 64)

    def test_report_passes_the_line_step_of_the_arm_command(self) -> None:
        a = A.arms(5)
        with tempfile.TemporaryDirectory() as t:
            out = Path(t)
            for n in ("raw", "chosen", "plain"):
                (out / n).mkdir()
                rec = {"arm": n, "cmd": ["qc"] + a[n], "returncode": 0, "wall_s": 1.0}
                (out / n / "run.json").write_text(json.dumps(rec))
            seen: dict[str, int] = {}

            def fake(ref: Path, test: Path, nulls: list[Path], **kw: object) -> str:
                seen[test.name] = int(kw["tile"])
                return ""

            with mock.patch.object(A.factor_closeness, "report", fake):
                A.report(out, ["raw", "chosen", "plain"], None)
        self.assertEqual(seen, {"chosen": 32, "plain": 64})

    def test_raw_and_null_differ_only_in_the_later_budget(self) -> None:
        a = A.arms(5)
        self.assertEqual(
            a["raw"], ["--passes", "6", "--later-passes", "refine", "--extract-pass"]
        )
        self.assertEqual(a["null_lo"], a["raw"] + ["--later-budget", "15000000"])
        self.assertEqual(a["null_hi"], a["raw"] + ["--later-budget", "60000000"])

    def test_factor_arms_replay_from_factors_with_their_tiling(self) -> None:
        a = A.arms(5)
        self.assertEqual(
            a["overlap16"],
            a["raw"] + ["--replay-source", "factors", "--tiling", "overlap:16"],
        )
        self.assertEqual(a["plain_recal"], a["plain"] + ["--factors-pass", "2"])
        self.assertEqual(
            a["x_offset"],
            [
                "--passes",
                "1",
                "--extract-pass",
                "--replay-source",
                "factors",
                "--tiling",
                "offset",
            ],
        )
        self.assertEqual(a["x_raw"], ["--passes", "1", "--extract-pass"])

    def test_command_adds_the_factor_folder_inside_the_run(self) -> None:
        cmd = A.command(
            Path("qc"),
            Path("rec"),
            Path("out/plain"),
            A.arms(5)["plain"],
            motion=True,
            frames=6000,
        )
        self.assertEqual(cmd[:4], ["qc", "real", "rec", "out/plain"])
        self.assertIn("--motion", cmd)
        self.assertEqual(cmd[cmd.index("--frames") + 1], "6000")
        self.assertEqual(cmd[cmd.index("--factors-out") + 1], "out/plain/factors")

    def test_extra_flags_end_every_command(self) -> None:
        cmd = A.command(
            Path("qc"),
            Path("rec"),
            Path("out/raw"),
            A.arms(5)["raw"],
            motion=False,
            frames=None,
            extra=["--joint-update", "all"],
        )
        self.assertEqual(cmd[-2:], ["--joint-update", "all"])

    def test_raw_command_has_no_factor_folder(self) -> None:
        cmd = A.command(
            Path("qc"),
            Path("rec"),
            Path("out/raw"),
            A.arms(5)["raw"],
            motion=False,
            frames=None,
        )
        self.assertNotIn("--factors-out", cmd)
        self.assertNotIn("--motion", cmd)
        self.assertNotIn("--frames", cmd)

    def test_cost_table_reads_factors_tsv(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "plain"
            (run / "factors").mkdir(parents=True)
            (run / "factors" / "factors.tsv").write_text(
                "start\tframes\ttiles\tmean_rank\tkept\tbytes\tcompress_s\n"
                "0\t600\t100\t30.00\t0.50000\t60000000\t3.000\n"
                "600\t600\t100\t34.00\t0.50000\t60000000\t3.000\n"
            )
            self.assertEqual(A.cost_row(run), ("plain", 32.0, 100.0, 5.0))
            self.assertIsNone(A.cost_row(Path(d) / "raw"))

    def test_peak_memory_is_read_from_the_time_lines(self) -> None:
        log = (
            "pass 1 done\n        2.31 real\n  1234567890  maximum resident set size\n"
        )
        self.assertAlmostEqual(A.max_rss_mb(log), 1234.56789)
        self.assertIsNone(A.max_rss_mb("no time output"))

    def test_budget_sets_the_null_arms_and_the_command(self) -> None:
        a = A.arms(5, 3_000_000)
        self.assertEqual(a["null_lo"], a["raw"] + ["--later-budget", "1500000"])
        self.assertEqual(a["null_hi"], a["raw"] + ["--later-budget", "6000000"])
        self.assertEqual(a["raw"], A.arms(5)["raw"])
        cmd = A.command(
            Path("qc"),
            Path("rec"),
            Path("out/raw"),
            a["raw"],
            motion=True,
            frames=100,
            budget=3_000_000,
        )
        self.assertEqual(cmd[-2:], ["--budget", "3000000"])
        self.assertNotIn(
            "--budget",
            A.command(
                Path("qc"),
                Path("rec"),
                Path("out/raw"),
                a["raw"],
                motion=True,
                frames=100,
            ),
        )

    def test_an_arm_finished_with_another_command_is_not_done(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "raw"
            run.mkdir()
            self.assertFalse(A.done(run))
            (run / "run.json").write_text(
                '{"arm": "raw", "cmd": ["qc", "a"], "returncode": 0, "wall_s": 1.0}'
            )
            self.assertTrue(A.done(run))
            self.assertTrue(A.done(run, ["qc", "a"]))
            self.assertFalse(A.done(run, ["qc", "a", "--budget", "3000000"]))
            (run / "run.json").write_text(
                '{"arm": "raw", "cmd": ["qc", "a"], "returncode": 1, "wall_s": 1.0}'
            )
            self.assertFalse(A.done(run, ["qc", "a"]))
            (run / "run.json").write_text('{"arm": "raw", "cm')
            self.assertFalse(A.done(run))

    def test_a_rerun_drops_the_old_run_record_before_it_starts(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "raw"
            run.mkdir()
            old = run / "run.json"
            old.write_text('{"arm": "raw", "cmd": ["qc", "a"], "returncode": 0}')
            # The command fails while the old record is still there.
            check = (
                "import pathlib, sys; sys.exit(int(pathlib.Path(sys.argv[1]).exists()))"
            )
            rc = A.run_arm("raw", [sys.executable, "-c", check, str(old)], run)
            self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
