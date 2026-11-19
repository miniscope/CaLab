# cala factor pipeline, phase 4a: what a live run may claim

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, against gate A1, what a live run's results are worth when no pass over a raw file is possible: (a) Extract and the refine replays on the factors that Discover itself wrote, with and without a flat field seed from an earlier session of the same sensor; (b) main's look-back reading those factors instead of the raw file.

**Architecture:** Measurement only, in the native harness (`crates/cala/examples/qc_eval.rs`) and the Python tools (`tools/cala-eval`). Three small additions to the harness: `--from F` starts the stream at frame F of a recording, so a later stretch of the same recording can stand in for an earlier session; `--ff-seed-run DIR` seeds the online flat field with what an earlier run ended with, as the app stores it per device; `--lookback-source factors` makes main's look-back prototype rebuild past frames from the factor windows written so far in pass 1 instead of reading and preprocessing raw frames. The tools get cell pairing by footprint (look-back changes Discover, so cell ids no longer correspond), the footprint correlation with the truth, and the arms of this phase. No library or app code changes.

**Tech Stack:** Rust (crate `calab-cala`, example `qc_eval`), Python 3 with numpy (`tools/cala-eval`).

**Spec:** `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md`: §3 "Factor store", Amendment 1 (A1 the gate, A4 calibration of the factors, A7 flat field seed and missing samples), Amendment 2 (A9 look-back, A11 phases, A12 open points). Builds on the phase 2 plan `docs/superpowers/plans/2026-11-18-cala-factor-phase2.md`.

**Precondition:** phase 2 is complete on `feat/cala-factor-extract` (its gate runs may still be running; they use the release binary, see Global Constraints). This plan uses these names from phases 0 to 2: `FactorDump`, `FactorReplay`, `factor_config`, `FACTOR_WINDOW`, `extract_from_factors`, `--factors-out`, `--factors-pass`, `--replay-source`, `--tiling`, `--extract-pass`, `--extract-engine`, the arms `raw`, `offset`, `chosen`, `c_chosen`, `factor_closeness.{report, compare, a1_gate, a1_loss, fp_cosine, truth_r, truth_offset, read_truth}`, `factor_arms.{arms, command, line_step, report, done, run_arm}`; and from main's look-back prototype: `LookBack::{new, after_frame, spend, next_block, next_block_target, drain, frame}`, `LB_BLOCK`, `--lookback`, `--lookback-drain`.

## Decisions made while planning

Made overnight on the owner's instruction; for the owner's review (spec A12).

