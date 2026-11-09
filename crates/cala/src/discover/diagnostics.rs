//! Opt-in, target-only frozen inputs for keep-test diagnosis.
//!
//! Compiled only with `diagnostics`; inactive unless both CALA_TRACE_CELL and
//! CALA_TRACE_DIR are set. This module writes observations and never solves,
//! mutates loop state, spends work credit, or advances the loop RNG.
use super::ledger::Evidence;
use super::local::{BgBasis, Cell, Column, Fit, Problem, Rect};
use super::SlowLoop;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

struct Config {
    target: u64,
    dir: PathBuf,
    sequence: AtomicU64,
}

/// Reserve a fresh output directory without modifying any earlier capture.
fn initialize_directory(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    if fs::read_dir(dir)?.next().transpose()?.is_some() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "capture directory is not empty; choose a fresh CALA_TRACE_DIR",
        ));
    }
    // Exclusive creation also prevents two initializers from claiming the
    // same empty directory between the emptiness check and the first write.
    let mut format = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("FORMAT.txt"))?;
    format.write_all(FORMAT.as_bytes())?;
    format.flush()
}

fn config() -> Option<&'static Config> {
    static CONFIG: OnceLock<Option<Config>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let target = std::env::var("CALA_TRACE_CELL").ok()?.parse().ok()?;
            let dir = PathBuf::from(std::env::var("CALA_TRACE_DIR").ok()?);
            initialize_directory(&dir).unwrap_or_else(|error| {
                panic!(
                    "CALA_TRACE_DIR must be fresh or empty ({}): {error}",
                    dir.display()
                )
            });
            Some(Config {
                target,
                dir,
                sequence: AtomicU64::new(0),
            })
        })
        .as_ref()
}

pub(super) fn selected(id: u64) -> bool {
    config().is_some_and(|c| c.target == id)
}

fn directory(kind: &str, frame: u64, tile: usize) -> Option<(u64, PathBuf)> {
    let config = config()?;
    let sequence = config.sequence.fetch_add(1, Ordering::Relaxed);
    // A hard bound prevents accidental use as an unbounded recording dumper.
    if sequence >= 10_000 {
        return None;
    }
    let path = config
        .dir
        .join(format!("{kind}_{sequence:06}_slow{frame:06}_tile{tile}"));
    fs::create_dir_all(&path).expect("create diagnostic event directory");
    Some((sequence, path))
}

fn file(path: &Path) -> BufWriter<File> {
    BufWriter::new(File::create(path).expect("create diagnostic file"))
}

fn floats(path: &Path, values: impl IntoIterator<Item = f32>) {
    let mut f = file(path);
    for value in values {
        f.write_all(&value.to_le_bytes()).unwrap();
    }
    f.flush().unwrap();
}

fn doubles(path: &Path, values: impl IntoIterator<Item = f64>) {
    let mut f = file(path);
    for value in values {
        f.write_all(&value.to_le_bytes()).unwrap();
    }
    f.flush().unwrap();
}

fn integers(path: &Path, values: impl IntoIterator<Item = u32>) {
    let mut f = file(path);
    for value in values {
        f.write_all(&value.to_le_bytes()).unwrap();
    }
    f.flush().unwrap();
}

fn sparse(
    out: &mut impl Write,
    height: usize,
    width: usize,
    id: u64,
    pixels: &[u32],
    raw: &[f32],
    filtered: &[f32],
) {
    assert_eq!(pixels.len(), raw.len());
    assert_eq!(pixels.len(), filtered.len());
    assert!(u32::try_from(id).is_ok(), "CALAFP01 ID overflow");
    out.write_all(b"CALAFP01").unwrap();
    for v in [
        height as u32,
        width as u32,
        1,
        id as u32,
        pixels.len() as u32,
    ] {
        out.write_all(&v.to_le_bytes()).unwrap();
    }
    for p in pixels {
        out.write_all(&p.to_le_bytes()).unwrap();
    }
    for v in raw.iter().chain(filtered) {
        out.write_all(&v.to_le_bytes()).unwrap();
    }
}

fn shape_hash(pixels: &[u32], raw: &[f32], filtered: &[f32]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for bytes in pixels
        .iter()
        .map(|x| x.to_le_bytes())
        .chain(raw.iter().map(|x| x.to_le_bytes()))
        .chain(filtered.iter().map(|x| x.to_le_bytes()))
    {
        for byte in bytes {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
        }
    }
    hash
}

