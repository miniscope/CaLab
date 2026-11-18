"""Tests for factor_arms.py: `python -m unittest discover tools/cala-eval`."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import factor_arms as A


class Arms(unittest.TestCase):
    def test_arm_names(self) -> None:
        self.assertEqual(
            sorted(A.arms(5)),
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
                ]
                + ["x_raw", "x_plain", "x_overlap8", "x_overlap16", "x_offset"]
            ),
        )

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


if __name__ == "__main__":
    unittest.main()