- **The live factors are on the offset grids.** Phase 1 measured plain tiles failing rule 4 (tile lines) on all three 200 px recordings and the offset grids passing it everywhere (phase 1 report, "Against plain recalibrated factors"). A7 keeps the app's live factors on plain tiles only because the history review reads side by side tiles, which phase 4 changes. So the factors a live run will have from phase 4 on are on the offset grids, and this phase measures those.
- **No replay pass over the raw file makes the factors.** Today's `chosen` arm writes its factors during the first refine replay (`--factors-pass 2`), a raw replay that a live stream does not have. The live arms keep `--factors-pass 1` (Discover's frames) and add nothing that makes factors later.
- **What the harness still takes from a raw replay.** The refine replays of a factor arm read the raw file to keep the preprocessor's running state and the missing-sample mask, and only then replace the pixels by the rebuilt frame (`FactorReplay::frame`). A live run cannot do this. It is a limit of the measurement, said in the report; phase 3 (Refine on factors, no replay) removes it. The Extract pass of the live arms uses the factor engine, which reads no frame.
- **An earlier session of the same sensor is simulated by a later stretch of the same recording.** How the flat field is estimated, saved and seeded today: the online estimator `OnlineFlatField` (`crates/cala/src/preprocess/flatfield.rs`) makes its first map after 150 s (`FIRST_MAP_S`) and refines it while the run lasts; `qc_eval` writes the final map to `flat_field.f32` and `flat_field_offset.f32` and every solve to `flat_field_updates.tsv`; a seed (`FlatFieldSeed { gain, offset, dark, frames }`) is in force from the first frame and is blended into every solve. The app stores the map per device in IndexedDB (`apps/cala/src/lib/flat-field-cache.ts`, `createIndexedDbFlatFieldCache`) and seeds a file run with gain, offsets, dark level and frames used (`start` in `apps/cala/src/lib/pipeline-store.ts`; `FlatFieldRunner` in `lib/flat-field-runner.ts`); a live stream neither reads nor writes the cache. `qc_eval --ff-seed` takes a gain map only. So: a first run, `seed`, runs Discover on frames N to 2N of the recording and ends with a map; the arms then run on frames 0 to N, as in phases 1 and 2, with that map as the seed (`--ff-seed-run`), which takes gain, offsets, dark level and frames as the app does. Taking the seed from a later stretch rather than the first half keeps the measured frames those of phases 1 and 2, so their `raw` numbers compare. The seed is from the same sensor and optics an hour later at most, not days later, so its help is an upper bound.
- **The synthetic sets get no seed.** In phases 0 and 1 the online flat field made no map on `wl200`, `plain` and `motion` (every solve skipped: too little motion), so there is no map to seed with. They get the unseeded live arm and the look-back arms.
- **Look-back on factors restores the missing samples.** A rebuilt frame has a value at every pixel. The raw look-back leaves NaN inside the field of view where the stored motion record marks a sample invalid (`mc.validity`; the background stage's `process_masked` in `crates/cala/src/preprocess/background.rs` sets it NaN, and `Preprocessor::back_masked` zeroes non-finite samples only outside the field of view). The factor source sets the same samples to NaN from the same records, so both sources skip the same samples and the comparison measures what the factors lose, not a different treatment of the border.
- **Look-back arms are compared by pairing cells by footprint.** The look-back feeds Discover's slow loop, so after the first birth it serves, the two runs' libraries differ and cell ids do not correspond. Cells are paired greedily by footprint cosine (at least 0.5, centroids within 20 px). A QC-pass reference cell without a partner counts as lost in gate A1, as phase 1 ruled; the report also gives the losses over paired cells alone.
- **Main's own footprint metrics are not ported.** `tools/cala-eval/demix_metrics.py` needs a minisim `oracle.bin`, which none of the six recordings has; their truth is a `truth.npz` with sparse footprints. The tools get the one measure of main's that this file allows cheaply: each cell's footprint correlation with the footprint of its truth unit, for all cells and for cells whose truth unit overlaps another (`cat_overlap`).
- **Joint flags.** The look-back arms run main's default look-back arm `LBD-x2` (`--passes 1 --joint-update all --joint-sign all --lookback 2 --lookback-drain 4800`, chosen in `tools/cala-eval/results/2026-11-19-concurrent-refine.md`), so they carry the cluster history replay. The flat field arms run with the joint flags off, as the gate arms of phases 1 and 2; phase 3's gate checks both (A8).

## Global Constraints

- This phase has no gate that stops it. Its result is the report: which rules of gate A1 a live run meets. A failed rule is a result that limits what a live run may claim; it does not stop the phase and is not "fixed" in this phase.
- Gate A1, on QC-pass cells: (1) with usable truth (raw run's median truth correlation at least 0.8 and at least 20 matched cells) the change of the truth correlation has a median of at least -0.01 and a 5th percentile of at least -0.05; (2) footprint loss at most 0.02; (3) without usable truth, trace loss (lag-1 correlation) at most 0.08; (4) footprint jump at tile lines at most 0.10 above the raw run's. A QC-pass cell the test run lost counts as the worst case in every rule.
- No change under `crates/cala/src`, `apps/` or `packages/`. Everything in Rust is in `crates/cala/examples/qc_eval.rs`.
- The frames route and every flag-off path stay byte-identical. The check: two short runs on `wl200` (first 1800 frames, budget 3,000,000) with the binary before this phase and with the binary after it, the arm `chosen` (2 refine replays) and main's default look-back arm without the new flags, give the same `extract_trace.f32`, `footprints.bin` and first factor window (`chosen/factors/w0000000.fac`). The stored reference is made before Task 1 (Precondition step below) and the comparison is Task 5, Step 2.
- No factor used by a live arm comes from a replay pass over the raw file: every live arm has `--factors-pass 1` (the default) and Discover's own windows.
- Release binary: the phase 2 gate runs use `crates/cala/target/release/examples/qc_eval`. `cargo build --release` runs only when no run uses that binary; `cargo check` and `cargo test` (debug) are fine at any time. No `cargo clean`.
- At most 4 `qc_eval` runs at once on the machine.
- Rust checks, run from `crates/cala`: `cargo fmt --all --check`, `cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings`, `cargo test --no-default-features --features jsbindings --example qc_eval`.
- Python: type hints on function signatures; `uvx ruff format` and `uvx ruff check --fix` on every Python file touched; tests with `uv run --no-project --with numpy python -m unittest discover tools/cala-eval` from the repository root; never install into a global environment.
- `npx prettier --write` on every Markdown file touched.
- The shell in this worktree refuses long compound commands (`cd ... &&` chains, loops, heredocs). Put anything complex in a script file outside the repository and run it with one plain command.
- Raw data is read only. Run outputs go to a folder outside the repository. No machine paths or user names in committed files.
- Branch: `feat/cala-factor-extract`, continued. Commits: one sentence, conventional prefix, no body, no co-author trailer and no tool or assistant attribution. Do not push from a task; the controller pushes at the phase boundary.

**Precondition step (the controller, before Task 1):** create the run folder `factor_phase4a_<date>` next to phase 1's run folder `factor_phase1_20261118` (named in the phase 1 report). Copy the release binary of the phase 2 gate runs into it as `qc_eval_before`. Write `identity.sh` (content in Task 5, Step 1) into it and run, with the `wl200` recording path from phase 1's `run_all.sh`:

```bash
bash <run folder>/identity.sh <run folder>/qc_eval_before <wl200 recording> <run folder>/identity_before
```

Expected: two run folders, `identity_before/chosen` and `identity_before/lb_raw`, each with `extract_trace.f32` and `footprints.bin`.

## Review Focus

1. **A look-back frame that is not yet on disk**: a block in the newest window, a block that straddles two windows, and the frames of the last short window at the drain. The cursor must only take a block whose frames are all in written windows, and the last window must be flushed before the drain. Pinned in Task 2 (`choose_block_takes_only_blocks_on_disk`, `lookback_factor_frames_are_the_dumped_frames_with_missing_samples_marked`).
2. **Missing samples of a rebuilt look-back frame**: invalid inside the field of view must become NaN, outside it the rebuilt value stays; without motion nothing is marked; the window cache must serve frames from the right window when the cursor jumps back and forth. Pinned in Task 2 (same test).
3. **A seed run that does not fit**: a map of another size, no map made (only skipped solves), no offset file, and `--ff-seed` given with `--ff-seed-run`. Errors with a message, not a wrong seed. Pinned in Task 1 (`a_seed_run_gives_the_map_it_ended_with`, `a_seed_run_without_a_map_is_refused`, `a_seed_map_of_another_size_is_refused`).
4. **`--from` across the files of a recording**: a recording is several numbered AVI files; frame F of the stream must map to the right file and local frame, and `--from` past the end must be refused. Pinned in Task 1 (`from_moves_the_stream_origin_across_files`, `from_past_the_end_is_refused`).
5. **Cell ids that collide between runs with different Discovers**: id 9 can be another cell in the look-back run. Pairing must follow the footprint, never the id; an unpaired reference cell counts as lost. Pinned in Task 3 (`test_cells_are_paired_by_footprint_not_by_id`, `test_a_moved_cell_stays_unpaired_and_counts_as_lost`).

## File Structure

| File                                                                                                     | Change          | Responsibility                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `crates/cala/examples/qc_eval.rs`                                                                        | modify          | `--from`, `--ff-seed-run` (Task 1); `--lookback-source`, `FactorFrames`, `mark_missing`, `choose_block` (Task 2) |
| `tools/cala-eval/factor_closeness.py`, `tools/cala-eval/test_factor_closeness.py`                        | modify          | `match_cells`, `truth_best`, `read_truth_footprints`, `fp_truth_r`, `report(match=...)`                          |
| `tools/cala-eval/factor_arms.py`, `tools/cala-eval/test_factor_arms.py`                                  | modify          | arms `live`, `seed`, `raw_seed`, `live_seed`, `lb_raw`, `lb_fac`, `lb_live`; `--seed-from`; report rows          |
| `tools/cala-eval/results/2026-11-19-factor-phase4a.md`, `docs/CHANGELOG.md`, `tools/cala-eval/README.md` | create / modify | results and docs                                                                                                 |

---

### Task 1: A later stretch of a recording, and a seed as the app stores it

**Files:**

- Modify: `crates/cala/examples/qc_eval.rs` (flag docs at the top; `Recording` at about lines 444 to 517; the flat field block at about lines 4214 to 4290; the `tests` module at about line 5715)

**Interfaces:**

- Consumes: `Recording::{open, read}`, `OnlineFlatField::{new, current}`, `FlatField::apply`, `FlatFieldSeed`, `read_f32_file`, `write_f32s`.
- Produces:
  - `qc_eval real ... --from F`: the stream starts at frame F of the recording; `--frames N` counts from F. `real` mode only.
  - `qc_eval ... --ff-seed-run DIR`: with the online flat field, the seed is the map an earlier run ended with (`DIR/flat_field.f32`, `DIR/flat_field_offset.f32` when present, dark level and frames of the last `updated` row of `DIR/flat_field_updates.tsv`), in force from frame 0 with offsets and dark level. Not with `--ff-seed`.
  - `Recording::skip(&mut self, first: u32)`, `Recording::locate(&self, s: u32) -> (usize, u32)`, field `Recording::first: u32`.
  - `fn read_seed_run(dir: &Path, n_px: usize) -> FlatFieldSeed`.

- [ ] **Step 1: Write the failing tests**

In the `tests` module of `crates/cala/examples/qc_eval.rs`:

```rust
    /// A recording of two files (1000 and 500 frames) without file handles: enough for the
    /// frame bookkeeping.
    fn two_file_recording() -> Recording {
        let dims = Dims::new(4, 3).unwrap();
        Recording {
            files: Vec::new(),
            starts: vec![0, 1000],
            dims,
            total: 1500,
            bin: 1,
            raw_dims: dims,
            first: 0,
        }
    }

    #[test]
    fn from_moves_the_stream_origin_across_files() {
        let mut r = two_file_recording();
        assert_eq!(r.locate(0), (0, 0));
        assert_eq!(r.locate(1200), (1, 200));
        r.skip(900);
        assert_eq!((r.first, r.total), (900, 600));
        assert_eq!(r.locate(0), (0, 900), "stream frame 0 is recording frame 900");
        assert_eq!(r.locate(150), (1, 50), "and stream frame 150 is in the second file");
    }

    #[test]
    #[should_panic(expected = "--from 1500")]
    fn from_past_the_end_is_refused() {
        two_file_recording().skip(1500);
    }

    const FF_HEAD: &str = "frame\toutcome\tfirst\tbins\tframes_used\tgain_sd\ttissue_sd\tresidual\tdark\tchange_median\tchange_p99\tchange_max\tsolve_s\n";

    /// A folder as an online flat field run leaves it: a 4-pixel map, optionally the column
    /// offsets, and the update log `log`.
    fn seed_dir(name: &str, offset: bool, log: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qc_eval_seed_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut f = File::create(dir.join("flat_field.f32")).unwrap();
        write_f32s(&mut f, &[1.0, 1.1, 0.9, 1.2]);
        if offset {
            let mut f = File::create(dir.join("flat_field_offset.f32")).unwrap();
            write_f32s(&mut f, &[2.0, 2.0, 3.0, 3.0]);
        }
        std::fs::write(dir.join("flat_field_updates.tsv"), log).unwrap();
        dir
    }

    fn two_maps_log() -> String {
        format!(
            "{FF_HEAD}2999\tupdated\t1\t12\t2400\t0.05000\t0.10000\t1.000e-3\t4.500\t0.1\t0.2\t0.3\t0.50\n\
             4199\tskipped: too little motion\t\t\t\t\t\t\t\t\t\t\t0.01\n\
             5399\tupdated\t0\t14\t4800\t0.04000\t0.10000\t1.000e-3\t4.750\t0.1\t0.2\t0.3\t0.40\n"
        )
    }

    #[test]
    fn a_seed_run_gives_the_map_it_ended_with() {
        let dir = seed_dir("full", true, &two_maps_log());
        let s = read_seed_run(&dir, 4);
        assert_eq!(s.gain, vec![1.0, 1.1, 0.9, 1.2]);
        assert_eq!(s.offset, Some(vec![2.0, 2.0, 3.0, 3.0]));
        assert_eq!((s.dark, s.frames), (4.75, 4800.0), "the last map's dark level and frames");
        std::fs::remove_dir_all(&dir).unwrap();
        let dir = seed_dir("gain", false, &two_maps_log());
        assert_eq!(read_seed_run(&dir, 4).offset, None, "no offset model, no offsets");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[should_panic(expected = "made no flat field map")]
    fn a_seed_run_without_a_map_is_refused() {
        let log = format!("{FF_HEAD}2999\tskipped: too little motion\t\t\t\t\t\t\t\t\t\t\t0.01\n");
        read_seed_run(&seed_dir("none", false, &log), 4);
    }

    #[test]
    #[should_panic(expected = "one value per pixel")]
    fn a_seed_map_of_another_size_is_refused() {
        read_seed_run(&seed_dir("size", false, &two_maps_log()), 5);
    }
```

- [ ] **Step 2: Run to see them fail**

From `crates/cala`: `cargo test --no-default-features --features jsbindings --example qc_eval`
Expected: does not compile (`Recording` has no field `first`; `locate`, `skip`, `read_seed_run` are not defined).

- [ ] **Step 3: Implement `--from`**

In `struct Recording`, after `raw_dims: Dims,`:

```rust
    /// `--from F`: recording frame of stream frame 0 (0 = from the start).
    first: u32,
```

In `Recording::open`, add `first: 0,` after `raw_dims,` in the struct literal. Replace the loop of `Recording::read` (the binning below it is unchanged):

```rust
    fn read(&mut self, start: u32, count: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity(count as usize * self.raw_dims.pixels());
        let mut s = start;
        while s < start + count {
            let (k, local) = self.locate(s);
            let n = (self.files[k].header.frame_count() - local).min(start + count - s);
            self.files[k].read(local, n, &mut out);
            s += n;
        }
```

and add to `impl Recording`:

```rust
    /// The file and its frame that hold stream frame `s` (recording frame
    /// `first + s`).
    fn locate(&self, s: u32) -> (usize, u32) {
        let f = self.first + s;
        let k = self.starts.partition_point(|&x| x <= f) - 1;
        (k, f - self.starts[k])
    }

    /// `--from F`: the stream starts at recording frame `first`; `total`
    /// becomes the frames from there on.
    fn skip(&mut self, first: u32) {
        assert!(
            first < self.total,
            "--from {first}: the recording has {} frames",
            self.total
        );
        self.first = first;
        self.total -= first;
    }
```

In `main`, directly after `let mut rec = Recording::open(&avi_dir, bin);`:

```rust
    if let Some(f) = arg_value(&args, "--from") {
        assert!(mode == "real", "--from is for `real` only");
        rec.skip(f.parse().unwrap());
        println!("from frame {f}: {} frames", rec.total);
    }
```

In the flag docs, after the `--frames N` line:

```rust
//!   --from F           `real` only: the stream starts at frame F of the
//!                      recording (`--frames` counts from F); a later stretch
//!                      of the same recording, e.g. the run whose flat field
//!                      `--ff-seed-run` reads
```

- [ ] **Step 4: Implement `--ff-seed-run`**

Below `read_f32_file`:

```rust
/// `--ff-seed-run DIR`: the flat field an earlier `qc_eval` run of the same
/// sensor ended with, as the app stores it per device: the gain map
/// (`DIR/flat_field.f32`), the column offsets (`DIR/flat_field_offset.f32`,
/// when that run had the offset model), and the dark level and frames of
/// the last map (the last `updated` row of `DIR/flat_field_updates.tsv`).
fn read_seed_run(dir: &Path, n_px: usize) -> FlatFieldSeed {
    let gain = read_f32_file(dir.join("flat_field.f32").to_str().unwrap());
    assert_eq!(
        gain.len(),
        n_px,
        "{dir:?}: flat_field.f32 is not one value per pixel of this recording"
    );
    let off = dir.join("flat_field_offset.f32");
    let offset = off.exists().then(|| read_f32_file(off.to_str().unwrap()));
    if let Some(o) = &offset {
        assert_eq!(o.len(), n_px, "{dir:?}: flat_field_offset.f32 is not one value per pixel");
    }
    let path = dir.join("flat_field_updates.tsv");
    let log = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    let mut lines = log.lines();
    let head: Vec<&str> = lines.next().unwrap_or("").split('\t').collect();
    let col = |name: &str| {
        head.iter()
            .position(|h| *h == name)
            .unwrap_or_else(|| panic!("{path:?}: no column {name}"))
    };
    let (c_out, c_frames, c_dark) = (col("outcome"), col("frames_used"), col("dark"));
    let last = lines
        .rev()
        .find(|l| l.split('\t').nth(c_out) == Some("updated"))
        .unwrap_or_else(|| panic!("{dir:?}: the run made no flat field map"));
    let f: Vec<&str> = last.split('\t').collect();
    FlatFieldSeed {
        gain,
        offset,
        dark: f[c_dark].parse().unwrap(),
        frames: f[c_frames].parse().unwrap(),
    }
}
```

In `main`, directly after `let ff_mode = arg_value(&args, "--flat-field") ... ;`:

```rust
    assert!(
        ff_mode == "online" || arg_value(&args, "--ff-seed-run").is_none(),
        "--ff-seed-run needs the online flat field (--motion)"
    );
```

In the `online` branch, replace the two lines

```rust
        println!("flat field: online {c:?}, seed {}", seed.is_some());
        online_ff = Some(OnlineFlatField::new(dims, &fov, c, seed).unwrap());
```

by

```rust
        let seed_run = arg_value(&args, "--ff-seed-run").map(|d| read_seed_run(Path::new(&d), n_px));
        assert!(
            seed.is_none() || seed_run.is_none(),
            "--ff-seed and --ff-seed-run: one or the other"
        );
        let from_run = seed_run.is_some();
        let seed = seed.or(seed_run);
        println!("flat field: online {c:?}, seed {}", seed.is_some());
        let o = OnlineFlatField::new(dims, &fov, c, seed).unwrap();
        if from_run {
            // As the app: the stored map, offsets and dark level included,
            // is in force from frame 0.
            o.current()
                .expect("a seeded flat field has a map")
                .apply(&mut pre0)
                .unwrap();
        }
        online_ff = Some(o);
```

The `--ff-seed` lines above it (the seed and its gain-only `apply`) stay as they are. In the flag docs, after the `--flat-field M` paragraph (it ends with "a file path divides by that gain map (f32 LE per pixel)"):

```rust
//!   --ff-seed-run DIR  with `--flat-field online`: seed from the flat field an
//!                      earlier run of the same sensor ended with, as the app
//!                      stores it per device: `DIR/flat_field.f32`,
//!                      `DIR/flat_field_offset.f32` when present, and the dark
//!                      level and frames of the last map in
//!                      `DIR/flat_field_updates.tsv`; the map (gain, offsets,
//!                      dark level) is in force from frame 0. Not with `--ff-seed`
```

- [ ] **Step 5: Run the tests**

From `crates/cala`: `cargo test --no-default-features --features jsbindings --example qc_eval`
Expected: all pass, the five new tests among them.

- [ ] **Step 6: Check and commit**

From `crates/cala`: `cargo fmt --all`, then the clippy command of Global Constraints. Expected: no warning.

```bash
git add crates/cala/examples/qc_eval.rs
git commit -m "feat(cala-eval): qc_eval runs a later stretch of a recording and takes a flat field seed as the app stores it"
```

---

### Task 2: Look-back reads Discover's factors

**Files:**

- Modify: `crates/cala/examples/qc_eval.rs` (flag docs after `--lookback-drain`; `LookBack` at about lines 655 to 1194; `FactorDump` at about line 3467; the look-back flags at about line 4331; the look-back call in the frame loop at about line 4946; the look-back summary at about line 5232; the `tests` module)

**Interfaces:**

- Consumes: `FactorDump`, `FACTOR_WINDOW`, `WindowFactors::{from_bytes, layout}`, `BlendLayout::reconstruct`, `MotionCorrector::validity`, `Preprocessor::calibration`, `Calibration::fov`, `FovMask::mask`; nothing from Task 1.
- Produces:
  - `qc_eval ... --lookback R --lookback-source raw|factors` (default `raw`). `factors` needs `--factors-out` with `--factors-pass 1` and no `--catchup`. It prints `lookback source: factors, N window files read` at the end.
  - `FactorDump::written: usize` (frames in the window files written so far).
  - `struct FactorFrames { dir: PathBuf, cache: VecDeque<(WindowFactors, BlendLayout)>, reads: u64 }` with `FactorFrames::new(dir: &Path) -> FactorFrames` and `FactorFrames::frame(&mut self, f: usize, y: &mut [f32])`; `const LB_WINDOWS: usize = 6`.
  - `fn mark_missing(y: &mut [f32], valid: Option<&[u8]>, fov: &[u8])`.
  - `fn choose_block(need: &BTreeMap<u64, (usize, Vec<usize>)>, newest_first: bool, servable: impl Fn(usize) -> bool) -> Option<usize>`.
  - `LookBack::source: Option<FactorFrames>`, `LookBack::avail: usize` (frames that can be read back; `usize::MAX` with the raw source).

- [ ] **Step 1: Write the failing tests**

In the `tests` module:

```rust
    #[test]
    fn choose_block_takes_only_blocks_on_disk() {
        let mut need = std::collections::BTreeMap::new();
        need.insert(1u64, (640usize, vec![7usize, 8, 9]));
        need.insert(2u64, (700usize, vec![8usize, 9, 10]));
        need.insert(3u64, (300usize, vec![2usize, 3]));
        // Frames 0..704 seen; `avail` of them in window files.
        let upto = |avail: usize| move |b: usize| ((b + 1) * LB_BLOCK).min(704) <= avail;
        // All on disk (the raw source): blocks 8 and 9 are needed twice, ties go to the
        // most recent; newest first: the newest cell's most recent block.
        assert_eq!(choose_block(&need, false, upto(usize::MAX)), Some(9));
        assert_eq!(choose_block(&need, true, upto(usize::MAX)), Some(10));
        // One window written (frames 0..600): blocks 9 (576..640) and 10 wait.
        assert_eq!(choose_block(&need, false, upto(600)), Some(8));
        assert_eq!(choose_block(&need, true, upto(600)), Some(8));
        // Nothing written yet.
        assert_eq!(choose_block(&need, false, upto(0)), None);
        assert_eq!(choose_block(&need, true, upto(0)), None);
    }

    #[test]
    fn lookback_factor_frames_are_the_dumped_frames_with_missing_samples_marked() {
        let dims = Dims::new(96, 70).unwrap();
        let frames = slow_stream(dims, 2 * FACTOR_WINDOW + 50);
        let dir = std::env::temp_dir().join(format!("qc_eval_lbfac_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut fd = FactorDump::new(&dir, dims, Tiling::Offset, factor_config(&[]));
        for (t, f) in frames.iter().enumerate() {
            fd.push(f);
            assert_eq!(fd.written, (t + 1) / FACTOR_WINDOW * FACTOR_WINDOW, "frame {t}");
        }
        fd.finish();
        assert_eq!(fd.written, frames.len(), "the short last window is written by finish");
        let n = dims.pixels();
        let mut fov = vec![1u8; n];
        fov[0] = 0;
        let mut valid = vec![1u8; n];
        valid[0] = 0;
        valid[7] = 0;
        let mut fr = FactorReplay::new(&dir, dims);
        let mut ff = FactorFrames::new(&dir);
        // Back and forth between the three windows.
        for t in [FACTOR_WINDOW + 3, 5, 2 * FACTOR_WINDOW + 49, 5, FACTOR_WINDOW - 1] {
            let mut want = vec![0.0f32; n];
            fr.frame(t, &mut want);
            let mut y = vec![f32::NAN; n];
            ff.frame(t, &mut y);
            mark_missing(&mut y, Some(&valid), &fov);
            assert!(y[7].is_nan(), "frame {t}: an invalid sample inside the FOV is missing");
            assert_eq!(y[0], want[0], "frame {t}: outside the FOV the rebuilt value stays");
            for p in (1..n).filter(|&p| p != 7) {
                assert_eq!(y[p], want[p], "frame {t} pixel {p}");
            }
        }
        assert_eq!(ff.reads, 3, "each window file is read once");
        // Without motion nothing is marked.
        let mut y = vec![0.0f32; n];
        ff.frame(5, &mut y);
        mark_missing(&mut y, None, &fov);
        assert!(y.iter().all(|v| v.is_finite()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[should_panic(expected = "is not on disk")]
    fn a_lookback_frame_of_an_unwritten_window_is_refused() {
        let dir = std::env::temp_dir().join(format!("qc_eval_lbnone_{}", std::process::id()));
        let mut y = vec![0.0f32; 4];
        FactorFrames::new(&dir).frame(0, &mut y);
    }
```

- [ ] **Step 2: Run to see them fail**

From `crates/cala`: `cargo test --no-default-features --features jsbindings --example qc_eval`
Expected: does not compile (`choose_block`, `FactorFrames`, `mark_missing`, `FactorDump::written` are not defined).

- [ ] **Step 3: `FactorDump::written`**

In `struct FactorDump`, after `seconds: f64,`:

```rust
    /// Frames in the window files written so far (the windows are written
    /// in order).
    written: usize,
```

In `FactorDump::new`, add `written: 0,` after `seconds: 0.0,`. At the start of `FactorDump::write`:

```rust
        self.written += wf.frames;
```

- [ ] **Step 4: `FactorFrames`, `mark_missing`, `choose_block`**

Below `FactorReplay` (after its `impl`):

```rust
/// Factor windows the look-back keeps in memory: its reach of 3000 frames
/// before a birth (`--lookback-frames`) spans at most six windows.
const LB_WINDOWS: usize = 6;

/// `--lookback-source factors`: past frames rebuilt from the factor windows
/// a [`FactorDump`] has written so far in pass 1. Keeps the last
/// `LB_WINDOWS` windows it read.
struct FactorFrames {
    dir: PathBuf,
    cache: std::collections::VecDeque<(WindowFactors, BlendLayout)>,
    /// Window files read (each miss of the cache).
    reads: u64,
}

impl FactorFrames {
    fn new(dir: &Path) -> FactorFrames {
        FactorFrames {
            dir: dir.to_path_buf(),
            cache: Default::default(),
            reads: 0,
        }
    }

    /// Write recording frame `f`, rebuilt from its window, to every pixel
    /// of `y`.
    fn frame(&mut self, f: usize, y: &mut [f32]) {
        let start = (f / FACTOR_WINDOW) * FACTOR_WINDOW;
        let at = match self
            .cache
            .iter()
            .position(|(wf, _)| wf.start as usize == start)
        {
            Some(i) => i,
            None => {
                let path = self.dir.join(format!("w{start:07}.fac"));
                let bytes = std::fs::read(&path).unwrap_or_else(|e| {
                    panic!("look-back frame {f}: its window {path:?} is not on disk ({e})")
                });
                let wf = WindowFactors::from_bytes(&bytes)
                    .unwrap_or_else(|| panic!("{path:?}: not a factor file"));
                let layout = wf.layout();
                if self.cache.len() == LB_WINDOWS {
                    self.cache.pop_front();
                }
                self.cache.push_back((wf, layout));
                self.reads += 1;
                self.cache.len() - 1
            }
        };
        let (wf, layout) = &self.cache[at];
        assert!(
            f - start < wf.frames,
            "look-back frame {f} is beyond the factors in {:?}",
            self.dir
        );
        layout.reconstruct(wf, f - start, y);
    }
}

/// `--lookback-source factors`: mark a rebuilt frame's missing samples as
/// the raw look-back path leaves them: NaN inside the FOV where the stored
/// motion record marks a sample invalid (`valid` 0; `None` without motion:
/// all valid). Outside the FOV the rebuilt value stays.
fn mark_missing(y: &mut [f32], valid: Option<&[u8]>, fov: &[u8]) {
    let Some(valid) = valid else {
        return;
    };
    for ((v, &ok), &m) in y.iter_mut().zip(valid).zip(fov) {
        if ok == 0 && m != 0 {
            *v = f32::NAN;
        }
    }
}

/// The block [`LookBack::next_block`] serves: the one the most cells still
/// need (ties: the most recent) or, with `newest_first`, the newest cell's
/// most recent block. Only blocks for which `servable` holds count (the raw
/// source: all; the factor source: blocks whose frames are in written
/// windows).
fn choose_block(
    need: &std::collections::BTreeMap<u64, (usize, Vec<usize>)>,
    newest_first: bool,
    servable: impl Fn(usize) -> bool,
) -> Option<usize> {
    if newest_first {
        need.values()
            .filter(|(_, blocks)| blocks.iter().any(|&b| servable(b)))
            .max_by_key(|(born, _)| *born)
            .and_then(|(_, blocks)| blocks.iter().copied().filter(|&b| servable(b)).max())
    } else {
        let mut count: std::collections::BTreeMap<usize, usize> = Default::default();
        for (_, blocks) in need.values() {
            for &b in blocks.iter().filter(|&&b| servable(b)) {
                *count.entry(b).or_default() += 1;
            }
        }
        count.iter().max_by_key(|&(&b, &n)| (n, b)).map(|(&b, _)| b)
    }
}
```

- [ ] **Step 5: The look-back uses them**

In `struct LookBack`, after `seen: usize,`:

```rust
    /// `--lookback-source factors`: past frames from Discover's factor
    /// windows instead of the recording (`None`: raw).
    source: Option<FactorFrames>,
    /// Frames that can be read back: with the factor source those in written
    /// windows; `usize::MAX` with the raw source.
    avail: usize,
```

In `LookBack::new`, add `source: None,` and `avail: usize::MAX,` after `seen: 0,`.

In `LookBack::next_block`, replace everything from `let mut count: std::collections::BTreeMap<usize, usize> = Default::default();` down to and including the `let Some(blk) = blk else { return false; };` statement by:

```rust
        let (seen, avail) = (self.seen, self.avail);
        let servable = |b: usize| ((b + 1) * LB_BLOCK).min(seen) <= avail;
        let Some(blk) = choose_block(&self.need, self.newest_first, servable) else {
            return false;
        };
```

The first line of the function (`self.need.retain(...)`) and everything from `let k = self.max_frames;` on stay. In `LookBack::next_block_target`, replace `let nb = seen / LB_BLOCK;` by:

```rust
        let nb = seen.min(self.avail) / LB_BLOCK;
```

In `LookBack::frame`, move the two statements that compute `idx` and `skip` (with their comments) to the top of the function body, and put the factor source in front of the raw path:

```rust
    ) -> bool {
        // The frame's slow-loop index in Discover (all batches forwarded):
        // a held-out frame stays held out. Warm-up frames, never in the
        // slow loop, get their own range.
        let idx = if f >= start {
            (f - start) as u64
        } else {
            u64::MAX - f as u64
        };
        // Precision mode: a held-out frame is still preprocessed (the block's
        // preprocessor copy runs forward) but not solved.
        let skip = self.target > 0.0 && sl.is_test(idx);
        if let Some(src) = self.source.as_mut() {
            // `--lookback-source factors`: the frame as Discover compressed it,
            // preprocessed and registered with the calibration of its time; no
            // raw read, no preprocessing, no warp. A held-out frame is passed
            // over without rebuilding it.
            if skip {
                self.skipped += 1;
                return false;
            }
            src.frame(f, &mut self.y);
            let valid = match pipe.mc.as_mut() {
                Some(mc) => {
                    mc.validity(&pipe.records[f], pipe.src.as_ref().unwrap(), &mut self.valid)
                        .unwrap();
                    Some(&self.valid[..])
                }
                None => None,
            };
            mark_missing(&mut self.y, valid, pipe.pre.calibration().fov().mask());
        } else {
            if f < self.raw_start || f >= self.raw_start + self.raw_n {
                let lo = f - f % LB_BLOCK;
                let cnt = LB_BLOCK.min(rec.total as usize - lo);
                self.raw = rec.read(lo as u32, cnt as u32);
                if let Some(d) = drift {
                    for (k, fr) in self.raw.chunks_exact_mut(n_px).enumerate() {
                        d.apply(fr, lo + k);
                    }
                }
                self.raw_start = lo;
                self.raw_n = cnt;
            }
            let o = (f - self.raw_start) * n_px;
            let raw = &self.raw[o..o + n_px];
            pre.front(raw, &mut self.buf).unwrap();
            if let Some(w) = pipe.warp_at(f) {
                let mut tmp = Vec::new();
                w.apply_in_place(&mut self.buf, &mut tmp).unwrap();
            }
            // The live corrector's `apply`/`validity` only warp by a stored
            // record (scratch buffers, no estimation state), as a replay does.
            if let Some(mc) = pipe.mc.as_mut() {
                let r = &pipe.records[f];
                mc.apply(Frame::F32(&self.buf), r, &mut self.y, None)
                    .unwrap();
                mc.validity(r, pipe.src.as_ref().unwrap(), &mut self.valid)
                    .unwrap();
                pre.back_masked(&mut self.y, &self.valid).unwrap();
            } else {
                self.y.copy_from_slice(&self.buf);
                pre.back(&mut self.y).unwrap();
            }
            if skip {
                self.skipped += 1;
                return false;
            }
        }
        let lib = live.library();
```

Everything from `let lib = live.library();` to the end of the function stays as it is. The `else` branch is the old body between the function's start and `let lib = live.library();`, unchanged, without the two statements moved to the top (check it against the file: the statements and their order must be the old ones).

- [ ] **Step 6: The flag and the frame loop**

In `main`, directly after the assert that follows `let lb_target: f64 = ...` (the look-back flags are parsed in the order `lb_rate`, `lb_catchup`, `lb_double`, `lb_newest`, `lb_drain`, `lb_frames`, `lb_target`; `factors_pass` is parsed earlier):

```rust
    let lb_factors = match arg_value(&args, "--lookback-source").as_deref() {
        None | Some("raw") => false,
        Some("factors") => true,
        Some(o) => panic!("--lookback-source: raw or factors, not {o:?}"),
    };
    assert!(
        !lb_factors || (lb_rate > 0.0 && lb_catchup == 0),
        "--lookback-source factors needs --lookback R and no --catchup"
    );
    assert!(
        !lb_factors || factors_pass == 1,
        "--lookback-source factors reads Discover's factors: --factors-pass 1"
    );
    let lb_source: Option<PathBuf> = lb_factors.then(|| {
        PathBuf::from(
            arg_value(&args, "--factors-out").expect("--lookback-source factors needs --factors-out"),
        )
    });
```

In the closure that builds `lookback`, after `l.target = lb_target;`:

```rust
        l.source = lb_source.as_deref().map(FactorFrames::new);
```

In the frame loop, the block `if let (Some(lbk), Some(sl), 0, None) = (lookback.as_mut(), slow.as_mut(), pass, timed.as_ref()) { ... }` becomes:

```rust
                if let (Some(lbk), Some(sl), 0, None) =
                    (lookback.as_mut(), slow.as_mut(), pass, timed.as_ref())
                {
                    if lbk.source.is_some() {
                        // Only windows on disk can be read back: at most one
                        // window behind the live frame.
                        lbk.avail = factors.as_ref().map_or(0, |fd| fd.written);
                    }
                    lbk.after_frame(
                        t_rec,
                        t_len,
                        start,
                        &mut rec,
                        drift.as_ref(),
                        &mut pipe,
                        &engine,
                        sl,
                        n_px,
                    );
                    if last && lb_drain > 0 {
                        if lbk.source.is_some() {
                            // A stream's last window is flushed when it ends,
                            // before the drain reads it.
                            if let Some(fd) = factors.as_mut() {
                                fd.finish();
                                lbk.avail = fd.written;
                            }
                        }
                        let (st, fr) = lbk.drain(
                            lb_drain,
                            budget,
                            start,
                            &mut rec,
                            drift.as_ref(),
                            &mut pipe,
                            &mut engine,
                            sl,
                            n_px,
                        );
                        println!("lookback drain: {st} steps, {fr} frames");
                    }
                }
```

`fd.finish()` again at the end of the pass flushes nothing and writes the same `factors.tsv`. In the summary after the passes, directly after the `println!("lookback: {} frames ...", ...)` statement:

```rust
        if let Some(s) = &l.source {
            println!("lookback source: factors, {} window files read", s.reads);
        }
```

In the flag docs, after the `--lookback-drain N` paragraph:

```rust
//!   --lookback-source S  where look-back frames come from: raw (default; the
//!                      recording, preprocessed again with a copy of the live
//!                      preprocessor and the stored motion records) | factors
//!                      (rebuilt from the factor windows `--factors-out` has
//!                      written so far in pass 1: no raw read, no
//!                      preprocessing, no warp; the samples the motion record
//!                      marks missing stay missing; a block waits until its
//!                      window is on disk, and the last window is flushed
//!                      before the drain). Needs `--factors-out`,
//!                      `--factors-pass 1` and no `--catchup`
```

- [ ] **Step 7: Run the tests**

From `crates/cala`: `cargo test --no-default-features --features jsbindings --example qc_eval`
Expected: all pass, the three new tests among them. If the borrow checker refuses the `valid` borrow in `LookBack::frame`, compute the mask into `self.valid` first and pass `pipe.mc.is_some().then_some(&self.valid[..])`; say so in the report.

- [ ] **Step 8: Check and commit**

`cargo fmt --all`, the clippy command. Expected: no warning.

```bash
git add crates/cala/examples/qc_eval.rs
git commit -m "feat(cala-eval): main's look-back can read Discover's factor windows instead of the raw file"
```

---

### Task 3: Pair cells by footprint, and the footprint correlation with the truth

**Files:**

- Modify: `tools/cala-eval/factor_closeness.py`, `tools/cala-eval/test_factor_closeness.py`

**Interfaces:**

- Consumes: `read_footprints` (from `fp_scales`), `fp_cosine`, `read_traces`, `read_centroids`, `read_qc`, `read_truth`, `truth_offset`, `truth_r`, `pearson`, `a1_loss`, `a1_gate`.
- Produces:
  - `MATCH_COS = 0.5`, `MATCH_PX = 20.0`
  - `footprint_centroid(cell: Cell, w: int) -> tuple[float, float]`
  - `match_cells(fa: dict[int, Cell], fb: dict[int, Cell], dims: tuple[int, int], min_cos: float = MATCH_COS) -> dict[int, int]` (reference id to test id)
  - `truth_best(trace: np.ndarray, c: tuple[float, float], truth: Truth, offset: tuple[float, float] = (0.0, 0.0)) -> tuple[int, float]`
  - `read_truth_footprints(path: Path) -> tuple[list[Cell], np.ndarray]`
  - `fp_truth_r(cell: Cell, unit: Cell, shift: tuple[int, int], dims: tuple[int, int]) -> float`
  - `compare(ref, test, tile=64, truth_path=None, pairs: dict[int, int] | None = None) -> list[Row]`; rows gain `truth_fp_ref`, `truth_fp_test`, `truth_overlap`, and `test_id` when `pairs` is given.
  - `report(ref, test, nulls, tile=64, band=16.0, truth_path=None, match: bool = False) -> str`
  - CLI: `factor_closeness.py ... --match`

- [ ] **Step 1: Write the failing tests**

In `tools/cala-eval/test_factor_closeness.py`, in class `Closeness` (it has `self.root` and `_write_truth`):

```python
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
            self.assertEqual(rows[cid]["truth_overlap"], 0.0, "no cat_overlap: none overlaps")
        self.assertAlmostEqual(rows[7]["truth_fp_test"], 1.0, places=6)
        self.assertLess(rows[9]["truth_fp_test"], 0.9, "a footprint 1 px off")
        text = F.report(a, b, [], truth_path=truth)
        self.assertIn(
            "Footprint correlation with the truth footprint, median: reference 1.0000", text
        )
        last = [ln for ln in text.splitlines() if ln][-1]
        self.assertTrue(last.startswith("Gate A1: "), last)

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
```

- [ ] **Step 2: Run to see them fail**

From the repository root: `uv run --no-project --with numpy python -m unittest discover tools/cala-eval`
Expected: the three new tests error (`truth_fp_ref` key, `match_cells`, `pairs` and `match` arguments).

- [ ] **Step 3: Implement**

In `tools/cala-eval/factor_closeness.py`, below `TRUTH_MIN_CELLS = 3`:

```python
# Pairing of the cells of two runs whose Discover differed (look-back): footprint cosine at
# least MATCH_COS, centroids at most MATCH_PX apart.
MATCH_COS = 0.5
MATCH_PX = 20.0
```

Below `read_truth`:

```python
def read_truth_footprints(path: Path) -> tuple[list[Cell], np.ndarray]:
    """Each truth unit's footprint `(pixels, values)` of a `truth.npz`, and its `cat_overlap`
    flag (all False when the file has none)."""
    z = np.load(path)
    ptr = z["A_indptr"]
    idx, val = z["A_indices"].astype(np.int64), z["A_data"].astype(np.float64)
    units = [(idx[ptr[k] : ptr[k + 1]], val[ptr[k] : ptr[k + 1]]) for k in range(len(ptr) - 1)]
    overlap = (
        np.asarray(z["cat_overlap"], dtype=bool)
        if "cat_overlap" in z.files
        else np.zeros(len(units), dtype=bool)
    )
    return units, overlap
```

Below `fp_cosine`:

```python
def footprint_centroid(cell: Cell, w: int) -> tuple[float, float]:
    """Weighted centroid (y, x) of a footprint; NaN for an empty one."""
    pix, val = cell
    v = val.astype(np.float64)
    s = float(v.sum())
    if s <= 0:
        return NAN, NAN
    p = pix.astype(np.int64)
    return float((p // w * v).sum()) / s, float((p % w * v).sum()) / s


def match_cells(
    fa: dict[int, Cell],
    fb: dict[int, Cell],
    dims: tuple[int, int],
    min_cos: float = MATCH_COS,
) -> dict[int, int]:
    """Pairs (reference id to test id) of the cells of two runs whose cell sets differ: in
    falling footprint cosine, each cell in at most one pair, cosine at least `min_cos`,
    centroids at most `MATCH_PX` apart. Ids are not used: they do not correspond."""
    w = dims[1]
    cb = {k: footprint_centroid(c, w) for k, c in fb.items()}
    cand: list[tuple[float, int, int]] = []
    for ia, a in fa.items():
        ya, xa = footprint_centroid(a, w)
        for ib, b in fb.items():
            yb, xb = cb[ib]
            if not math.hypot(ya - yb, xa - xb) <= MATCH_PX:
                continue
            c = fp_cosine(a, b)
            if c >= min_cos:
                cand.append((c, ia, ib))
    cand.sort(key=lambda x: (-x[0], x[1], x[2]))
    out: dict[int, int] = {}
    used: set[int] = set()
    for _, ia, ib in cand:
        if ia not in out and ib not in used:
            out[ia] = ib
            used.add(ib)
    return out
```

Below `truth_r`:

```python
def truth_best(
    trace: np.ndarray,
    c: tuple[float, float],
    truth: Truth,
    offset: tuple[float, float] = (0.0, 0.0),
) -> tuple[int, float]:
    """The truth unit within `TRUTH_PX` of `c` shifted by `offset` that the trace follows
    best, and that correlation; (-1, NaN) when there is none."""
    cen, tr = truth
    y, x = c[0] + offset[0], c[1] + offset[1]
    best = (-1, NAN)
    for k in np.flatnonzero(np.hypot(cen[:, 0] - y, cen[:, 1] - x) <= TRUTH_PX):
        r = pearson(trace, tr[k])
        if not math.isnan(r) and (best[0] < 0 or r > best[1]):
            best = (int(k), r)
    return best


def fp_truth_r(
    cell: Cell, unit: Cell, shift: tuple[int, int], dims: tuple[int, int]
) -> float:
    """Correlation over the whole frame of a cell's footprint and a truth footprint moved
    into the run's frame by `shift` (truth pixel (y, x) goes to (y - dy, x - dx)); NaN when
    either is constant. main's demixing suite calls this the footprint r."""
    h, w = dims
    dy, dx = shift
    up, uv = unit
    y, x = up // w - dy, up % w - dx
    ok = (y >= 0) & (y < h) & (x >= 0) & (x < w)
    tp, tv = (y[ok] * w + x[ok]), uv[ok].astype(np.float64)
    a = dict(zip(cell[0].tolist(), cell[1].astype(np.float64).tolist()))
    sab = sum(a.get(p, 0.0) * v for p, v in zip(tp.tolist(), tv.tolist()))
    av = cell[1].astype(np.float64)
    n = h * w
    sa, saa = float(av.sum()), float((av * av).sum())
    sb, sbb = float(tv.sum()), float((tv * tv).sum())
    va, vb = saa - sa * sa / n, sbb - sb * sb / n
    if va <= 0 or vb <= 0:
        return NAN
    return float((sab - sa * sb / n) / math.sqrt(va * vb))
```

Replace `compare` and `_compare` by:

```python
def compare(
    ref: Path,
    test: Path,
    tile: int = 64,
    truth_path: Path | None = None,
    pairs: dict[int, int] | None = None,
) -> list[Row]:
    """One row per cell of `ref`, compared with the cell of the same id in `test`, or with
    its partner in `pairs` (reference id to test id) when given."""
    return _compare(ref, test, tile, truth_path, pairs)[0]


def _compare(
    ref: Path,
    test: Path,
    tile: int,
    truth_path: Path | None,
    pairs: dict[int, int] | None = None,
) -> tuple[list[Row], tuple[float, float, int]]:
    """The rows of `compare` and the truth offset `(dy, dx, n cells)` used for them."""
    (h, w), fa = read_footprints(ref / "footprints.bin")
    _, fb = read_footprints(test / "footprints.bin")
    ta, tb = read_traces(ref), read_traces(test)
    cen, qc = read_centroids(ref), read_qc(ref)
    truth = read_truth(truth_path, (h, w)) if truth_path else None
    units, overlap = (
        read_truth_footprints(truth_path) if truth_path else ([], np.zeros(0, dtype=bool))
    )
    dy, dx, n_off = truth_offset(ta, cen, truth) if truth else (0.0, 0.0, 0)
    shift = (round(dy), round(dx))
    rows: list[Row] = []
    for cid in sorted(fa):
        tid = cid if pairs is None else pairs.get(cid, -1)
        cy, cx = cen.get(cid, (NAN, NAN))
        both = cid in ta and tid in tb
        ku = truth_best(ta[cid], (cy, cx), truth, (dy, dx))[0] if truth and cid in ta else -1
        kt = truth_best(tb[tid], (cy, cx), truth, (dy, dx))[0] if truth and tid in tb else -1
        row: Row = {
            "id": cid,
            "cy": cy,
            "cx": cx,
            "edge_px": min(line_distance(cy, h, tile), line_distance(cx, w, tile)),
            "border_px": min(cy, cx, h - 1 - cy, w - 1 - cx),
            "qc_pass": float(qc.get(cid, True)),
            "in_test": float(tid in fb),
            "fp_cos": fp_cosine(fa[cid], fb[tid]) if tid in fb else NAN,
            "trace_r": pearson(ta[cid], tb[tid]) if both else NAN,
            "trace_r1": lag1_r(ta[cid], tb[tid]) if both else NAN,
            "truth_r_ref": truth_r(ta[cid], (cy, cx), truth, (dy, dx))
            if truth and cid in ta
            else NAN,
            "truth_r_test": truth_r(tb[tid], (cy, cx), truth, (dy, dx))
            if truth and tid in tb
            else NAN,
            "truth_fp_ref": fp_truth_r(fa[cid], units[ku], shift, (h, w)) if ku >= 0 else NAN,
            "truth_fp_test": fp_truth_r(fb[tid], units[kt], shift, (h, w))
            if kt >= 0 and tid in fb
            else NAN,
            "truth_overlap": float(overlap[ku]) if ku >= 0 else NAN,
        }
        if pairs is not None:
            row["test_id"] = float(tid)
        rows.append(row)
    return rows, (dy, dx, n_off)
```

In `report`: add the parameter `match: bool = False` after `truth_path`, add to its docstring "With `match`, cells are paired by footprint (`match_cells`) instead of by id: for runs whose Discover differed (look-back).", and replace its first lines down to `extra = ...` by:

```python
    dims, fa = read_footprints(ref / "footprints.bin")
    _, fb = read_footprints(test / "footprints.bin")
    pairs = match_cells(fa, fb, dims) if match else None
    rows, (dy, dx, n_off) = _compare(ref, test, tile, truth_path, pairs)
    null_rows = [compare(ref, n, tile, None) for n in nulls]
    missing = sum(1 for r in rows if not r["in_test"])
    partners = set(pairs.values()) if pairs is not None else set(fa)
    extra = len(set(fb) - partners)
```

At the end of the `if truth_path:` block (after the line "Truth correlation, test minus reference, ..."):

```python
        fr, ft = finite(rows, "truth_fp_ref"), finite(rows, "truth_fp_test")
        out.append(
            "Footprint correlation with the truth footprint, median: "
            f"reference {q(fr, 50)}, test {q(ft, 50)}."
        )
        for name, sel in (
            ("all cells", rows),
            (
                "cells whose truth unit overlaps another",
                [r for r in rows if r["truth_overlap"] == 1.0],
            ),
        ):
            d = np.asarray(
                [
                    r["truth_fp_test"] - r["truth_fp_ref"]
                    for r in sel
                    if math.isfinite(r["truth_fp_ref"]) and math.isfinite(r["truth_fp_test"])
                ],
                dtype=np.float64,
            )
            out.append(
                f"Truth footprint correlation, test minus reference, {name}: {len(d)} cells, "
                f"median {q(d, 50)}, 5th pct {q(d, 5)}."
            )
```

Directly before the statement `ja, jb = line_jump(fa, dims, tile), line_jump(fb, dims, tile)`:

```python
    if pairs is not None:
        paired = [r for r in rows if r["qc_pass"] and r["in_test"]]
        out += [
            "",
            (
                f"Cells paired by footprint (cosine at least {MATCH_COS:g}, centroids at most "
                f"{MATCH_PX:g} px apart): {len(pairs)} pairs. Over the {len(paired)} paired "
                f"QC-pass cells alone: footprint loss {a1_loss(paired, 'fp_cos'):.4f}, "
                f"trace loss {a1_loss(paired, 'trace_r1'):.4f}."
            ),
        ]
```

In `main`, add after the `--out` argument:

```python
    ap.add_argument(
        "--match",
        action="store_true",
        help="pair cells by footprint, not by id (runs whose Discover differed)",
    )
```

and replace the rest of `main` by:

```python
    a = ap.parse_args()
    print(report(a.ref, a.test, a.null, a.tile, a.band, a.truth, match=a.match))
    if a.out:
        dims, fa = read_footprints(a.ref / "footprints.bin")
        _, fb = read_footprints(a.test / "footprints.bin")
        pairs = match_cells(fa, fb, dims) if a.match else None
        rows = compare(a.ref, a.test, a.tile, a.truth, pairs)
        keys = list(rows[0]) if rows else ["id"]
        lines = ["\t".join(keys)] + [
            "\t".join(f"{r[k]:.6g}" for k in keys) for r in rows
        ]
        a.out.write_text("\n".join(lines) + "\n")
```

In the module docstring, after the `truth_r_*` item:

```text
- `truth_fp_*` (with `--truth`): the footprint's correlation over the frame with the
  footprint of the truth unit its trace follows best (main's "footprint r"), and
  `truth_overlap`, that unit's `cat_overlap` flag;
- with `--match`, cells are paired by footprint (cosine at least 0.5, centroids within
  20 px) instead of by id, for runs whose Discover differed; a reference cell without a
  partner counts as lost.
```

- [ ] **Step 4: Run the tests**

From the repository root: `uv run --no-project --with numpy python -m unittest discover tools/cala-eval`
Expected: all pass (the scipy tests of main's demixing tools are skipped as before).

- [ ] **Step 5: Format, check and commit**

`uvx ruff format tools/cala-eval/factor_closeness.py tools/cala-eval/test_factor_closeness.py`, `uvx ruff check --fix tools/cala-eval/factor_closeness.py tools/cala-eval/test_factor_closeness.py`. Expected: clean.

```bash
git add tools/cala-eval/factor_closeness.py tools/cala-eval/test_factor_closeness.py
git commit -m "feat(cala-eval): factor_closeness pairs cells by footprint and measures footprints against the truth"
```

---

### Task 4: The arms of phase 4a

**Files:**

- Modify: `tools/cala-eval/factor_arms.py`, `tools/cala-eval/test_factor_arms.py`

**Interfaces:**

- Consumes: `qc_eval --from`, `--ff-seed-run` (Task 1), `--lookback-source` (Task 2), `factor_closeness.report(..., match=True)` (Task 3).
- Produces:
  - `LOOKBACK: list[str]`, `LIVE_ARMS: tuple[str, ...]`, `SEEDED: tuple[str, ...]`
  - `arms(refine: int, budget: int = DEFAULT_BUDGET, seed: tuple[int, Path] | None = None) -> dict[str, list[str]]` with the arms `live`, `lb_raw`, `lb_fac`, `lb_live`, and with `seed` also `seed`, `raw_seed`, `live_seed`
  - `run_order(todo: list[str]) -> tuple[list[str], list[str]]`
  - `flat_row(run: Path) -> tuple[str, int, str, bool] | None`, `seed_line(run: Path) -> str | None`, `lookback_row(run: Path) -> tuple[str, int, int, int, float] | None`
  - CLI: `factor_arms.py ... --seed-from F`

- [ ] **Step 1: Write the failing tests**

In `tools/cala-eval/test_factor_arms.py`, class `Arms`: in `test_remedy_arms_are_plain_recal_with_another_cut_and_not_run_by_default`, replace the last assertion by

```python
        self.assertEqual(
            sorted(set(a) - set(A.default_arms(a))),
            sorted(list(A.REMEDIES) + ["live", "lb_raw", "lb_fac", "lb_live"]),
        )
```

and add:

```python
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
            a["lb_fac"], a["lb_raw"] + ["--lookback-source", "factors", "--tiling", "offset"]
        )
        self.assertEqual(
            a["lb_live"],
            a["lb_fac"] + ["--replay-source", "factors", "--extract-engine", "factors"],
        )
        cmd = A.command(Path("qc"), Path("rec"), Path("out/lb_fac"), a["lb_fac"], True, 100)
        self.assertEqual(cmd[cmd.index("--factors-out") + 1], "out/lb_fac/factors")
        cmd = A.command(Path("qc"), Path("rec"), Path("out/lb_raw"), a["lb_raw"], True, 100)
        self.assertNotIn("--factors-out", cmd)

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
                "live_seed": ("raw_seed", False),
                "lb_fac": ("lb_raw", True),
                "lb_live": ("lb_raw", True),
            },
        )

    def test_flat_field_and_look_back_rows(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            run = Path(t) / "live_seed"
            run.mkdir()
            (run / "run.json").write_text(json.dumps({"cmd": ["qc", "--ff-seed-run", "s"]}))
            (run / "flat_field_updates.tsv").write_text(
                "frame\toutcome\tfirst\tbins\tframes_used\tgain_sd\ttissue_sd\tresidual\tdark"
                "\tchange_median\tchange_p99\tchange_max\tsolve_s\n"
                "2999\tupdated\t1\t12\t2400\t0.05000\t0.10000\t1.000e-3\t4.500\t0.1\t0.2\t0.3\t0.50\n"
                "4199\tskipped: too little motion\t\t\t\t\t\t\t\t\t\t\t0.01\n"
                "5399\tupdated\t0\t14\t4800\t0.04000\t0.10000\t1.000e-3\t4.750\t0.1\t0.2\t0.3\t0.40\n"
            )
            self.assertEqual(A.flat_row(run), ("live_seed", 2, "2999", True))
            line = A.seed_line(run)
            assert line is not None
            self.assertIn(
                "made at its frame 5399, 4800 frames used, gain sd 0.04000, dark 4.750", line
            )
            (run / "lookback.tsv").write_text(
                "rate\tmax_frames\tcatchup\tdouble\tframes\tpushed\tcell_frames\tbirths"
                "\tin_need\twall_s\tdrain_steps\tdrain_frames\n"
                "2\t3000\t0\t0\t24000\t23000\t510000\t140\t3\t812.500\t900\t1800\n"
                "\ntenth\tframes\tcell_frames\n0\t10\t20\n"
            )
            self.assertEqual(A.lookback_row(run), ("live_seed", 24000, 510000, 3, 812.5))
            self.assertIsNone(A.lookback_row(Path(t) / "missing"))
            self.assertIsNone(A.flat_row(Path(t) / "missing"))
```

- [ ] **Step 2: Run to see them fail**

From the repository root: `uv run --no-project --with numpy python -m unittest discover tools/cala-eval`
Expected: the new tests error (no arm `live`, no `seed` parameter, no `run_order`, `flat_row`, `seed_line`, `lookback_row`).

- [ ] **Step 3: Implement**

In `tools/cala-eval/factor_arms.py`, below `DEFAULT_BUDGET`:

```python
# Phase 4a (spec Amendment 2, A9 and A11): what a live run may claim. main's default
# look-back arm `LBD-x2` (tools/cala-eval/results/2026-11-19-concurrent-refine.md), with
# the Extract pass added so that the arms have traces to compare.
LOOKBACK: list[str] = [
    "--passes",
    "1",
    "--joint-update",
    "all",
    "--joint-sign",
    "all",
    "--lookback",
    "2",
    "--lookback-drain",
    "4800",
    "--extract-pass",
]
# The arms of phase 4a; not in the default set.
LIVE_ARMS: tuple[str, ...] = (
    "live",
    "seed",
    "raw_seed",
    "live_seed",
    "lb_raw",
    "lb_fac",
    "lb_live",
)
# Arms that read the flat field the run `seed` ended with.
SEEDED: tuple[str, ...] = ("raw_seed", "live_seed")
```

`arms` gets the parameter and the new arms:

```python
def arms(
    refine: int,
    budget: int = DEFAULT_BUDGET,
    seed: tuple[int, Path] | None = None,
) -> dict[str, list[str]]:
    """Arm name to its `qc_eval` flags (without recording, output and factor folder).

    `seed`: (first frame of the later stretch the run `seed` reads, that run's folder); adds
    the arms `seed`, `raw_seed` and `live_seed`."""
```

and, before the loop over `REMEDIES`:

```python
    out["live"] = out["offset"] + ["--extract-engine", "factors"]
    out["lb_raw"] = list(LOOKBACK)
    out["lb_fac"] = LOOKBACK + ["--lookback-source", "factors", "--tiling", "offset"]
    out["lb_live"] = out["lb_fac"] + [
        "--replay-source",
        "factors",
        "--extract-engine",
        "factors",
    ]
    if seed is not None:
        first, run = seed
        out["seed"] = ["--passes", "1", "--from", str(first)]
        out["raw_seed"] = full + ["--ff-seed-run", str(run)]
        out["live_seed"] = out["live"] + ["--ff-seed-run", str(run)]
```

`default_arms`:

```python
def default_arms(table: dict[str, list[str]]) -> list[str]:
    """The arms run without `--arms`: all but the remedy arms and the arms of phase 4a."""
    return [n for n in table if n not in REMEDIES and n not in LIVE_ARMS]
```

In `command`, the condition for the factor folder becomes:

```python
    if "--replay-source" in flags or "--lookback-source" in flags:
        cmd += ["--factors-out", str(run / "factors")]
```

Below `extract_row`:

```python
def flat_row(run: Path) -> tuple[str, int, str, bool] | None:
    """(arm, flat field maps made, frame of the first map or "none", seeded) from the arm's
    `flat_field_updates.tsv` and command."""
    path = run / "flat_field_updates.tsv"
    if not path.exists():
        return None
    made = [r for r in factor_closeness.read_tsv(path) if r["outcome"] == "updated"]
    seeded = "--ff-seed-run" in json.loads((run / "run.json").read_text())["cmd"]
    return (run.name, len(made), made[0]["frame"] if made else "none", seeded)


def seed_line(run: Path) -> str | None:
    """What the run `seed` left as the seed: its last map's frame, frames used, gain sd and
    dark level."""
    path = run / "flat_field_updates.tsv"
    if not path.exists():
        return None
    made = [r for r in factor_closeness.read_tsv(path) if r["outcome"] == "updated"]
    if not made:
        return f"The run `{run.name}` made no flat field map: the seeded arms have no seed."
    m = made[-1]
    return (
        f"Seed: the last flat field map of the run `{run.name}` (made at its frame "
        f"{m['frame']}, {m['frames_used']} frames used, gain sd {m['gain_sd']}, "
        f"dark {m['dark']})."
    )


def lookback_row(run: Path) -> tuple[str, int, int, int, float] | None:
    """(arm, look-back frames, cell-frames, cells still in need, look-back wall s) from the
    first row of `lookback.tsv`."""
    path = run / "lookback.tsv"
    if not path.exists():
        return None
    rows = factor_closeness.read_tsv(path)
    if not rows:
        return None
    r = rows[0]
    return (
        run.name,
        int(r["frames"]),
        int(r["cell_frames"]),
        int(r["in_need"]),
        float(r["wall_s"]),
    )


def run_order(todo: list[str]) -> tuple[list[str], list[str]]:
    """The arms to run first, one at a time (the run `seed`, whose flat field the seeded
    arms read), and the rest."""
    return [n for n in todo if n == "seed"], [n for n in todo if n != "seed"]
```

In `report`, the loop over the arms becomes:

```python
    for n in have:
        if (
            n in TILINGS
            or n in ("plain_recal", "chosen", "c_chosen", "live")
            or n in REMEDIES
        ):
            if "raw" in have:
                text.append(
                    factor_closeness.report(
                        out_dir / "raw",
                        out_dir / n,
                        nulls,
                        tile=line_step(arm_cmd(out_dir, n)),
                        truth_path=truth,
                    )
                )
        elif n == "live_seed" and "raw_seed" in have:
            text.append(
                factor_closeness.report(
                    out_dir / "raw_seed",
                    out_dir / n,
                    [],
                    tile=line_step(arm_cmd(out_dir, n)),
                    truth_path=truth,
                )
            )
        elif n in ("lb_fac", "lb_live") and "lb_raw" in have:
            text.append(
                factor_closeness.report(
                    out_dir / "lb_raw",
                    out_dir / n,
                    [],
                    tile=line_step(arm_cmd(out_dir, n)),
                    truth_path=truth,
                    match=True,
                )
            )
        elif n.startswith("x_") and n != "x_raw" and "x_raw" in have:
            # ... unchanged ...
```

At the end of `report`, before `return "\n".join(text)`:

```python
    if "seed" in have:
        line = seed_line(out_dir / "seed")
        if line:
            text += [line, ""]
    flats = [r for r in (flat_row(out_dir / n) for n in have) if r]
    if flats:
        text += [
            "| arm | seeded | flat field maps made | first map at frame |",
            "| --- | --- | --- | --- |",
        ]
        text += [
            f"| {a} | {'yes' if s else 'no'} | {k} | {f} |" for a, k, f, s in flats
        ]
        text.append("")
    lbs = [r for r in (lookback_row(out_dir / n) for n in have) if r]
    if lbs:
        text += [
            "| arm | look-back frames | cell-frames | cells still in need | look-back wall s |",
            "| --- | --- | --- | --- | --- |",
        ]
        text += [f"| {a} | {f} | {c} | {k} | {w:.1f} |" for a, f, c, k, w in lbs]
        text.append("")
```

In `main`, add the argument

```python
    ap.add_argument(
        "--seed-from",
        type=int,
        help="phase 4a: first frame of the later stretch of the recording that the arm "
        "`seed` runs on; its final flat field seeds the arms raw_seed and live_seed",
    )
```

build the table with the seed

```python
    seed = (a.seed_from, a.out / "seed") if a.seed_from is not None else None
    table = arms(a.refine, a.budget, seed)
    names = a.arms.split(",") if a.arms else default_arms(table)
    unknown = [n for n in names if n not in table]
    assert not unknown, (
        f"unknown arms: {unknown} (seed, raw_seed and live_seed need --seed-from)"
    )
    assert "seed" in names or not set(SEEDED) & set(names), (
        "raw_seed and live_seed need the arm seed in --arms"
    )
```

and replace the two lines from `todo = ...` to the end of the `with ThreadPoolExecutor(...)` block by:

```python
    todo = [n for n in names if not done(a.out / n, cmds[n])]
    first, rest = run_order(todo)
    codes = [run_arm(n, cmds[n], a.out / n) for n in first]
    if "seed" in names and not done(a.out / "seed", cmds["seed"]):
        held = [n for n in rest if n in SEEDED]
        rest = [n for n in rest if n not in SEEDED]
        if held:
            print(f"seed did not finish: not run: {', '.join(held)}", flush=True)
            codes.append(1)
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        codes += list(pool.map(lambda n: run_arm(n, cmds[n], a.out / n), rest))
```

In the module docstring: add `[--seed-from F]` to the usage line, and after the `x_raw` item:

```text
- Phase 4a, not in the default set:
  - `live`: Discover's own factors (pass 1, offset grids) feed the refine replays
    (rebuilt frames) and the Extract pass (factor engine); no factor comes from a replay.
  - `seed` (needs `--seed-from F`): Discover alone on the later stretch of the recording
    that starts at frame F; `raw_seed` and `live_seed` are `raw` and `live` with the flat
    field it ended with in force from frame 0 (`--ff-seed-run`). `seed` runs first.
  - `lb_raw`: main's default look-back arm (`LBD-x2`) with an Extract pass; `lb_fac`: the
    same with the look-back reading Discover's factors; `lb_live`: `lb_fac` with Extract on
    the factor engine. Their Discovers differ, so the report pairs cells by footprint.
```

- [ ] **Step 4: Run the tests**

From the repository root: `uv run --no-project --with numpy python -m unittest discover tools/cala-eval`
Expected: all pass. Then a dry run prints the commands: `uv run --no-project --with numpy python tools/cala-eval/factor_arms.py --rec REC --out OUT --frames 12000 --budget 3000000 --arms raw,live,seed,raw_seed,live_seed,lb_raw,lb_fac,lb_live --seed-from 12000 --dry-run` (any two folder names for `REC` and `OUT`; `--dry-run` reads nothing). Expected: eight commands; `seed`'s has `--from 12000`; the seeded two end their flags with `--ff-seed-run OUT/seed`; `lb_fac` and `lb_live` have `--factors-out`.

- [ ] **Step 5: Format, check and commit**

`uvx ruff format` and `uvx ruff check --fix` on `tools/cala-eval/factor_arms.py` and `tools/cala-eval/test_factor_arms.py`. Expected: clean.

```bash
git add tools/cala-eval/factor_arms.py tools/cala-eval/test_factor_arms.py
git commit -m "feat(cala-eval): factor_arms runs the live, seeded and look-back arms of phase 4a"
```

---

### Task 5: Run the arms and write the report

The controller builds and starts the runs (they need the recordings and take about three hours); a subagent writes the report from their outputs.

**Files:**

- Create: `tools/cala-eval/results/2026-11-19-factor-phase4a.md`
- Modify: `docs/CHANGELOG.md`, `tools/cala-eval/README.md`

**Interfaces:**

- Consumes: Tasks 1 to 4; the identity reference of the Precondition step; phase 1's `run_all.sh` (recording paths, `--truth` files, motion flags) and phase 1's report (the `chosen` losses).
- Produces: the report. The decisions it informs (what phase 4 claims for live runs, whether phase 4 adds the seed for streams) are the owner's.

- [ ] **Step 1: Build and check the new flags on a short run**

When no run uses the release binary, build from `crates/cala`: `cargo build --release --example qc_eval`. In the run folder, `identity.sh` (written in the Precondition step) is:

```bash
#!/bin/bash
# Usage: bash identity.sh QC_EVAL RECORDING OUT
# Two short runs whose outputs must not change in phase 4a: the arm `chosen`
# and main's default look-back arm, both without the flags of phase 4a.
set -eu
Q="$1"
REC="$2"
OUT="$3"
mkdir -p "$OUT"
COMMON="--motion --frames 1800 --budget 3000000"
"$Q" real "$REC" "$OUT/chosen" --passes 3 --later-passes refine --extract-pass \
  --replay-source factors --tiling offset --factors-pass 2 \
  --factors-out "$OUT/chosen/factors" $COMMON > "$OUT/chosen.log" 2>&1
"$Q" real "$REC" "$OUT/lb_raw" --passes 1 --joint-update all --joint-sign all \
  --lookback 2 --lookback-drain 4800 --extract-pass $COMMON > "$OUT/lb_raw.log" 2>&1
```

and `smoke.sh`, the new flags on the same short stretch:

```bash
#!/bin/bash
# Usage: bash smoke.sh QC_EVAL RECORDING OUT
set -eu
Q="$1"
REC="$2"
OUT="$3"
mkdir -p "$OUT"
COMMON="--motion --frames 1800 --budget 3000000"
"$Q" real "$REC" "$OUT/lb_fac" --passes 1 --joint-update all --joint-sign all \
  --lookback 2 --lookback-drain 4800 --extract-pass --lookback-source factors \
  --tiling offset --factors-out "$OUT/lb_fac/factors" $COMMON > "$OUT/lb_fac.log" 2>&1
"$Q" real "$REC" "$OUT/seed" --passes 1 --from 1800 --motion --frames 3600 \
  --budget 3000000 > "$OUT/seed.log" 2>&1
```

Run `bash <run folder>/smoke.sh crates/cala/target/release/examples/qc_eval <wl24_01 recording> <run folder>/smoke` (a real recording, because the synthetic sets make no flat field map). Expected: both return 0; `smoke/lb_fac.log` ends with a line `lookback source: factors, N window files read` with N at least 3; `smoke/lb_fac/lookback.tsv` has more than 0 look-back frames; `smoke/seed.log` has `from frame 1800:`; `smoke/seed/flat_field_updates.tsv` has at least one `updated` row (the first map is due 150 s, 3000 frames, into the stretch, which is why the seed line runs 3600 frames; phase 1 saw the real recordings' first map at frame 2999). If it has none, the seeded arms of Step 3 would fail: report it and run Step 3 without them.

- [ ] **Step 2: The identity check**

Run `bash <run folder>/identity.sh crates/cala/target/release/examples/qc_eval <wl200 recording> <run folder>/identity_after`. Then, one command each, `cmp` these files of `identity_before` against `identity_after`: `chosen/extract_trace.f32`, `chosen/footprints.bin`, `chosen/factors/w0000000.fac`, `lb_raw/extract_trace.f32`, `lb_raw/footprints.bin`. Expected: no output from any `cmp` (identical). If a file differs, stop the phase and report which file; do not run Step 3.

- [ ] **Step 3: Run the arms**

Write `run_4a.sh` into the run folder with the six recording paths and the three `--truth` files taken from phase 1's `run_all.sh` (same motion flags as there), then run it in the background with one plain command (`bash <run folder>/run_4a.sh <run folder>`). Its content, with the six variables set at the top:

```bash
#!/bin/bash
# Phase 4a runs. Usage: bash run_4a.sh RUN_FOLDER
set -u
RUN="$1"
WL200=""; WL24_01=""; WL24_04=""; PLAIN=""; MOTION=""; V4=""
T_WL200=""; T_PLAIN=""; T_MOTION=""
FA="uv run --no-project --with numpy python tools/cala-eval/factor_arms.py"
B="--budget 3000000"
S200="--frames 12000 --refine 5 $B --jobs 2"
S600="--frames 6000 --refine 2 $B --jobs 2"
LIVE="raw,live,seed,raw_seed,live_seed"
LB="raw,live,lb_raw,lb_fac,lb_live"
(
  $FA --rec "$WL24_01" --out "$RUN/wl24_01" $S200 --arms $LIVE --seed-from 12000
  $FA --rec "$WL24_04" --out "$RUN/wl24_04" $S200 --arms $LIVE --seed-from 12000
  $FA --rec "$WL200" --out "$RUN/wl200" $S200 --arms $LB --truth "$T_WL200"
) > "$RUN/run_200.log" 2>&1 &
(
  $FA --rec "$V4" --out "$RUN/v4" $S600 --arms $LIVE --seed-from 6000
  $FA --rec "$PLAIN" --out "$RUN/plain" $S600 --arms $LB --truth "$T_PLAIN"
  $FA --rec "$MOTION" --out "$RUN/motion" $S600 --arms $LB --truth "$T_MOTION"
) > "$RUN/run_600.log" 2>&1 &
wait
```

The script must be run from the repository root (the relative path of `factor_arms.py`). Two series of at most 2 runs each keep the machine at 4 runs. Scale as in phases 1 and 2: first 12000 frames and 5 refine replays at 200 px, first 6000 and 2 at 600 px, budget 3,000,000 on every arm. The arms per recording:

| recording | truth                | arms                                           |
| --------- | -------------------- | ---------------------------------------------- |
| `wl24_01` | none                 | `raw`, `live`, `seed`, `raw_seed`, `live_seed` |
| `wl24_04` | none                 | `raw`, `live`, `seed`, `raw_seed`, `live_seed` |
| `v4`      | none                 | `raw`, `live`, `seed`, `raw_seed`, `live_seed` |
| `wl200`   | usable               | `raw`, `live`, `lb_raw`, `lb_fac`, `lb_live`   |
| `plain`   | usable               | `raw`, `live`, `lb_raw`, `lb_fac`, `lb_live`   |
| `motion`  | not usable (phase 1) | `raw`, `live`, `lb_raw`, `lb_fac`, `lb_live`   |

`seed` runs on frames 12000 to 24000 (200 px) or 6000 to 12000 (600 px). Check in each `seed/run.log` the line `from frame F: N frames`: if N is smaller than the stretch, the stretch is shorter (the report says so). When both series end, check that every arm's `run.json` has return code 0 and list any that does not.

- [ ] **Step 4: Write the report**

`tools/cala-eval/results/2026-11-19-factor-phase4a.md`, every number produced by a throwaway script (kept in the run folder, not in the repository) from each recording's `report.md`, `run.json`, `flat_field_updates.tsv`, `lookback.tsv` and logs; nothing copied by hand. Sections in this order:

1. **What a live run may claim.** One bullet per claim, each with its evidence in a few words:
   - Discover's factors without a seed: per recording, gate A1 of `live` against `raw` (pass or the rules that fail).
   - Discover's factors with a seed of the same sensor: per real recording, `live_seed` against `raw_seed`.
   - Look-back on factors: per truth recording, `lb_fac` and `lb_live` against `lb_raw`.
     A failed rule is worded as a limit, in this form: "On `<recording>` the factors of Discover fail rule <n> (<value> against <limit>). A live run on this kind of recording may not claim that its <traces | footprints | footprints at tile lines | truth correlation> are within gate A1 of a file run." A passed claim: "On `<recording>` ... meet gate A1: a live run may claim this for recordings like it (bounded runs, see How it was measured)." End the section with "Decision: open, for the owner."
2. **Gate A1, live factors.** Table per recording: QC-pass cells (lost), each rule's value and result for `live` against `raw`; for the three real recordings also `live_seed` against `raw_seed`. Beside it, the trace and footprint loss of phase 1's `chosen` (recalibrated factors) from the phase 1 report, so the reader sees the gap the missing replay leaves. Say that `live_seed` is judged against `raw_seed`, not against `raw`: the seed changes Discover, so `raw` has other cells.
3. **The flat field seed.** Per real recording: the seed stretch (frames, and whether it was shorter), the seed map's frames used, gain sd and dark level (`seed_line`); the first map frame of `raw` against `raw_seed` (the arms' flat field table); the trace and footprint loss of `live`, `live_seed` and phase 1's `chosen`, and what share of the gap between `live` and `chosen` the seed closes. State that the seed comes from the same recording an hour later at most, so this is an upper bound on what a seed from another session gives, and that the synthetic sets got no seed because they never get a map.
4. **Look-back on factors.** Per truth recording, for `lb_fac` and `lb_live` against `lb_raw`: pairs and lost QC-pass cells; rules 1 to 4 as gate A1 gives them; the losses over paired cells alone; the truth correlation medians and paired difference; the truth footprint correlation (all cells, and cells whose truth unit overlaps another); look-back frames, cell-frames, cells still in need and look-back wall seconds from the arms' look-back table, and the window files read (`lookback source:` line of `run.log`). One sentence on whether the factor source served fewer look-back frames (blocks wait for their window; idle budget is not banked) and how many.
5. **How it was measured.** Commits of the binary and of the tools, machine, scale, budget, arms with their flags, the recordings, the identity check of Step 2 (files compared, result), the smoke run of Step 1, run times.
6. **What was not measured.** At least: the refine replays of the harness still read the raw file for the preprocessor's running state and the missing-sample mask (a live run has neither; phase 3 removes the replays); a seed from a different session days apart; look-back on factors on the real recordings and with a seed; the joint flags on the flat field arms; live latency and a real-time stream (`--offered-fps` refuses `--replay-source factors`); full-length recordings and the default budget; the browser; main's demixing metrics (they need a minisim `oracle.bin`).

Writing rules as in the earlier reports: short plain sentences, a term defined once, no machine paths.

- [ ] **Step 5: Docs**

- `docs/CHANGELOG.md`, `## [Unreleased]`, in the style of the cala evaluation entries there: one entry: `qc_eval --from` (a later stretch of a recording), `--ff-seed-run` (a flat field seed as the app stores it per device), `--lookback-source factors` (main's look-back reads Discover's factor windows); `factor_closeness --match` (cells paired by footprint) and the truth footprint correlation; the phase 4a arms of `factor_arms.py`.
- `tools/cala-eval/README.md`: the arms `live`, `seed`, `raw_seed`, `live_seed`, `lb_raw`, `lb_fac`, `lb_live` and `--seed-from` in the factor arms section; `--match` in the factor closeness lines.

`npx prettier --write` on the two files and the report.

- [ ] **Step 6: Final check and commit**

All checks of Global Constraints.

```bash
git add tools/cala-eval/results/2026-11-19-factor-phase4a.md docs/CHANGELOG.md tools/cala-eval/README.md
git commit -m "docs(cala-eval): phase 4a results: what a live run may claim from Discover's factors, a flat field seed and look-back on factors"
```

---

## Not in this phase

- **App changes.** Storing and loading a flat field seed for live streams (A7) and look-back in the app (A9, when main brings it there) are phase 4. This phase changes no code under `crates/cala/src`, `apps/` or `packages/`.
- **A real earlier session.** Two sessions of the same sensor days apart would test the seed honestly. `wl24_01` and `wl24_04` may be such a pair, but nothing in the repository says they share a sensor; checking the device and adding cross-session arms is left for the owner to decide.
- **Look-back on factors on the real recordings, with a seed, or with refine replays.** One question per arm set keeps the night's runs to about three hours; these combinations follow if the truth recordings show a difference.
- **The joint flags on the flat field arms.** Phase 2 measures the joint replay on rebuilt frames; phase 3's gate checks it on and off (A8).
- **Removing the raw replay from the refine replays.** It needs Refine on factors (phase 3).
- **Main's demixing metrics** (`demix_metrics.py`, `demix_report.py`): they need a minisim `oracle.bin`. The truth footprint correlation of Task 3 stands in for their footprint r.
- **A live timing run.** `--offered-fps` refuses `--replay-source factors`; live latency belongs to phase 4's e2e run on a simulated stream.

## Self-review notes

- Spec coverage: A4's "rules 1 to 4 checked for the live case on a simulated stream before phase 4" is Tasks 1, 4 and 5 (arms `live`, `live_seed`); A7's "seed of the same sensor" is Task 1 (`--ff-seed-run` reads what the app stores: gain, offsets, dark, frames); A9's second frame source for the look-back is Task 2; A9's "measured in phase 4a together with the seed" is Tasks 3 to 5; A11's 4a row is this plan.
- Names used across tasks: `Recording::{first, skip, locate}`, `read_seed_run`, `--from`, `--ff-seed-run`, `FactorDump::written`, `FactorFrames::{new, frame, reads}`, `LB_WINDOWS`, `mark_missing`, `choose_block`, `LookBack::{source, avail}`, `--lookback-source`, `MATCH_COS`, `MATCH_PX`, `footprint_centroid`, `match_cells`, `truth_best`, `read_truth_footprints`, `fp_truth_r`, `report(match=...)`, `LOOKBACK`, `LIVE_ARMS`, `SEEDED`, `run_order`, `flat_row`, `seed_line`, `lookback_row`, `--seed-from`, the arms `live`, `seed`, `raw_seed`, `live_seed`, `lb_raw`, `lb_fac`, `lb_live`.
- Not verified while planning, each turned into a step: whether the borrow of `self.valid` in `LookBack::frame` compiles as written (Task 2, Step 7 gives the fallback); whether the seed stretch of the smoke run reaches its first map (Task 5, Step 1); the recording paths, truth files and frame counts (Task 5 reads them from phase 1's `run_all.sh` and from each `seed/run.log`); that `qc_eval` is deterministic run to run on one machine, which the identity check assumes (phase 2's plan relied on the same).