fn cell(path: &Path, slow: &SlowLoop, cell: &Cell) -> u64 {
    sparse(
        &mut file(path),
        slow.dims.height,
        slow.dims.width,
        cell.id,
        &cell.pix,
        &cell.raw,
        &cell.filt,
    );
    shape_hash(&cell.pix, &cell.raw, &cell.filt)
}

fn published(path: &Path, slow: &SlowLoop, id: u64) -> Option<u64> {
    let lib = slow.published.as_ref()?;
    let slot = lib.slot(id)?;
    let (pixels, raw) = lib.unfiltered(slot);
    let (_, filtered) = lib.filtered(slot);
    sparse(
        &mut file(path),
        slow.dims.height,
        slow.dims.width,
        id,
        pixels,
        raw,
        filtered,
    );
    Some(shape_hash(pixels, raw, filtered))
}

fn context(path: &Path, slow: &SlowLoop, id: u64, tile: usize) -> BufWriter<File> {
    let mut meta = file(&path.join("meta.tsv"));
    writeln!(meta, "key\tvalue").unwrap();
    for (key, value) in [
        ("target_id", id.to_string()),
        ("slow_frame", slow.frames.to_string()),
        ("tile", tile.to_string()),
        ("height", slow.dims.height.to_string()),
        ("width", slow.dims.width.to_string()),
        (
            "published_version",
            slow.published
                .as_ref()
                .map_or(0, |l| l.version())
                .to_string(),
        ),
        ("ledger_projection_version", slow.lproj.version.to_string()),
    ] {
        writeln!(meta, "{key}\t{value}").unwrap();
    }
    if let Some(c) = slow.cells.iter().find(|c| c.id == id) {
        let hash = cell(&path.join("target_working.bin"), slow, c);
        writeln!(meta, "working_hash_fnv1a64\t{hash:016x}").unwrap();
    }
    if let Some(hash) = published(&path.join("target_published.bin"), slow, id) {
        writeln!(meta, "published_hash_fnv1a64\t{hash:016x}").unwrap();
    }
    if let Some(ev) = slow.ledger.get(&id) {
        writeln!(meta, "ledger_debug\t{ev:?}").unwrap();
    }
    meta
}

fn event(sequence: u64, path: &Path, slow: &SlowLoop, kind: &str, id: u64, tile: usize) {
    let config = config().unwrap();
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(config.dir.join("events.tsv"))
        .unwrap();
    if f.metadata().unwrap().len() == 0 {
        writeln!(f, "sequence\tslow_frame\tkind\tid\ttile\tpath").unwrap();
    }
    writeln!(
        f,
        "{sequence}\t{}\t{kind}\t{id}\t{tile}\t{}",
        slow.frames,
        path.file_name().unwrap().to_string_lossy()
    )
    .unwrap();
}

fn tile_arrays(path: &Path, slow: &SlowLoop, rect: Rect) {
    let pixels = || {
        (rect.y0..rect.y0 + rect.h)
            .flat_map(|y| (rect.x0..rect.x0 + rect.w).map(move |x| y * slow.dims.width + x))
    };
    floats(
        &path.join("inv_sigma.f32"),
        pixels().map(|p| slow.inv_sigma[p]),
    );
    let mask: Vec<u8> = pixels().map(|p| slow.fov[p]).collect();
    fs::write(path.join("fov.u8"), mask).unwrap();
}

pub(super) fn probe(slow: &SlowLoop, original_frame: u64, tile: usize, ids: &[u64]) {
    let Some(config) = config() else {
        return;
    };
    let id = config.target;
    if !ids.contains(&id) {
        return;
    }
    let Some((sequence, path)) = directory("probe", slow.frames, tile) else {
        return;
    };
    let rect = slow.tiles[tile].rect;
    let mut meta = context(&path, slow, id, tile);
    writeln!(meta, "probe_original_frame\t{original_frame}").unwrap();
    tile_arrays(&path, slow, rect);
    meta.flush().unwrap();
    drop(meta);
    event(sequence, &path, slow, "probe", id, tile);
}

pub(super) fn noise(slow: &SlowLoop) {
    let Some(config) = config() else {
        return;
    };
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(config.dir.join("noise_updates.tsv"))
        .unwrap();
    if f.metadata().unwrap().len() == 0 {
        writeln!(f, "slow_frame").unwrap();
    }
    writeln!(f, "{}", slow.frames).unwrap();
}

