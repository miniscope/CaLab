# cala factors on the settle, slice 1: factor format v2 on `main`, and the Final settle on factors in `qc_eval`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `main` gets the factor format v2 with the offset grids (ported from PR #437), and `qc_eval` can run the
Final settle on Discover's own factors (`--settle-source factors`), also after a Discover without look-back (the
stream case). With these, the evaluation of the design's decision 6 can run. Nothing changes in the app except what
`?compress` writes.

**Architecture:**

- The compressor port is ten commits of #437, cherry-picked in order. Their crate and app parts apply cleanly to
  `origin/main` (trial on 23 Nov); `crates/cala/examples/qc_eval.rs` conflicts and keeps `main`'s side.
- In `qc_eval`:
  - `FactorDump` gains a tiling and is finished at Discover's last frame.
  - A `FactorFrames` reader rebuilds a frame from its window.
  - `LookBack::frame` takes the settle's frames from that reader instead of re-reading and preprocessing the
    recording.
  - A settle-only `LookBack` exists when `--settle-frames N` is given with `--lookback 0`.
- The settle loop itself (`LookBack::settle`) is not changed.

**Tech Stack:** Rust (crate `calab-cala`, example `qc_eval`), TypeScript with vitest (`apps/cala`, compressor only).

**Spec:** `docs/superpowers/specs/2026-11-23-cala-factors-on-settle-design.md`: decision 1 (Discover's own windows,
offset grids), decision 2 (main's settle fed with rebuilt frames), decision 5 (the stream case,
`--joint-update refine`), decision 6 (acceptance), section 7 (PR 1 and 1e).

## Decided for the owner's review

Each says what would change it.

1. **The port is a cherry-pick of `d5c554de 8f2d68d2 df82d2cd 557f2ae2 ff0bc170 021fd688 c65c27c3 6f0484db 6e5871e6
6cbb937b`, without `-x`.**
   - The original one-sentence messages stay; `-x` would add a body line.
   - Review per commit is possible because each was reviewed on #437.
   - What would change it: the maintainer prefers one squashed commit. Then squash in Task 1 with
     `feat(cala): factor format v2 with offset grids and two SVD power iterations`.
2. **The app's compressor keeps plain tiles by default.**
   - `?compress` writes v2 files with plain tiles and two SVD power iterations. Before, it wrote v1 files with one
     power iteration.
   - The history review keeps working: it reads plain tiles only (`6cbb937b`).
   - No export changes: the factors are not in the export. The README and the changelog say what `?compress` now
     writes.
3. **The harness settles on Discover's own dump (pass 0), on the tiling given by `--factors-tiling`.** Look-back during
   Discover stays on raw frames (spec decision 3).
4. **`FactorDump` is finished at Discover's last frame, before the drain and the settle.**
   - Today it is finished after all passes (`qc_eval.rs:6826`). Then the settle could not read the last, shorter
     window.
   - The later call stays and writes nothing, because the compressor is empty (pinned by a test).
5. **`--settle-frames N` with `--lookback 0` now settles.**
   - Today that combination builds no `LookBack` and runs no settle, without a message (`qc_eval.rs:5499-5503`).
   - It now builds a settle-only `LookBack` with rate 0. Discover must stay byte-identical; Task 5's run check
     verifies this.
   - The README of `tools/cala-eval` says so.
6. **The evaluation runs only after the owner's yes.**
   - Task 6 writes the evaluation plan and the run script and commits them before any run.
   - The runs and their report are PR 1e (`eval/cala-settle-factors`), not this branch.

## Global Constraints

- The app's behaviour without `?compress` is unchanged. With `?compress` only the factor files differ: v2 and two
  power iterations. The app tests the port brings must pass, and none of `main`'s may change except those the port
  commits change.
- `qc_eval` without the new flags gives the same outputs as before. Exception: `--factors-out` files are now v2 with
  two power iterations, as decision 2 says for the app.
