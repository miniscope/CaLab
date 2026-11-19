"""Tests for factor_arms.py: `python -m unittest discover tools/cala-eval`."""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import factor_arms as A
from test_factor_closeness import write_fp

FLAT_HEAD = (
    "frame\toutcome\tfirst\tbins\tframes_used\tgain_sd\ttissue_sd\tresidual\tdark"
    "\tchange_median\tchange_p99\tchange_max\tsolve_s\n"
)
FLAT_SKIPPED = "4199\tskipped: too little motion" + "\t" * 10 + "0.01\n"
FLAT_TSV = (
    FLAT_HEAD
    + "2999\tupdated\t1\t12\t2400\t0.05000\t0.10000\t1.000e-3\t4.500\t0.1\t0.2\t0.3\t0.50\n"
    + FLAT_SKIPPED
    + "5399\tupdated\t0\t14\t4800\t0.04000\t0.10000\t1.000e-3\t4.750\t0.1\t0.2\t0.3\t0.40\n"
)
FLAT_TSV_NONE = FLAT_HEAD + FLAT_SKIPPED


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
        self.assertEqual(
            sorted(set(a) - set(A.default_arms(a))),
            sorted(
                list(A.REMEDIES)
                + ["live", "lb_raw", "lb_fac", "lb_live", "f_chosen", "f_null"]
                + ["lb_null_s1", "lb_null_s2"]
            ),
        )

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

    def test_existing_arms_keep_their_flags_token_for_token(self) -> None:
        # A finished long run is skipped only when its stored command equals the current one.
        for args, passes in (((5,), "6"), ((2, 3000000), "3")):
            a = A.arms(*args)
            raw = ["--passes", passes, "--later-passes", "refine", "--extract-pass"]
            chosen = raw + ["--replay-source", "factors", "--tiling", "offset"]
            chosen += ["--factors-pass", "2"]
            self.assertEqual(a["raw"], raw)
            self.assertEqual(a["chosen"], chosen)
            self.assertEqual(a["c_chosen"], chosen + ["--extract-engine", "factors"])

    def test_the_factor_refine_arms_flags_are_pinned(self) -> None:
        for budget in (A.DEFAULT_BUDGET, 3000000):
            a = A.arms(5, budget)
            f = [
                *["--passes", "2", "--later-passes", "refine", "--extract-pass"],
                *["--replay-source", "factors", "--tiling", "offset"],
                *["--factors-pass", "2", "--extract-engine", "factors"],
                *["--refine-engine", "factors"],
            ]
            self.assertEqual(a["f_chosen"], f)
            self.assertEqual(a["f_null"], f + ["--later-budget", str(budget * 2)])
        # Its own pass count, whatever --refine says.
        self.assertEqual(A.arms(2)["f_chosen"], A.arms(7)["f_chosen"])

    def test_the_factor_refine_arms_meet_the_harness_rules(self) -> None:
        a = A.arms(5)
        for name in ("f_chosen", "f_null"):
            cmd = A.command(
                Path("qc"), Path("rec"), Path("out") / name, a[name], True, None
            )
            self.assertEqual(cmd[cmd.index("--factors-out") + 1], f"out/{name}/factors")
            self.assertEqual(cmd.count("--factors-out"), 1)
            self.assertEqual(cmd[cmd.index("--passes") + 1], "2")
            self.assertEqual(cmd[cmd.index("--factors-pass") + 1], "2")
            self.assertEqual(cmd[cmd.index("--later-passes") + 1], "refine")
            for refused in (
                "--offered-fps",
                "--joint-update",
                "--lookback",
                "--catchup",
            ):
                self.assertNotIn(refused, cmd)
        # Not in the default set: runs started with today's options do not gain them.
        self.assertNotIn("f_chosen", A.default_arms(a))
        self.assertNotIn("f_null", A.default_arms(a))
        self.assertEqual(A.line_step(a["f_chosen"]), 32)

    def test_extra_with_a_factor_refine_flag_is_refused_for_every_arm(self) -> None:
        for flag in A.FACTOR_REFINE_FLAGS:
            with self.assertRaisesRegex(ValueError, "factor Refine arms"):
                A.command(
                    Path("qc"),
                    Path("rec"),
                    Path("out/raw"),
                    A.arms(5)["raw"],
                    True,
                    None,
                    None,
                    [flag, "2"],
                )
        # Other extras still pass.
        cmd = A.command(
            Path("qc"),
            Path("rec"),
            Path("out/raw"),
            A.arms(5)["raw"],
            True,
            None,
            None,
            ["--joint-iters", "3"],
        )
        self.assertEqual(cmd[-2:], ["--joint-iters", "3"])

    def test_the_factor_folder_follows_the_refine_engine_flag_too(self) -> None:
        cmd = A.command(
            Path("qc"),
            Path("rec"),
            Path("out/x"),
            ["--refine-engine", "factors"],
            False,
            None,
        )
        self.assertEqual(cmd[cmd.index("--factors-out") + 1], "out/x/factors")

    def test_live_arms_use_discovers_own_factors(self) -> None:
        a = A.arms(5)
        self.assertEqual(
            a["live"],
            a["raw"]
            + ["--replay-source", "factors", "--tiling", "offset"]
            + ["--extract-engine", "factors"],
        )
        for n in ("live", "lb_fac", "lb_live"):
            self.assertNotIn("--factors-pass", a[n], f"{n}: the factors are pass 1's")
        self.assertEqual(A.line_step(a["live"]), 32)

    def test_look_back_arms_are_mains_default_with_extract(self) -> None:
        a = A.arms(5)
        self.assertEqual(
            a["lb_raw"],
            ["--passes", "1", "--joint-update", "all", "--joint-sign", "all"]
            + ["--lookback", "2", "--lookback-drain", "4800", "--extract-pass"],
        )
        self.assertEqual(
            a["lb_fac"],
            a["lb_raw"] + ["--lookback-source", "factors", "--tiling", "offset"],
        )
        self.assertEqual(
            a["lb_live"],
            a["lb_fac"] + ["--replay-source", "factors", "--extract-engine", "factors"],
        )
        cmd = A.command(
            Path("qc"), Path("rec"), Path("out/lb_fac"), a["lb_fac"], True, 100
        )
        self.assertEqual(cmd[cmd.index("--factors-out") + 1], "out/lb_fac/factors")
        cmd = A.command(
            Path("qc"), Path("rec"), Path("out/lb_raw"), a["lb_raw"], True, 100
        )
        self.assertNotIn("--factors-out", cmd)

    def test_look_back_nulls_are_lb_raw_with_another_slow_loop_seed(self) -> None:
        for a in (A.arms(5), A.arms(5, 3_000_000)):
            self.assertEqual(a["lb_null_s1"], a["lb_raw"] + ["--slow-seed", "1"])
            self.assertEqual(a["lb_null_s2"], a["lb_raw"] + ["--slow-seed", "2"])
        a = A.arms(5, 3_000_000)
        # The same budget as the reference: a repeat, not a slower or faster machine.
        null = A.command(
            Path("qc"), Path("rec"), Path("o"), a["lb_null_s1"], True, 100, 7
        )
        raw = A.command(Path("qc"), Path("rec"), Path("o"), a["lb_raw"], True, 100, 7)
        self.assertEqual(null[-2:], ["--budget", "7"])
        self.assertEqual([t for t in null if t not in raw], ["--slow-seed"])
        with self.assertRaisesRegex(ValueError, "--slow-seed"):
            A.command(
                Path("qc"),
                Path("rec"),
                Path("o"),
                a["lb_null_s2"],
                True,
                100,
                extra=["--slow-seed", "9"],
            )

    def test_extra_repeating_a_look_back_arms_joint_flags_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "--joint-update"):
            A.command(
                Path("qc"),
                Path("rec"),
                Path("out/lb_raw"),
                A.arms(5)["lb_raw"],
                True,
                None,
                extra=["--joint-update", "all"],
            )

    def test_seeded_arms_read_the_seed_runs_flat_field(self) -> None:
        seed = Path("out") / "seed"
        a = A.arms(5, seed=(12000, seed))
        self.assertEqual(a["seed"], ["--passes", "1", "--from", "12000"])
        self.assertEqual(a["raw_seed"], a["raw"] + ["--ff-seed-run", str(seed)])
        self.assertEqual(a["live_seed"], a["live"] + ["--ff-seed-run", str(seed)])
        self.assertNotIn("seed", A.arms(5))
        self.assertEqual(
            A.run_order(["raw", "live_seed", "seed", "raw_seed"]),
            (["seed"], ["raw", "live_seed", "raw_seed"]),
        )

    def test_report_compares_each_live_arm_with_its_reference(self) -> None:
        a = A.arms(5, seed=(12000, Path("out") / "seed"))
        names = ["raw", "live", "raw_seed", "live_seed", "lb_raw", "lb_fac", "lb_live"]
        with tempfile.TemporaryDirectory() as t:
            out = Path(t)
            for n in names:
                (out / n).mkdir()
                rec = {"arm": n, "cmd": ["qc"] + a[n], "returncode": 0, "wall_s": 1.0}
                (out / n / "run.json").write_text(json.dumps(rec))
            seen: dict[str, tuple[str, bool]] = {}

            def fake(ref: Path, test: Path, nulls: list[Path], **kw: object) -> str:
                seen[test.name] = (ref.name, bool(kw.get("match", False)))
                return ""

            with mock.patch.object(A.factor_closeness, "report", fake):
                A.report(out, names, None)
        self.assertEqual(
            seen,
            {
                "live": ("raw", False),
                "raw_seed": ("raw", True),
                "live_seed": ("raw_seed", False),
                "lb_fac": ("lb_raw", True),
                "lb_live": ("lb_raw", True),
            },
        )

    def test_look_back_comparisons_are_judged_against_the_look_back_nulls(self) -> None:
        a = A.arms(5)
        names = ["raw", "null_lo", "live", "lb_raw", "lb_fac", "lb_live", "lb_null_s2"]
        with tempfile.TemporaryDirectory() as t:
            out = Path(t)
            for n in names:
                (out / n).mkdir()
                rec = {"arm": n, "cmd": ["qc"] + a[n], "returncode": 0, "wall_s": 1.0}
                (out / n / "run.json").write_text(json.dumps(rec))
            seen: dict[str, list[str]] = {}

            def fake(ref: Path, test: Path, nulls: list[Path], **kw: object) -> str:
                seen[test.name] = [p.name for p in nulls]
                return ""

            with mock.patch.object(A.factor_closeness, "report", fake):
                A.report(out, names, None)
        # A null run is never a test run, and each comparison gets the nulls of its kind.
        self.assertEqual(
            seen,
            {"live": ["null_lo"], "lb_fac": ["lb_null_s2"], "lb_live": ["lb_null_s2"]},
        )

    def test_flat_field_and_look_back_rows(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            run = Path(t) / "live_seed"
            run.mkdir()
            cmd = {"cmd": ["qc", "--ff-seed-run", "s"]}
            (run / "run.json").write_text(json.dumps(cmd))
            (run / "flat_field_updates.tsv").write_text(FLAT_TSV)
            self.assertEqual(A.flat_row(run), ("live_seed", 2, "2999", True))
            line = A.seed_line(run)
            assert line is not None
            self.assertIn(
                "made at its frame 5399, 4800 frames used, gain sd 0.04000, dark 4.750",
                line,
            )
            (run / "lookback.tsv").write_text(
                "rate\tmax_frames\tcatchup\tdouble\tframes\tpushed\tcell_frames\tbirths"
                "\tin_need\twall_s\tdrain_steps\tdrain_frames\n"
                "2\t3000\t0\t0\t24000\t23000\t510000\t140\t3\t812.500\t900\t1800\n"
                "\ntenth\tframes\tcell_frames\n0\t10\t20\n"
            )
            self.assertEqual(
                A.lookback_row(run), ("live_seed", 24000, 510000, 3, 812.5)
            )
            self.assertIsNone(A.lookback_row(Path(t) / "missing"))
            self.assertIsNone(A.flat_row(Path(t) / "missing"))

    def test_a_seed_run_without_a_map_is_said_so_and_holds_the_seeded_arms(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as t:
            seed = Path(t) / "seed"
            seed.mkdir()
            self.assertFalse(A.seed_has_map(seed))
            (seed / "flat_field_updates.tsv").write_text(FLAT_TSV_NONE)
            self.assertFalse(A.seed_has_map(seed))
            line = A.seed_line(seed)
            assert line is not None
            self.assertIn("made no flat field map", line)
            (seed / "flat_field_updates.tsv").write_text(FLAT_TSV)
            self.assertTrue(A.seed_has_map(seed))
        self.assertEqual(
            A.hold_seeded(["raw", "raw_seed", "live_seed", "lb_raw"]),
            (["raw", "lb_raw"], ["raw_seed", "live_seed"]),
        )

    def test_the_report_says_when_the_seeded_arms_were_not_run(self) -> None:
        a = A.arms(5, seed=(12000, Path("out") / "seed"))
        with tempfile.TemporaryDirectory() as t:
            out = Path(t)
            (out / "seed").mkdir()
            rec = {"arm": "seed", "cmd": ["qc"] + a["seed"], "returncode": 0}
            (out / "seed" / "run.json").write_text(json.dumps({**rec, "wall_s": 1.0}))
            (out / "seed" / "flat_field_updates.tsv").write_text(FLAT_TSV_NONE)
            text = A.report(out, ["seed", "raw_seed", "live_seed"], None)
        self.assertIn("made no flat field map", text)
        self.assertIn("raw_seed, live_seed: not run", text)

    def test_a_redone_seed_reruns_the_seeded_arms_that_were_finished(self) -> None:
        a = A.arms(5, seed=(12000, Path("out") / "seed"))
        names = ["raw", "live_seed", "seed", "raw_seed"]
        cmds = {n: ["qc"] + a[n] for n in names}
        with tempfile.TemporaryDirectory() as t:
            out = Path(t)
            for n in names:
                (out / n).mkdir()
                rec = {"arm": n, "cmd": cmds[n], "returncode": 0, "wall_s": 1.0}
                (out / n / "run.json").write_text(json.dumps(rec))
            self.assertEqual(A.pending(out, names, cmds), [])
            (out / "seed" / "run.json").unlink()
            todo = A.pending(out, names, cmds)
            self.assertEqual(todo, ["live_seed", "seed", "raw_seed"])
            self.assertEqual(A.run_order(todo)[0], ["seed"])
            # only the seeded arms asked for
            self.assertEqual(
                A.pending(out, ["seed", "raw_seed"], cmds), ["seed", "raw_seed"]
            )

    def test_run_order_with_a_partial_todo(self) -> None:
        self.assertEqual(
            A.run_order(["raw_seed", "lb_raw"]), ([], ["raw_seed", "lb_raw"])
        )
        self.assertEqual(A.run_order(["seed"]), (["seed"], []))
        self.assertEqual(A.run_order([]), ([], []))

    def test_dry_run_prints_the_seed_arms_in_order(self) -> None:
        argv = ["factor_arms.py", "--rec", "rec", "--out", "out", "--qc-eval", "qc"]
        argv += [
            "--arms",
            "seed,raw_seed,live_seed",
            "--seed-from",
            "9000",
            "--frames",
            "8000",
            "--dry-run",
        ]
        buf = io.StringIO()
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(buf):
            A.main()
        lines = buf.getvalue().splitlines()
        self.assertEqual(
            [ln.split()[3] for ln in lines],
            ["out/seed", "out/raw_seed", "out/live_seed"],
        )
        self.assertIn("--from 9000", lines[0])
        self.assertTrue(all("--ff-seed-run out/seed" in ln for ln in lines[1:]))

    def test_seed_from_is_refused_without_motion_or_without_a_seed_arm(self) -> None:
        base = ["factor_arms.py", "--rec", "rec", "--out", "out", "--dry-run"]
        for extra in (
            ["--seed-from", "9", "--frames", "5", "--no-motion", "--arms", "seed"],
            ["--seed-from", "9", "--frames", "5", "--arms", "raw,live"],
            ["--seed-from", "9", "--frames", "5"],
        ):
            with (
                mock.patch.object(sys, "argv", base + extra),
                contextlib.redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit),
            ):
                A.main()

    def test_the_report_tables_and_not_run_lines(self) -> None:
        a = A.arms(5, seed=(12000, Path("out") / "seed"))

        def write(out: Path, n: str, files: dict[str, str]) -> None:
            (out / n).mkdir()
            rec = {"arm": n, "cmd": ["qc"] + a[n], "returncode": 0, "wall_s": 1.0}
            (out / n / "run.json").write_text(json.dumps(rec))
            for f, body in files.items():
                (out / n / f).write_text(body)

        lb = (
            "rate\tmax_frames\tcatchup\tdouble\tframes\tpushed\tcell_frames\tbirths"
            "\tin_need\twall_s\tdrain_steps\tdrain_frames\n"
            "2\t3000\t0\t0\t24000\t23000\t510000\t140\t3\t812.500\t900\t1800\n"
        )

        def fake(ref: Path, test: Path, nulls: list[Path], **kw: object) -> str:
            gate, title = kw.get("gate", True), kw.get("title")
            return f"CMP {test.name} gate={gate} title={title}"

        with (
            tempfile.TemporaryDirectory() as t,
            mock.patch.object(A.factor_closeness, "report", fake),
        ):
            out = Path(t)
            write(out, "raw", {})
            write(out, "seed", {"flat_field_updates.tsv": FLAT_TSV})
            write(out, "raw_seed", {"flat_field_updates.tsv": FLAT_TSV})
            write(out, "live_seed", {})
            write(out, "lb_raw", {"lookback.tsv": lb})
            text = A.report(
                out, ["raw", "seed", "raw_seed", "live_seed", "lb_raw"], None
            )
            # One heading, made by the comparison; no gate verdict for the not-a-gate pair.
            self.assertIn(
                "CMP raw_seed gate=False title=### `raw_seed` against `raw`", text
            )
            self.assertIn("what the seed alone changes", text)
            self.assertIn("(not a gate)", text)
            self.assertNotIn("###", text.replace("title=###", ""))
            self.assertIn("CMP live_seed gate=True title=None", text)
            self.assertIn("Seed: the last flat field map", text)
            self.assertIn("| arm | seeded | flat field maps made", text)
            self.assertIn("| lb_raw | 24000 | 510000 | 3 | 812.5 |", text)
            self.assertNotIn("not run", text)
        with tempfile.TemporaryDirectory() as t:
            out = Path(t)
            write(out, "raw", {})
            write(out, "seed", {"flat_field_updates.tsv": FLAT_TSV_NONE})
            text = A.report(out, ["raw", "seed", "raw_seed", "live_seed"], None)
            self.assertIn(
                "raw_seed, live_seed: not run (the seed run made no flat field map)",
                text,
            )
        with tempfile.TemporaryDirectory() as t:
            out = Path(t)
            write(out, "raw", {})
            text = A.report(out, ["raw", "seed", "raw_seed"], None)
            self.assertIn("seed run did not finish", text)

    def test_iteration_table_reads_iterations_tsv(self) -> None:
        head = (
            "iteration\tversion\tcells\taccepted\tchanged_share\tmedian_change\tlow_valid"
            "\ttiles_skipped\tread_s\tsums_s\ttest_s\tgate_s\tpublish_s\twall_s\tsettled\n"
        )
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "f_chosen"
            run.mkdir()
            (run / "iterations.tsv").write_text(
                head
                + "1\t9\t100\t40\t0.21000\t0.004000\t3\t0\t1.00\t5.00\t1.00\t2.00\t0.10\t9.10\t-\n"
                + "2\t10\t100\t12\t0.01000\t0.000500\t3\t0\t1.00\t5.00\t1.00\t2.00\t0.10\t8.10\tsettled\n"
            )
            # No library files: the median of the changed cells is n/a, and the
            # harness's all-cell median is not printed.
            t = A.iteration_table(run)
            self.assertIn(
                "| 2 | 100 | 12 | 0.01000 | n/a | 3 | 0 | 8.10 |", "\n".join(t)
            )
            self.assertNotIn("0.000500", "\n".join(t))
            self.assertIn("median 1 - r of changed cells", "\n".join(t))
            self.assertNotIn("median change", "\n".join(t))
            self.assertIn("Stopped: settled.", t)
            # With libraries: iteration 2 moved the one cell by a pixel (1 - r = 20/19).
            cell = ([10, 11, 12], [1.0, 3.0, 1.0])
            write_fp(run / "footprints_pass2.bin", {1: cell})
            write_fp(run / "footprints_iter1.bin", {1: cell})
            write_fp(run / "footprints_iter2.bin", {1: ([11, 12, 13], [1.0, 3.0, 1.0])})
            joined = "\n".join(A.iteration_table(run))
            self.assertIn("| 1 | 100 | 40 | 0.21000 | n/a | 3 | 0 | 9.10 |", joined)
            self.assertIn("| 2 | 100 | 12 | 0.01000 | 1.05263 | 3 | 0 | 8.10 |", joined)
            (run / "iterations.tsv").write_text(head)
            self.assertTrue(any("no iterations" in ln for ln in A.iteration_table(run)))
            t = A.iteration_table(Path(d) / "missing")
            self.assertEqual(len(t), 2)
            self.assertIn("n/a", t[0])

    def test_report_adds_the_settle_and_iteration_tables_for_the_factor_refine_arm(
        self,
    ) -> None:
        a = A.arms(5)

        def write(out: Path, n: str, files: dict[str, bytes]) -> None:
            (out / n).mkdir()
            rec = {"arm": n, "cmd": ["qc"] + a[n], "returncode": 0, "wall_s": 1.0}
            (out / n / "run.json").write_text(json.dumps(rec))
            for f, body in files.items():
                (out / n / f).write_bytes(body)

        def fake(ref: Path, test: Path, nulls: list[Path], **kw: object) -> str:
            return f"CMP {ref.name} {test.name} {len(nulls)}"

        with (
            tempfile.TemporaryDirectory() as t,
            mock.patch.object(A.factor_closeness, "report", fake),
            mock.patch.object(
                A.factor_closeness,
                "settle_table",
                lambda run, truth=None: [f"SETTLE {run.name}", ""],
            ),
        ):
            out = Path(t)
            write(out, "raw", {})
            write(out, "null_lo", {})
            # A run without the factor arm: report text as before.
            plain = A.report(out, ["raw", "null_lo"], None)
            self.assertNotIn("SETTLE", plain)
            self.assertNotIn("Refine on factors", plain)
            write(out, "f_chosen", {"footprints.bin": b"a"})
            write(out, "f_null", {"footprints.bin": b"a"})
            text = A.report(out, ["raw", "null_lo", "f_chosen", "f_null"], None)
            self.assertIn("CMP raw f_chosen 1", text)
            self.assertNotIn("CMP raw f_null", text)
            self.assertIn("SETTLE raw", text)
            self.assertIn("SETTLE f_chosen", text)
            self.assertIn("no `iterations.tsv`", text)
            self.assertIn("`f_null` repeats `f_chosen` with another later budget", text)
            self.assertIn("this is a repeat run", text)
            self.assertNotIn("speed", text)
            self.assertIn("footprints identical to `f_chosen`: yes", text)
            (out / "f_null" / "footprints.bin").write_bytes(b"b")
            text = A.report(out, ["raw", "f_chosen", "f_null"], None)
            self.assertIn("footprints identical to `f_chosen`: no", text)
            (out / "f_null" / "footprints.bin").unlink()
            text = A.report(out, ["raw", "f_chosen", "f_null"], None)
            self.assertIn("n/a", text)

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

    def test_an_extra_flag_the_command_already_has_is_refused(self) -> None:
        # qc_eval takes the first occurrence of a flag, so a repeat would be ignored.
        for extra in (
            ["--passes", "3"],
            ["--motion"],
            ["--frames", "10"],
            ["--budget", "5"],
            ["--joint-update", "all", "--extract-pass"],
        ):
            with self.assertRaisesRegex(
                ValueError, extra[-1] if len(extra) > 2 else extra[0]
            ):
                A.command(
                    Path("qc"),
                    Path("rec"),
                    Path("out/raw"),
                    A.arms(5)["raw"],
                    motion=True,
                    frames=100,
                    budget=7,
                    extra=extra,
                )

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

    def test_a_rerun_of_a_factor_refine_arm_clears_its_window_files(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            for name in ("f_chosen", "chosen"):
                (out / name / "factors").mkdir(parents=True)
                for f in ("w0.fac", "w1.fac", "factors.tsv"):
                    (out / name / "factors" / f).write_bytes(b"x")
            # `-c pass` ignores the flag and its value; only the command line matters here.
            base = [sys.executable, "-c", "pass"]
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                A.run_arm(
                    "f_chosen",
                    [*base, "--refine-engine", "factors"],
                    out / "f_chosen",
                )
                A.run_arm("chosen", base, out / "chosen")
            left = sorted(p.name for p in (out / "f_chosen" / "factors").iterdir())
            self.assertEqual(left, ["factors.tsv"])
            kept = sorted(p.name for p in (out / "chosen" / "factors").iterdir())
            self.assertEqual(kept, ["factors.tsv", "w0.fac", "w1.fac"])
            self.assertIn("removed 2 window files", buf.getvalue())
            self.assertEqual(A.clear_factor_windows(base, out / "f_chosen"), 0)

    def test_the_seed_stretch_must_come_after_the_frames_the_seeded_arms_read(
        self,
    ) -> None:
        base = ["factor_arms.py", "--rec", "rec", "--out", "out", "--dry-run"]
        base += ["--arms", "seed,raw_seed"]

        def run(extra: list[str]) -> tuple[bool, str]:
            err = io.StringIO()
            try:
                with (
                    mock.patch.object(sys, "argv", base + extra),
                    contextlib.redirect_stderr(err),
                    contextlib.redirect_stdout(io.StringIO()),
                ):
                    A.main()
            except SystemExit:
                return False, err.getvalue()
            return True, ""

        ok, msg = run(["--seed-from", "1000"])
        self.assertFalse(ok)
        self.assertIn("--frames", msg)
        ok, msg = run(["--seed-from", "1000", "--frames", "12000"])
        self.assertFalse(ok)
        self.assertIn("do not process", msg)
        ok, _ = run(["--seed-from", "11999", "--frames", "12000"])
        self.assertFalse(ok)
        ok, _ = run(["--seed-from", "12000", "--frames", "12000"])
        self.assertTrue(ok)
        ok, _ = run(["--seed-from", "13000", "--frames", "12000"])
        self.assertTrue(ok)


if __name__ == "__main__":
    unittest.main()
