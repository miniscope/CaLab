"""Tests for stage_times.py: `python -m unittest discover tools/cala-eval`."""

import json
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stage_times as S


def write_export(path: Path, stages: list[dict]) -> None:
    meta = json.dumps({"stages": stages}).encode()
    np.savez(path, meta_json=np.frombuffer(meta, np.uint8))


class StageTimes(unittest.TestCase):
    def test_seconds_and_frames_per_second(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cala-export.npz"
            write_export(
                p,
                [
                    {
                        "stage": "discover",
                        "index": 1,
                        "started_at": "2026-11-17T10:00:00.000Z",
                        "ended_at": "2026-11-17T10:02:00.000Z",
                        "outcome": "done",
                        "frames": 24000,
                        "cells": 300,
                    },
                    {
                        "stage": "refine",
                        "index": 1,
                        "started_at": "2026-11-17T10:02:00.500Z",
                        "ended_at": "2026-11-17T10:03:30.500Z",
                        "outcome": "done",
                        "frames": 24000,
                        "cells": 300,
                    },
                ],
            )
            rows = S.stages(p)
            self.assertEqual([r["stage"] for r in rows], ["discover", "refine"])
            self.assertAlmostEqual(rows[0]["seconds"], 120.0)
            self.assertAlmostEqual(rows[0]["fps"], 200.0)
            self.assertAlmostEqual(rows[1]["seconds"], 90.0)

    def test_a_stage_that_never_ended_is_listed_without_a_time(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.npz"
            write_export(
                p,
                [
                    {
                        "stage": "extract",
                        "index": 1,
                        "started_at": "2026-11-17T10:00:00Z",
                        "ended_at": None,
                        "outcome": "running",
                        "frames": 0,
                        "cells": 5,
                    }
                ],
            )
            rows = S.stages(p)
            self.assertTrue(np.isnan(rows[0]["seconds"]))
            self.assertIn("extract", S.table(p))

    def test_an_export_without_stages_gives_an_empty_table(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "old.npz"
            np.savez(p, meta_json=np.frombuffer(b"{}", np.uint8))
            self.assertEqual(S.stages(p), [])
            self.assertIn("no stage records", S.table(p))

    def test_an_export_without_meta_json_gives_an_empty_table(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x_cala_cadecon.npz"
            np.savez(p, traces=np.zeros((2, 3), np.float32), cell_ids=np.arange(2))
            self.assertEqual(S.stages(p), [])
            self.assertIn("no stage records", S.table(p))

    def test_a_trailing_z_is_read_as_utc(self) -> None:
        stamp = S.parse("2026-11-17T10:00:00.500Z")
        self.assertEqual(stamp.utcoffset(), timedelta(0))
        self.assertEqual(stamp.microsecond, 500000)


if __name__ == "__main__":
    unittest.main()