- The settle code (`LookBack::settle`) and the engine (`crates/cala/src/discover/`) are not changed.
- No Rust panic reachable from JS (the port's WASM bindings refuse bad input with `JsError`, as on #437).
- Rust checks, from `crates/cala`:
  - `cargo fmt --all --check`;
  - `cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings`;
  - the same with `--features pybindings` and with `--features diagnostics`;
  - `cargo test --no-default-features --features jsbindings`;
  - `cargo test --example qc_eval --no-default-features --features jsbindings` (inferred: the examples' unit tests run
    this way; check the crate's CI workflow first and use its command).
- App checks, from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala` (never bare
  vitest: the pretest hook rebuilds the WASM package), `npx prettier --check` on every touched file outside `crates`.
- Commits: one sentence, conventional prefix, no body, no co-author trailer and no tool or assistant attribution.
  Never amend. Do not push.
- No machine paths or user names in committed files.
- The shell refuses long compound commands (`cd ... &&` chains, loops, heredocs that contain git): put anything
  longer in a script file under a git-ignored scratch folder and run it with one plain command.
- Branch: `feat/cala-factors-settle`.

## Review Focus

1. **The port is #437's code, unchanged.** Only `qc_eval.rs` is resolved by hand.
   - Pinned: `git diff 6cbb937b HEAD -- crates/cala/src/compress apps/cala/src/lib/compress-*.ts
apps/cala/src/workers/compress-*.ts` shows no change.
   - Task 1 records this diff's output in its report.
2. **Discover does not move.**
   - With `--settle-source factors` or a settle-only `LookBack`, the library at the settle's start must be the one the
     run without the flag ends Discover with.
   - Pinned: Task 5's run check (the `_settle0` library against the plain run's final library) and Task 4's run check.
3. **A settle frame from the factors is the live frame as compressed.** Pixels never valid in the window are NaN, as
   a live missing pixel. Nothing is preprocessed, warped or masked again.
   - Pinned: Task 3 "factor_frames_rebuild_the_dumped_window_and_mark_never_valid_pixels".
4. **The settle never mixes sources.** With `--settle-source factors` no raw frame is read during the settle.
   - Pinned: Task 4's printed counter `raw frames read 0` in the run check; the code reads raw frames only in the
     `else` branch.

## File Structure

| File                                                                                                                                                                  | Change        | Responsibility                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/cala/src/compress/blend.rs`                                                                                                                                   | create (port) | tilings, blend layout, `reconstruct`                                                                                                                             |
| `crates/cala/src/compress/mod.rs`, `js.rs`, `review.rs`; `crates/cala/src/discover/reservoir.rs`                                                                      | modify (port) | format v2, missing samples, discarded variance and valid share, two power iterations, WASM layout and header                                                     |
| `crates/cala/examples/discover_eval.rs`, `history_review.rs`                                                                                                          | modify (port) | callers of the v2 API                                                                                                                                            |
| `apps/cala/src/lib/compress-feed.ts`, `compress-runner.ts`, `cala-wasm.ts`; `apps/cala/src/workers/compress-types.ts`, `compress-worker.ts`; `apps/cala/package.json` | modify (port) | the app's compressor takes its layout and header from WASM, writes v2                                                                                            |
| `apps/cala/src/__tests__/compress.test.ts`, `review.test.ts`                                                                                                          | modify (port) | tests                                                                                                                                                            |
| `crates/cala/examples/qc_eval.rs`                                                                                                                                     | modify        | v2 API (Task 1); `FACTOR_WINDOW`, `--factors-tiling`, finish at Discover's end (2); `FactorFrames` (3); `--settle-source` (4); settle-only `LookBack` (5); tests |
| `apps/cala/README.md` ("Compression"), `docs/CHANGELOG.md` (Unreleased)                                                                                               | modify        | what `?compress` writes                                                                                                                                          |
| `tools/cala-eval/README.md`                                                                                                                                           | modify        | the new `qc_eval` flags                                                                                                                                          |
| `tools/cala-eval/settle_factors.sh`                                                                                                                                   | create        | runs one arm of the evaluation                                                                                                                                   |
| `tools/cala-eval/results/2026-11-24-settle-factors-plan.md`                                                                                                           | create        | the evaluation plan and its pre-set lines                                                                                                                        |

---

### Task 1: Port the factor format v2 from #437

**Files:** as "port" in the table; `crates/cala/examples/qc_eval.rs` (keep `main`'s side, then the v2 API);
`apps/cala/README.md`; `docs/CHANGELOG.md`.

The tests come with the commits: the crate's `compress` tests (blend weights sum to 1, v1 files still read, a
non-finite pixel is a missing sample, v2 round trip with tiling, refusals of wrong tile counts) and the app's
`compress.test.ts` and `review.test.ts` changes. They do not exist on `main`, so they cannot pass there.

- [ ] **Step 1: Cherry-pick in order.** Write a scratch script (git-ignored folder) that runs, one per line:
      `git cherry-pick d5c554de` … `git cherry-pick 6cbb937b`. Run it one commit at a time. On a conflict in
      `crates/cala/examples/qc_eval.rs` (expected for `8f2d68d2`, `ff0bc170`, `021fd688`, `c65c27c3`): run
      `git checkout --ours -- crates/cala/examples/qc_eval.rs`, `git add` it, and
      `git -c core.editor=true cherry-pick --continue`. Any other conflict: stop and report it. The trial applied every
      other file cleanly.
- [ ] **Step 2: Make `qc_eval` compile with the v2 API.** Expected change (from `ff0bc170`):
      `WindowFactors::to_bytes(&self, tile: usize)` became `to_bytes(&self)`. In `FactorDump::write`:

```rust
    fn write(&self, wf: calab_cala::compress::WindowFactors) {
        let name = format!("w{:07}.fac", wf.start);
        std::fs::write(self.dir.join(name), wf.to_bytes()).unwrap();
    }
```

Remove the `tile` field of `FactorDump` if nothing else reads it. Update the doc comment: "(format v2,
`CALAFAC2`)". Fix any other compile error the same way, reading the v2 signature in `compress/mod.rs`; change
nothing else.

- [ ] **Step 3: Run the Rust and app checks** (Global Constraints). Expected: all pass. Then run
      `git diff 6cbb937b HEAD -- crates/cala/src/compress apps/cala/src/lib/compress-feed.ts apps/cala/src/lib/compress-runner.ts apps/cala/src/workers/compress-types.ts apps/cala/src/workers/compress-worker.ts`
      and expect no output (Review Focus 1). Report the output if there is any.
- [ ] **Step 4: Docs.** In `apps/cala/README.md`, "Compression (experimental, `?compress`)": the files are factor
      format v2 (`CALAFAC2`: tiling in the header, per-pixel discarded variance and valid share; v1 files still read).
      The tiles are plain by default (the history review reads plain tiles only). The SVD runs two power iterations.
      In `docs/CHANGELOG.md` under Unreleased: "cala: `?compress` writes factor format v2 (plain tiles, two SVD power
      iterations); the crate can cut and blend the frame on two offset grids."
