import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_arms as RA  # noqa: E402

BASE = ["--batch", "8", "--slow-seed", "1", "--dump"]


def job(label, extra, sim="s5", binary="/b/qc"):
    return {"label": label, "bin": Path(binary), "sim": Path(sim), "out": Path(f"/o/{label}/{sim}"), "args": RA.merge_args(BASE, extra)}


class BranchGroups(unittest.TestCase):
    def test_tail_only_difference_groups(self):
        a = job("a", ["--passes", "2", "--later-passes", "refine"])
        b = job("b", ["--passes", "1", "--lookback-drain", "100"])
        groups, rest = RA.branch_groups([a, b], "discover")
        self.assertEqual([len(g) for g in groups], [2])
        self.assertEqual(rest, [])

    def test_prefix_difference_does_not_group(self):
        a = job("a", ["--passes", "2"])
        b = job("b", ["--passes", "2", "--budget", "5"])
        groups, rest = RA.branch_groups([a, b], "discover")
        self.assertEqual(groups, [])
        self.assertEqual(len(rest), 2)

    def test_other_sim_or_binary_does_not_group(self):
        jobs = [job("a", []), job("b", [], sim="s6"), job("c", [], binary="/b/other")]
        self.assertEqual(RA.branch_groups(jobs, "discover")[0], [])

    def test_drain_point_needs_equal_drain_flags(self):
        a = job("a", ["--lookback-drain", "100", "--passes", "1"])
        b = job("b", ["--lookback-drain", "100", "--passes", "2"])
        c = job("c", ["--lookback-drain", "0", "--passes", "2"])
        groups, rest = RA.branch_groups([a, b, c], "drain")
        self.assertEqual([sorted(j["label"] for j in g) for g in groups], [["a", "b"]])
        self.assertEqual([j["label"] for j in rest], ["c"])

    def test_off(self):
        self.assertEqual(RA.branch_groups([job("a", []), job("b", ["--passes", "2"])], "off")[0], [])


if __name__ == "__main__":
    unittest.main()
