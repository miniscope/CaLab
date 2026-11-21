"""Tests for suite_cache.py and the suite scheduler helpers: `python -m unittest discover tools/cala-eval`."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import demix_suite as DS
import run_arms as RA
import suite_cache as SC

ARGS = ["--passes", "2", "--later-passes", "refine", "--batch", "8", "--budget", "30000000", "--slow-seed", "1", "--dump"]


class Keys(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.t = Path(self.td.name)
        self.bin = self.t / "qc_eval"
        self.bin.write_bytes(b"binary-a")
        self.sim = self.t / "sim"
        (self.sim / "daq").mkdir(parents=True)
        (self.sim / "oracle.bin").write_bytes(b"oracle")
        (self.sim / "spec.json").write_text("{}")
        (self.sim / "daq" / "v0.bin").write_bytes(b"x" * 10)

    def tearDown(self):
        self.td.cleanup()

    def key(self, args=ARGS):
        return SC.run_key(self.bin, args, self.sim)

    def test_stable(self):
        self.assertEqual(self.key(), self.key(list(ARGS)))

    def test_every_arg_matters(self):
        base = self.key()
        keys = {base}
        for i, tok in enumerate(ARGS):
            changed = list(ARGS)
            changed[i] = tok + "1"
            keys.add(self.key(changed))
        keys.add(self.key(ARGS + ["--no-heldout"]))
        keys.add(self.key(ARGS + ["--motion"]))
        keys.add(self.key(ARGS[:-1]))
        self.assertEqual(len(keys), len(ARGS) + 4)

    def test_arg_order_matters(self):
        self.assertNotEqual(self.key(["--a", "1", "--b", "2"]), self.key(["--b", "2", "--a", "1"]))

    def test_binary_content(self):
        base = self.key()
        self.bin.write_bytes(b"binary-b")
        self.assertNotEqual(base, self.key())

    def test_binary_path_does_not_matter(self):
        other = self.t / "copy"
        other.write_bytes(self.bin.read_bytes())
        self.assertEqual(self.key(), SC.run_key(other, ARGS, self.sim))

    def test_sim_changes(self):
        base = self.key()
        (self.sim / "oracle.bin").write_bytes(b"oracle2")
        k1 = self.key()
        (self.sim / "spec.json").write_text('{"a": 1}')
        k2 = self.key()
        (self.sim / "daq" / "v0.bin").write_bytes(b"x" * 11)
        k3 = self.key()
        self.assertEqual(len({base, k1, k2, k3}), 4)

    def test_sim_location_does_not_matter(self):
        other = self.t / "sim2"
        import shutil

        shutil.copytree(self.sim, other)
        self.assertEqual(self.key(), SC.run_key(self.bin, ARGS, other))

    def test_metrics_key_depends_on_all_det(self):
        self.assertNotEqual(SC.metrics_key(True), SC.metrics_key(False))


class Store(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            t = Path(td)
            run = t / "run"
            run.mkdir()
            (run / "run.json").write_text(json.dumps({"rc": 0}))
            (run / "final.tsv").write_text("a\n")
            (run / "demix_det.json").write_text("{}")
            c = SC.SuiteCache(t / "cache")
            self.assertFalse(c.has_run("k"))
            self.assertTrue(c.store_run("k", run))
            self.assertFalse(c.store_run("k", run))  # immutable
            self.assertTrue(c.has_run("k"))
            self.assertTrue(c.store_metrics("k", "m", run))
            self.assertTrue(c.has_metrics("k", "m"))
            self.assertFalse(c.has_metrics("k", "other"))
            out = t / "out"
            c.restore_run("k", out)
            self.assertEqual((out / "final.tsv").read_text(), "a\n")
            (out / "demix_det.json").unlink()
            c.restore_metrics("k", "m", out)
            self.assertTrue((out / "demix_det.json").exists())

    def test_failed_run_not_cached(self):
        with tempfile.TemporaryDirectory() as td:
            run = Path(td) / "run"
            run.mkdir()
            (run / "run.json").write_text(json.dumps({"rc": 1}))
            c = SC.SuiteCache(Path(td) / "cache")
            self.assertFalse(c.store_run("k", run))
            self.assertFalse(c.has_run("k"))


class Scheduler(unittest.TestCase):
    def test_cap_is_single_constant(self):
        self.assertEqual(DS.MAX_PARALLEL, RA.MAX_LIGHT)

    def test_own_only_counts_suite_runs(self):
        orig = RA.light_running
        try:
            state = {"parallel": 4, "own_only": True, "own": 3}
            RA.light_running = lambda: 3  # machine-wide, includes ours
            self.assertTrue(RA.slot_free(state))
            RA.light_running = lambda: RA.MAX_LIGHT  # machine-wide cap reached
            self.assertFalse(RA.slot_free(state))
            RA.light_running = lambda: 3
            state["own"] = 4
            self.assertFalse(RA.slot_free(state))
            # default (run_arms.py) behaviour: parallel counts everyone
            self.assertFalse(RA.slot_free({"parallel": 2}))
        finally:
            RA.light_running = orig

    def test_longest_first(self):
        jobs = [{"kind": k, "n": i} for i, k in enumerate(["pairs", "static", "motion", "static", "pairs"])]
        self.assertEqual([j["kind"] for j in DS.order_jobs(jobs)], ["motion", "static", "static", "pairs", "pairs"])

    def test_tiers(self):
        self.assertEqual(DS.tier_sims("smoke", None), [("static", 5), ("pairs", 5)])


if __name__ == "__main__":
    unittest.main()