#[derive(Clone, Copy)]
pub(super) struct Outcome {
    pub kind: &'static str,
    pub partner: u64,
    pub took: f32,
}

fn columns(path: &Path, name: &str, cols: &[Column]) {
    let mut table = file(&path.join(format!("{name}_columns.tsv")));
    writeln!(table, "slot\tid\tstart\tlength").unwrap();
    let mut start = 0;
    for (slot, col) in cols.iter().enumerate() {
        writeln!(table, "{slot}\t{}\t{start}\t{}", col.id, col.pix.len()).unwrap();
        start += col.pix.len();
    }
    integers(
        &path.join(format!("{name}_pixels.u32")),
        cols.iter().flat_map(|c| c.pix.iter().copied()),
    );
    floats(
        &path.join(format!("{name}_values.f32")),
        cols.iter().flat_map(|c| c.val.iter().copied()),
    );
}

fn fits(path: &Path, name: &str, fits: &[Fit]) {
    floats(
        &path.join(format!("{name}_c.f32")),
        fits.iter().flat_map(|f| f.c.iter().copied()),
    );
    doubles(
        &path.join(format!("{name}_beta.f64")),
        fits.iter().flat_map(|f| f.beta.iter().copied()),
    );
    doubles(
        &path.join(format!("{name}_chi2.f64")),
        fits.iter().map(|f| f.chi2),
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn keep(
    slow: &SlowLoop,
    id: u64,
    tile: usize,
    probes: &[super::reservoir::Probe],
    ys: &[Vec<f32>],
    proj: &[(Vec<f64>, f64)],
    bg: &BgBasis,
    full: &Problem,
    red: &Problem,
    full_fits: &[Fit],
    red_fits: &[Fit],
    share: &[f32],
    target_slot: usize,
    dof: f64,
    mean: f64,
    sd: f64,
    pass_at: f64,
    before: Option<&Evidence>,
    outcomes: &[Outcome],
) {
    if !selected(id) {
        return;
    }
    let Some((sequence, path)) = directory("keep", slow.frames, tile) else {
        return;
    };
    let rect = slow.tiles[tile].rect;
    let mut meta = context(&path, slow, id, tile);
    for (key, value) in [
        ("rect_y0", rect.y0.to_string()),
        ("rect_x0", rect.x0.to_string()),
        ("rect_height", rect.h.to_string()),
        ("rect_width", rect.w.to_string()),
        ("n_probe", ys.len().to_string()),
        ("n_full", full.cols.len().to_string()),
        ("n_red", red.cols.len().to_string()),
        ("n_bg", bg.k.to_string()),
        ("target_slot", target_slot.to_string()),
        ("dof", dof.to_string()),
        ("fov_pixels", slow.fov_px(rect).to_string()),
        ("rho", slow.rho.to_string()),
        ("null_mean", mean.to_string()),
        ("null_sd", sd.to_string()),
        ("keep_z", slow.cfg.keep_z.to_string()),
        ("pass_at", pass_at.to_string()),
    ] {
        writeln!(meta, "{key}\t{value}").unwrap();
    }
    if let Some(ev) = before {
        writeln!(meta, "ledger_before_debug\t{ev:?}").unwrap();
    }
    tile_arrays(&path, slow, rect);
    floats(
        &path.join("y.f32"),
        ys.iter().flat_map(|y| y.iter().copied()),
    );
    floats(
        &path.join("bg_maps.f32"),
        bg.maps.iter().flat_map(|m| m.iter().copied()),
    );
    doubles(&path.join("bg_inv.f64"), bg.inv.iter().copied());
    doubles(
        &path.join("proj.f64"),
        proj.iter().flat_map(|p| p.0.iter().copied()),
    );
    doubles(&path.join("yy.f64"), proj.iter().map(|p| p.1));
    columns(&path, "full", &full.cols);
    columns(&path, "red", &red.cols);
    doubles(&path.join("full_q.f64"), full.q.iter().copied());
    doubles(&path.join("red_q.f64"), red.q.iter().copied());
    floats(&path.join("neighbor_share.f32"), share.iter().copied());
    fits(&path, "full", full_fits);
    fits(&path, "red", red_fits);
    let mut table = file(&path.join("probes.tsv"));
    writeln!(table, "row\tprobe_original_frame\tchi2_full\tchi2_red\ts2\tgain\tnormalized_gain\tci\tpartner\ttook\toutcome\tbefore_passes\tbefore_fails\tbefore_redundant\tafter_passes\tafter_fails\tafter_redundant").unwrap();
    let originals: Vec<_> = probes
        .iter()
        .filter(|p| p.cells.contains(&id))
        .map(|p| p.slot.frame)
        .collect();
    let counts = |ev: Option<&Evidence>| ev.map_or((0, 0, 0), |e| (e.passes, e.fails, e.redundant));
    let (bp, bf, br) = counts(before);
    let (ap, af, ar) = counts(slow.ledger.get(&id));
    for (row, ((f, r), outcome)) in full_fits.iter().zip(red_fits).zip(outcomes).enumerate() {
        let s2 = (f.chi2 / dof).max(1.0);
        let gain = r.chi2 - f.chi2;
        writeln!(table, "{row}\t{}\t{}\t{}\t{s2}\t{gain}\t{}\t{}\t{}\t{}\t{}\t{bp}\t{bf}\t{br}\t{ap}\t{af}\t{ar}", originals[row], f.chi2,r.chi2,gain/s2,f.c[target_slot],outcome.partner,outcome.took,outcome.kind).unwrap();
    }
    table.flush().unwrap();
    drop(table);
    meta.flush().unwrap();
    drop(meta);
    event(sequence, &path, slow, "keep", id, tile);
}

pub(super) fn refine(slow: &SlowLoop, old: &Cell, new: &Cell, margin: f32, source: u64) {
    if !selected(old.id) {
        return;
    }
    let tile = slow
        .tile_of(old.center.0, old.center.1)
        .unwrap_or(usize::MAX);
    let Some((sequence, path)) = directory("refine", slow.frames, tile) else {
        return;
    };
    let mut meta = context(&path, slow, old.id, tile);
    let old_hash = cell(&path.join("old.bin"), slow, old);
    let new_hash = cell(&path.join("new.bin"), slow, new);
    writeln!(meta,"old_hash_fnv1a64\t{old_hash:016x}\nnew_hash_fnv1a64\t{new_hash:016x}\nmargin\t{margin}\nsource\t{source}").unwrap();
    if tile != usize::MAX {
        tile_arrays(&path, slow, slow.tiles[tile].rect);
    }
    meta.flush().unwrap();
    drop(meta);
    event(sequence, &path, slow, "refine", old.id, tile);
}

pub(super) fn delete(slow: &SlowLoop, target: &Cell, reason: &str) {
    if !selected(target.id) {
        return;
    }
    let tile = slow
        .tile_of(target.center.0, target.center.1)
        .unwrap_or(usize::MAX);
    let Some((sequence, path)) = directory("delete", slow.frames, tile) else {
        return;
    };
    let mut meta = context(&path, slow, target.id, tile);
    writeln!(meta, "reason\t{reason}").unwrap();
    if tile != usize::MAX {
        tile_arrays(&path, slow, slow.tiles[tile].rect);
    }
    meta.flush().unwrap();
    drop(meta);
    event(sequence, &path, slow, "delete", target.id, tile);
}

const FORMAT: &str = r#"Target-only keep evidence, enabled with cargo feature diagnostics and CALA_TRACE_CELL=<id>, CALA_TRACE_DIR=<dir>. Default builds contain no hooks. CALA_TRACE_DIR must be absent or empty: initialization rejects a nonempty directory and never deletes or overwrites an earlier capture. Choose a new directory for every run. Separate event directories are bounded to 10000 events. All integers/floats are little-endian, flat arrays row-major, zero-based tile-local sparse pixel indices.
events.tsv orders completed capture events (sequence); a row is appended only after its metadata, tables and arrays have been flushed/closed. slow_frame is the internal observed counter: during probe capture this is the original zero-based probe index (observe has not yet incremented it); keep/refine/delete use the completed observed count. Probe original_frame is zero-based slow-loop input index. With example --start S, original probe recording index=S+probe_original_frame and consumed frame=S+probe_original_frame+1; keep/refine/delete recording consumed frame=S+slow_frame.
meta.tsv is key/value. It includes tile crop, global dimensions, published and ledger versions, target cell hashes (FNV1a64 over LE pixels then raw then filtered; ID/dimensions excluded), and exact evidence Debug before/after. target_working.bin/target_published.bin and refine old.bin/new.bin are single-cell CALAFP01 (global pixels; raw then filtered). No published file means target not published. Working candidate snapshots can precede publication.
keep directories: y.f32[n_probe,rect_height*rect_width] is the ACTUAL quantized-then-decoded whitened probe, not residual; bg_maps.f32[n_bg,npix], bg_inv.f64[n_bg,n_bg] (ridge-adjusted inverse), proj.f64[n_probe,n_bg], yy.f64[n_probe] are EXACT inputs used by native solve. First 9 background maps are the tile basis; the final map is the added broad target bump. Background coefficients are unconstrained; cell coefficients nonnegative. Projection uses native f32 products accumulated in f64; recomputing matrix products in all-f64 can differ slightly.
full_columns.tsv/red_columns.tsv give slot,id,start,length into concatenated full_pixels.u32/full_values.f32 and red equivalents (already whitened). full_q.f64/red_q.f64 are native reduced Grams. neighbor_share.f32 aligns red slots. full_c.f32[n_probe,n_full], full_beta.f64[n_probe,n_bg], full_chi2.f64[n_probe] and red equivalents preserve native results. Native NNLS uses up to 100 coordinate sweeps; independent optimum may differ.
probes.tsv records the actual pass/fail/redundant branch plus exact native scores, original probe index, target coefficient, takeover partner/took, and ledger counts before/after the whole batch (repeated on each row). s2=max(full_chi2/dof,1); gain=red_chi2-full_chi2; normalized_gain=gain/s2; pass iff normalized_gain>pass_at. No extra solve is performed for diagnostics.
fov.u8[npix] and inv_sigma.f32[npix] are the CURRENT test crop mask/weights. Probe directories save capture-time inv_sigma, published/working target and original index for version/weight-age comparisons. noise_updates.tsv gives times of set_noise. Refine and deletion directories save current inv_sigma for their target-center tile; crop dimensions can be read from keep metadata / loop geometry. Use saved global filtered footprint times frozen KEEP inv_sigma when substituting a new target into the same problem. Hold other columns/background/y fixed for old-vs-new comparison; changing these is a separate counterfactual.
Reuse across refined shapes and sparse changes is not proof of causality: correlate per-probe evidence and compare the same frozen inputs. No live algorithm decisions, work credits, schedules, or random state are modified by these captures.
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_directory_accepts_fresh_and_empty_but_preserves_used() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "cala-capture-dir-test-{}-{stamp}",
            std::process::id()
        ));
        // Exclusive creation establishes that this test owns the cleanup root.
        fs::create_dir(&root).unwrap();
        let fresh = root.join("fresh");
        initialize_directory(&fresh).unwrap();
        assert_eq!(
            fs::read_to_string(fresh.join("FORMAT.txt")).unwrap(),
            FORMAT
        );
        let empty = root.join("empty");
        fs::create_dir(&empty).unwrap();
        initialize_directory(&empty).unwrap();
        let used = root.join("used");
        fs::create_dir(&used).unwrap();
        fs::write(used.join("earlier-capture"), b"preserve me").unwrap();
        assert_eq!(
            initialize_directory(&used).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(
            fs::read(used.join("earlier-capture")).unwrap(),
            b"preserve me"
        );
        assert!(!used.join("FORMAT.txt").exists());
        // A directory initialized by this writer is also rejected on reuse.
        assert_eq!(
            initialize_directory(&fresh).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(
            fs::read_to_string(fresh.join("FORMAT.txt")).unwrap(),
            FORMAT
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sparse_snapshot_preserves_global_pixels_and_float_bits() {
        let mut bytes = Vec::new();
        let pixels = [3u32, 97];
        let raw = [0.25f32, 1.0];
        let filtered = [-0.125f32, 0.75];
        sparse(&mut bytes, 10, 10, 18, &pixels, &raw, &filtered);
        assert_eq!(&bytes[..8], b"CALAFP01");
        let words: Vec<u32> = bytes[8..]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| u32::from_le_bytes(*b))
            .collect();
        assert_eq!(&words[..7], &[10, 10, 1, 18, 2, 3, 97]);
        assert_eq!(
            &words[7..],
            &[
                raw[0].to_bits(),
                raw[1].to_bits(),
                filtered[0].to_bits(),
                filtered[1].to_bits()
            ]
        );
        assert_ne!(
            shape_hash(&pixels, &raw, &filtered),
            shape_hash(&pixels, &raw, &raw)
        );
    }
}