- [ ] **Step 5: Commit** the Step 2 and 4 changes:

```bash
git commit -m "fix(cala): qc_eval writes factor files in format v2 and the docs say what ?compress writes"
```

---

### Task 2: `--factors-tiling` and a dump finished at Discover's last frame

**Files:** `crates/cala/examples/qc_eval.rs` (`FactorDump`, its construction near `qc_eval.rs:5593`, the
end-of-pass block near `qc_eval.rs:6284`, the tests module at `qc_eval.rs:7111`).

**Interfaces:**

- `const FACTOR_WINDOW: usize = 600;`
- `FactorDump::new(dir: &Path, dims: Dims, tiling: Tiling) -> FactorDump`
- `FactorDump::finish(&mut self)`: writes the last window once; writes nothing when the compressor is empty.

`Tiling` is `calab_cala::compress::blend::Tiling`.

- [ ] **Step 1: Failing test** (in `mod tests`):

```rust
    /// A fresh scratch folder for a test's files.
    fn scratch_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("qc_eval-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// `n` frames of a smooth moving pattern (deterministic).
    fn pattern_frames(dims: Dims, n: usize) -> Vec<Vec<f32>> {
        (0..n)
            .map(|t| {
                (0..dims.pixels())
                    .map(|p| {
                        let (y, x) = ((p / dims.width) as f32, (p % dims.width) as f32);
                        20.0 + 4.0 * (0.05 * t as f32 + 0.11 * x).sin() + 3.0 * (0.07 * y - 0.03 * t as f32).cos()
                    })
                    .collect()
            })
            .collect()
    }

    #[test]
    fn factor_dump_writes_v2_windows_with_its_tiling_and_finishes_once() {
        let dims = Dims::new(96, 80).unwrap();
        let dir = scratch_dir("dump");
        let mut fd = FactorDump::new(&dir, dims, Tiling::Offset);
        for fr in pattern_frames(dims, 1250) {
            fd.push(&fr);
        }
        fd.finish();
        fd.finish();
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["w0000000.fac", "w0000600.fac", "w0001200.fac"]);
        for (name, frames) in [("w0000000.fac", 600), ("w0001200.fac", 50)] {
            let wf = WindowFactors::from_bytes(&std::fs::read(dir.join(name)).unwrap()).unwrap();
            assert_eq!(wf.frames, frames, "{name}");
            assert_eq!(wf.tiling, Tiling::Offset, "{name}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
```

If `WindowFactors` names its tiling field differently, use the v2 header's accessor (read `compress/mod.rs`
after Task 1) and keep the assertion.

- [ ] **Step 2: Run it; expect a compile failure** (`FactorDump::new` takes two arguments).
- [ ] **Step 3: Implement.**

```rust
/// Frames per factor window (`--factors-out`; the app's compressor uses the same).
const FACTOR_WINDOW: usize = 600;

/// `--factors-out`: compresses the preprocessed frames of Discover window by
/// window and writes each window's factors (format v2, `CALAFAC2`, cut by
/// `--factors-tiling`) to `dir/w<start frame>.fac`.
struct FactorDump {
    dir: PathBuf,
    wc: calab_cala::compress::WindowCompressor,
}

impl FactorDump {
    fn new(dir: &Path, dims: Dims, tiling: Tiling) -> FactorDump {
        std::fs::create_dir_all(dir).unwrap();
        let cfg = calab_cala::compress::CompressConfig {
            window: FACTOR_WINDOW,
            tiling,
            ..calab_cala::compress::CompressConfig::default()
        };
        FactorDump {
            dir: dir.to_path_buf(),
            wc: calab_cala::compress::WindowCompressor::new(dims, cfg),
        }
    }

    fn write(&self, wf: calab_cala::compress::WindowFactors) {
        let name = format!("w{:07}.fac", wf.start);
        std::fs::write(self.dir.join(name), wf.to_bytes()).unwrap();
    }

    fn push(&mut self, frame: &[f32]) {
        if let Some(wf) = self.wc.push(frame) {
            self.write(wf);
        }
    }

    /// Write the last, shorter window; nothing when no frame is buffered
    /// (a second call, or a recording of whole windows).
    fn finish(&mut self) {
        if let Some(wf) = self.wc.flush() {
            self.write(wf);
        }
    }
}
```

At the construction (`qc_eval.rs:5593-5594`):

```rust
    let factors_out: Option<PathBuf> = arg_value(&args, "--factors-out").map(PathBuf::from);
    // `--factors-tiling plain|offset` (default plain): how the dump cuts the frame.
    let factors_tiling = arg_value(&args, "--factors-tiling").map_or(Tiling::Plain, |s| {
        Tiling::parse(&s).unwrap_or_else(|| panic!("--factors-tiling: plain or offset, not {s:?}"))
    });
    assert!(
        factors_out.is_some() || arg_value(&args, "--factors-tiling").is_none(),
        "--factors-tiling needs --factors-out DIR"
    );
    let mut factors = factors_out
        .as_deref()
        .map(|d| FactorDump::new(d, dims, factors_tiling));
```

Before the drain block (the `if let (Some(lbk), Some(sl), 0, true) = (...)` that runs the drain, near
`qc_eval.rs:6284`), inside pass 0 at its last frame:

```rust
                // Discover's factors are complete before the drain and the
                // settle (`--settle-source factors` reads every window).
                if let (true, 0, Some(fd)) = (last, pass, factors.as_mut()) {
                    fd.finish();
                }
```

Keep the existing `fd.finish()` at `qc_eval.rs:6826`. If the flag parser keeps a list of known flags, add
`--factors-tiling` there (read first: `grep -n '"--settle-frames",' qc_eval.rs`).

- [ ] **Step 4: Run the test and the Rust checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala-eval): qc_eval's factor dump takes a tiling and is complete when Discover ends"
```

---

### Task 3: `FactorFrames`, a frame rebuilt from its factor window

**Files:** `crates/cala/examples/qc_eval.rs`.

**Interfaces:**

- `FactorFrames::new(dir: &Path, window: usize) -> FactorFrames`
- `FactorFrames::frame(&mut self, f: usize, y: &mut [f32]) -> Result<(), String>`
- `FactorFrames::reads(&self) -> u64`
- `fn never_valid(wf: &WindowFactors) -> Vec<bool>`

- [ ] **Step 1: Failing test:**

```rust
    #[test]
    fn factor_frames_rebuild_the_dumped_window_and_mark_never_valid_pixels() {
        let dims = Dims::new(96, 80).unwrap();
        let dir = scratch_dir("frames");
        let mut fd = FactorDump::new(&dir, dims, Tiling::Offset);
        for mut fr in pattern_frames(dims, 650) {
            fr[5] = f32::NAN; // never valid
            fd.push(&fr);
        }
        fd.finish();
        let wf = WindowFactors::from_bytes(&std::fs::read(dir.join("w0000600.fac")).unwrap()).unwrap();
        let mut want = vec![0.0f32; dims.pixels()];
        wf.layout().reconstruct(&wf, 10, &mut want);
        let mut ff = FactorFrames::new(&dir, FACTOR_WINDOW);
        let mut got = vec![0.0f32; dims.pixels()];
        ff.frame(610, &mut got).unwrap();
        assert!(got[5].is_nan());
        for p in (0..dims.pixels()).filter(|&p| p != 5) {
            assert_eq!(got[p].to_bits(), want[p].to_bits(), "pixel {p}");
        }
        // Read once, served from the cache after.
        ff.frame(611, &mut got).unwrap();
        assert_eq!(ff.reads(), 1);
        // Past the last frame of its window, and a window not on disk.
        assert!(ff.frame(650, &mut got).unwrap_err().contains("past"));
        assert!(ff.frame(1300, &mut got).unwrap_err().contains("w0001200.fac"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
```

- [ ] **Step 2: Run it; expect a compile failure** (no `FactorFrames`).
- [ ] **Step 3: Implement** (from #437's `FactorFrames`, `qc_eval.rs:3834-3915` on `origin/feat/cala-factor-extract`,
      with errors instead of panics and the window size passed in):

```rust
/// Pixels with no valid sample in any frame of `wf` (valid share 0 in
/// every tile that covers them).
fn never_valid(wf: &WindowFactors) -> Vec<bool> {
    let width = wf.dims.width;
    let mut never = vec![true; wf.dims.pixels()];
    for tf in &wf.tiles {
        for y in 0..tf.h {
            let row = (tf.y0 + y) * width + tf.x0;
            for x in 0..tf.w {
                if tf.valid[y * tf.w + x] > 0.0 {
                    never[row + x] = false;
                }
            }
        }
    }
    never
}

/// Windows `FactorFrames` keeps decoded: the settle reads in plan order, so
/// the current and the next window are enough.
const FACTOR_CACHE: usize = 2;

/// `--settle-source factors`: the frames Discover compressed, read back from
/// the factor windows of a `FactorDump`. A frame is the live frame as
/// compressed: pixels never valid in its window are missing (NaN), as in the
/// live frame; nothing is preprocessed, warped or masked again. A pixel that
/// became valid partway through its window reads its window mean before that
/// point (a small difference from the live frame).
struct FactorFrames {
    dir: PathBuf,
    window: usize,
    cache: std::collections::VecDeque<(WindowFactors, BlendLayout, Vec<bool>)>,
    reads: u64,
}

impl FactorFrames {
    fn new(dir: &Path, window: usize) -> FactorFrames {
        FactorFrames {
            dir: dir.to_path_buf(),
            window,
            cache: Default::default(),
            reads: 0,
        }
    }

    /// Window files read (each cache miss).
    fn reads(&self) -> u64 {
        self.reads
    }

    /// Write stream frame `f`, rebuilt from its window, to `y`.
    fn frame(&mut self, f: usize, y: &mut [f32]) -> Result<(), String> {
        let start = (f / self.window) * self.window;
        let at = match self.cache.iter().position(|(wf, _, _)| wf.start as usize == start) {
            Some(i) => i,
            None => {
                let path = self.dir.join(format!("w{start:07}.fac"));
                let bytes = std::fs::read(&path)
                    .map_err(|e| format!("frame {f}: {} cannot be read ({e})", path.display()))?;
                let wf = WindowFactors::from_bytes(&bytes)
                    .ok_or_else(|| format!("{}: not a factor file", path.display()))?;
                let layout = wf.layout();
                let never = never_valid(&wf);
                if self.cache.len() == FACTOR_CACHE {
                    self.cache.pop_front();
                }
                self.cache.push_back((wf, layout, never));
                self.reads += 1;
                self.cache.len() - 1
            }
        };
        let (wf, layout, never) = &self.cache[at];
        if f - start >= wf.frames {
            return Err(format!("frame {f} is past the {} frames of window {start}", wf.frames));
        }
        if y.len() != wf.dims.pixels() {
            return Err(format!("frame {f}: {} pixels, the window has {}", y.len(), wf.dims.pixels()));
        }
        layout.reconstruct(wf, f - start, y);
        for (v, &nv) in y.iter_mut().zip(never) {
            if nv {
                *v = f32::NAN;
            }
        }
        Ok(())
    }
}
```

`BlendLayout` is `calab_cala::compress::blend::BlendLayout`. Add the `use` lines.

- [ ] **Step 4: Run the test and the Rust checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala-eval): qc_eval rebuilds a frame from its factor window"
```

---

### Task 4: `--settle-source factors`

**Files:** `crates/cala/examples/qc_eval.rs` (`LookBack` struct and `new`, `LookBack::frame` at
`qc_eval.rs:1643-1741`, `LookBack::settle`'s closing `println!` at `qc_eval.rs:1622-1631`, the `LookBack` set-up at
`qc_eval.rs:5507-5515`).

**Interfaces:**

- `enum SettleSource { Raw, Factors(PathBuf) }`
- `fn settle_source(args: &[String]) -> Result<SettleSource, String>`
- `LookBack.settle_src: Option<FactorFrames>`
- `LookBack.settle_raw: u64`: raw frames the settle read.

- [ ] **Step 1: Failing test:**

```rust
    #[test]
    fn settle_source_needs_the_factor_dump_and_a_settle() {
        let a = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        assert!(matches!(settle_source(&a("x")), Ok(SettleSource::Raw)));
        assert!(matches!(settle_source(&a("x --settle-source raw")), Ok(SettleSource::Raw)));
        let ok = settle_source(&a("x --settle-source factors --factors-out d --settle-frames 600"));
        assert!(matches!(ok, Ok(SettleSource::Factors(p)) if p == Path::new("d")));
        let e = settle_source(&a("x --settle-source factors --settle-frames 600")).unwrap_err();
        assert!(e.contains("--factors-out"), "{e}");
        let e = settle_source(&a("x --settle-source factors --factors-out d")).unwrap_err();
        assert!(e.contains("--settle-frames"), "{e}");
        let e = settle_source(&a("x --settle-source frames")).unwrap_err();
        assert!(e.contains("raw or factors"), "{e}");
    }
```

- [ ] **Step 2: Run it; expect a compile failure.**
- [ ] **Step 3: Implement.**

```rust
/// Where the end-of-Discover settle gets its frames (`--settle-source`).
enum SettleSource {
    /// Re-read from the recording and preprocessed (the default).
    Raw,
    /// Rebuilt from Discover's factor windows in this folder (`--factors-out`).
    Factors(PathBuf),
}

fn settle_source(args: &[String]) -> Result<SettleSource, String> {
    match arg_value(args, "--settle-source").as_deref() {
        None | Some("raw") => Ok(SettleSource::Raw),
        Some("factors") => {
            let dir = arg_value(args, "--factors-out")
                .ok_or("--settle-source factors needs --factors-out DIR")?;
            let n: usize = arg_value(args, "--settle-frames").map_or(0, |s| s.parse().unwrap_or(0));
            if n == 0 {
                return Err("--settle-source factors needs --settle-frames N".into());
            }
            Ok(SettleSource::Factors(PathBuf::from(dir)))
        }
        Some(o) => Err(format!("--settle-source: raw or factors, not {o:?}")),
    }
}
```

In `LookBack`, add the two fields (`settle_src: None`, `settle_raw: 0` in `new`). In `LookBack::frame`, the
frame comes from the factors when the settle feeds it (`self.full_observe`) and a source is set:

```rust
        let from_factors = self.full_observe && self.settle_src.is_some();
        if !from_factors && (f < self.raw_start || f >= self.raw_start + self.raw_n) {
            // ... the existing raw read, unchanged ...
        }
        // ... `idx`, `cs_skip`, `skip`: unchanged ...
        if from_factors {
            // The frame as Discover compressed it: no re-read, no
            // preprocessing (the block's preprocessor copy does not run).
            let src = self.settle_src.as_mut().unwrap();
            src.frame(f, &mut self.y)
                .unwrap_or_else(|m| panic!("settle on factors: {m}"));
        } else {
            if self.full_observe {
                self.settle_raw += 1;
            }
            // ... the existing `let o = ...; let raw = ...; pre.front(...)`
            //     through the motion branch and `pre.back(...)`, unchanged ...
        }
        if skip {
            return None;
        }
```

The settle still sets the noise from its preprocessor copy every 200 frames (`qc_eval.rs:1543-1545`). On factors
that copy does not run forward, so it sets the noise Discover ended with each time. That is intended: the
factors carry each frame's own live preprocessing. Say so in a comment there.

At the end of `settle`, extend the `println!` with the source:

```rust
        println!(
            "settle source: {}, {} raw frames read",
            match &self.settle_src {
                Some(s) => format!("factors ({} window files read)", s.reads()),
                None => "raw".into(),
            },
            self.settle_raw
        );
```

At the `LookBack` set-up:

```rust
    let settle_src = settle_source(&args).unwrap_or_else(|m| panic!("{m}"));
    if let Some(l) = lookback.as_mut() {
        // ... existing lines ...
        if let SettleSource::Factors(d) = &settle_src {
            l.settle_src = Some(FactorFrames::new(d, FACTOR_WINDOW));
        }
    }
```

Register `--settle-source` with the flag list if there is one (as in Task 2).

- [ ] **Step 4: Run the test and the Rust checks.** Expected: pass.
- [ ] **Step 5: Run check on one sim of the evaluation set** (bounded: `--frames 3000`).
  - Run twice: once with `--lookback 2 --joint-update all --settle-frames 3000 --settle-libs --factors-out DIR
--factors-tiling offset`, once with `--settle-source factors` added.
  - Expected: the second prints `settle source: factors (N window files read), 0 raw frames read`.
  - Expected: both runs' `_settle0` libraries are the same bytes, because Discover did not move.
  - Report the two settles' frames per second. Do not commit run outputs.
- [ ] **Step 6: Commit:**

```bash
git commit -m "feat(cala-eval): qc_eval's end-of-Discover settle can read Discover's factors"
```

---

### Task 5: A settle after a Discover without look-back

**Files:** `crates/cala/examples/qc_eval.rs` (the `lookback` construction at `qc_eval.rs:5499-5503`).

**Interfaces:** `fn lookback_wanted(rate: f64, catchup: usize, settle_frames: usize) -> bool`.

- [ ] **Step 1: Failing test:**

```rust
    #[test]
    fn a_settle_alone_keeps_a_lookback_without_look_back() {
        assert!(!lookback_wanted(0.0, 0, 0));
        assert!(lookback_wanted(2.0, 0, 0));
        assert!(lookback_wanted(0.0, 500, 0));
        assert!(lookback_wanted(0.0, 0, 18_000));
    }
```

- [ ] **Step 2: Run it; expect a compile failure.**
- [ ] **Step 3: Implement.**

```rust
/// Whether the run keeps a `LookBack`: look-back or catch-up, or an
/// end-of-Discover settle (`--settle-frames N`), which needs one even with
/// `--lookback 0` (rate 0: it never asks for a frame during Discover).
fn lookback_wanted(rate: f64, catchup: usize, settle_frames: usize) -> bool {
    rate > 0.0 || catchup > 0 || settle_frames > 0
}
```

```rust
    let mut lookback = lookback_wanted(lb_rate, lb_catchup, tail.settle.frames).then(|| {
        LookBack::new(
            lb_rate, lb_frames, lb_newest, lb_catchup, lb_double, lb_target, n_px,
        )
    });
```

Change the `lookback:` line printed after it so that a settle-only run says
`lookback: off (settle only)`.

- [ ] **Step 4: Run the test and the Rust checks.** Expected: pass.
- [ ] **Step 5: Run check that Discover does not move** (one sim, `--frames 3000`):
  - Run (a): `--lookback 0 --joint-update refine`.
  - Run (b): the same with `--settle-frames 3000 --settle-libs`.
  - Expected: (b)'s `_settle0` library is the same bytes as (a)'s final library. If it is not, stop and report what
    differs. Do not change the engine to make it pass.
  - Also run (c): (b) with `--factors-out DIR --factors-tiling offset --settle-source factors`. Expected:
    `0 raw frames read`.
- [ ] **Step 6: Docs and commit.** In `tools/cala-eval/README.md`, list `--factors-tiling`, `--settle-source` and the
      settle-only `LookBack` (and that `--lookback 0 --settle-frames N` used to run no settle).

```bash
git commit -m "feat(cala-eval): qc_eval settles after a Discover without look-back"
```

---

### Task 6: The evaluation plan and run script, committed before any run

**Files:** `tools/cala-eval/results/2026-11-24-settle-factors-plan.md`, `tools/cala-eval/settle_factors.sh`.

No test: these are documents and a driver. The runs themselves are PR 1e, after the owner's yes.

- [ ] **Step 1: Find the reference flags.**
  - Copy, verbatim, the `qc_eval` flags of settle-size's `SETTLE` arm and of the `#443` `REF+S` arm. They are in the
    run trees named by `tools/cala-eval/results/2026-11-22-settle-size.md` ("What was compared"); the command line is
    in each run's stdout header or command file (inferred location).
  - If they cannot be found, stop and ask the owner. Do not reconstruct them from memory.
- [ ] **Step 2: Write the plan** with these sections: Question (spec decisions 2 and 5); Arms; Recordings; Measures;
      Pre-set lines; Budget and load rules; What is read as post hoc.
  - **Arms.** Each is `BASE` = the `SETTLE` flags from Step 1, plus:
    - `SET-R`: nothing;
    - `SET-F`: `--factors-out $OUT/f --factors-tiling offset --settle-source factors`;
    - `STR-0`: `--lookback 0 --joint-update refine` with no `--settle-frames`;
    - `STR-F`: `--lookback 0 --joint-update refine` + `SET-F`'s flags;
    - `STR-FA`: `STR-F` with `--joint-update all`;
    - optional `STR-R`: `--lookback 0 --joint-update refine` with a raw settle, only if `STR-F` and `STR-0` are
      ambiguous.
  - **Recordings:** the two v3 sims at the real cell size used by settle-size; 3 of its 14 larger-cell sims (the
    first three by name); `wl24_01`, first 12,000 frames. Samara `10_43_21`, first 12,000 frames, if the budget
    allows. Two seeds per arm.
  - **Measures:** spec decision 6, computed with `tools/cala-eval/settle_size.py` (`report` for sims, `real` and
    `pair` for real data). Plus the frames per second of each settle from stdout.
  - **Pre-set lines:** spec decision 6, word for word, with the spread defined as the absolute difference between
    the two seeds of the reference arm, per measure.
  - **Budget:** at most 2 `qc_eval` processes at once; raw data read-only; outputs in a run folder outside the
    repository.
- [ ] **Step 3: Write `settle_factors.sh`.** Usage: `settle_factors.sh QC_EVAL RECORDING OUT ARM SEED [EXTRA...]`.
      It holds `BASE` from Step 1 and the arm table above, creates `OUT/ARM-sSEED`, runs `qc_eval` once with
      `--seed SEED`, and tees stdout to `run.log` there. Plain POSIX sh, one `case` per arm, no loops over runs: the
      caller starts each run.
- [ ] **Step 4: Prettier** on the plan file, then commit both:

```bash
git commit -m "docs(cala-eval): plan and run script for the settle on factors, before any run"
```

---

## Not in this slice

- Any app change beyond the compressor port: no `?factors`, no factor source in the look-back worker, no settle or
  Extract on factors in the app.
- `FactorExtractor`, `WindowProjector`, `min_valid` (#437's `project.rs`), `factor_refine.rs`, the `refineOnFactors`
  binding.
- Look-back on factors (`set_available`, `--lookback-source factors`).
- Running the evaluation (PR 1e, after the owner's yes).

## Later slices (task lists only)

### Slice 2: a stream's Final settle and Extract on its factors (`?factors`), PR 2 `feat/cala-factors-live`

Start after #491 has landed or been declined: both touch `slow-runner.ts` and `lookback-worker.ts`.

1. `?factors` turns compression on for the run (offset grids for a stream; `?review` refused with a message while it
   reads plain tiles only).
2. Web Lock per OPFS run folder and a sweep that skips locked folders (port `window-store.ts` from #440).
3. `factorState` for a live run (none, compressing, ready, unusable): ready once the stream has ended, the last
   window is compressed and the windows cover every recorded frame (from #440 and #442, without the replay source).
4. Look-back worker: a factor history source that opens compressed windows read-only, rebuilds frames (NaN where
   never valid) and solves them. It answers the same `request` messages and never creates, lists or removes files.
5. Live slow loop with `?factors`: built with `jointUpdate 'refine'` (or the owner's choice) and the held-out record.
   Test that Discover publishes the same libraries as without it.
6. `SlowRunner`: the Final settle after a stream ends, on the factor port, without look-back.
   - Its states (waiting for factors, sweep, final, done) each say what releases them on Stop, failure, a new
     Discover and a worker crash.
   - A request always settles: answer, timeout, or cancel.
7. Extract on a stream's factors: the back-fill promoted to the Extract stage (16 rebuilt frames at a time).
   - It waits for `ready`, can be cancelled, and is blocked with the reason when `unusable`.
   - `stageAvailability` and `LIVE_NOTE` follow.
8. Export:
   - the stage records carry `settle_source` and `source: 'factors'` with tiling, windows and mean rank;
   - the note that a stream's settle and Extract read its own factors;
   - the format version bump, said in the changelog.
9. Run panel and Steps: the settle and Extract on a stream show as on a file. The text says they read the stream's
   factors.
10. e2e: a simulated stream with `?factors` settles and extracts after it ends; the export says so. A stream without
    `?factors` is unchanged.
11. Docs: `stages.md`, README, USER_GUIDE, changelog.

### Slice 3: a file's settle and Extract on factors (`?factors=file`), PR 3 `feat/cala-factors-file`

1. A file run with `?factors=file` compresses Discover's frames on the offset grids.
2. The Final settle reads the factors only when every window is compressed at Discover's end. Otherwise it re-reads
   the file as today, and the panel says why. It never waits.
3. Extract reads the factors when `ready`. Otherwise it replays the file and says why.
4. Export: each stage's source.
5. e2e on the cell movie: with the switch, both stages on factors, and the export says so; without it, unchanged.
6. Docs.

### Slice 4: defaults, PR 4 `feat/cala-factors-default`

Only after the evaluation (PR 1e) and the owner's decision:

1. Stream default: `?factors` on (if `STR-F` passed).
2. File default: stays on re-read frames unless `SET-F` passed and compression keeps pace (parallel compression is
   a separate slice).
3. Docs and changelog.

## Questions only the owner can answer

These are not in any task above; slices 2-4 depend on them.

1. Does "not frame-to-frame, but what works on history" mean the closed-form `refine_on_factors`, or main's settle
   fed from the factors? Recommendation: main's settle fed from the factors (spec decision 2), because
   `refine_on_factors` cannot run the cluster replay.
2. Which app slice first: streams (recommended: the main use case, and a stream has nothing today) or files?
3. A stream's slow loop: replay in the settle only (`refine`, recommended for slice 2: the live Discover stays as
   today) or in Discover too (`all`, as a file)?
4. PRs #437, #440, #442: close as superseded once PR 1 is open (recommended), or keep them open?
5. The acceptance lines of spec decision 6 and the evaluation budget (recordings, seeds).
6. A stream's export after Extract on factors: replace the live traces (as a file's Extract does), or keep both?
   The factor traces are denoised.

## Self-review notes

- **Spec coverage.**
  - Decision 1: Tasks 1-2.
  - Decision 2 (frame route, the low-rank risk measured): Tasks 3-4 and 6.
  - Decision 5 (the stream case in the harness): Task 5 and arms `STR-*`.
  - Decision 6: Task 6.
  - Section 7 PR 1: this plan; PR 1e: Task 6's plan.
- **Names across tasks.**
  - Task 2: `FACTOR_WINDOW`, `FactorDump::new(dir, dims, tiling)`, `scratch_dir`, `pattern_frames`.
  - Task 3: `never_valid`, `FACTOR_CACHE`, `FactorFrames::{new, frame, reads}`.
  - Task 4: `SettleSource`, `settle_source`, `LookBack.{settle_src, settle_raw}`.
  - Task 5: `lookback_wanted`.
- **Faults of earlier plans checked.**
  - Every new state is bounded or ends with the run: the cache holds 2 windows, the counters are printed.
  - No job is pending across calls.
  - Each test fails without its feature: a compile failure, or a refusal that does not exist yet.
  - No test depends on machine speed.
  - The only default that changes outputs is the port's v2 with two power iterations (decision 2, said in README
    and changelog). No export changes.
- **What could not be verified by reading.**
  - That `qc_eval` compiles after Task 1 with only the `to_bytes` change. The trial cherry-pick was not built.
  - That `WindowCompressor::flush` returns `None` when empty. Task 2's test pins it.
  - The v2 field or accessor name for a window's tiling.
  - That a rate-0 `LookBack` leaves Discover unchanged. Task 5's run check verifies it.
  - Whether `cargo test --example qc_eval` is how CI runs the example's tests.
  - Where the settle-size study's exact flags are stored (Task 6, Step 1).
