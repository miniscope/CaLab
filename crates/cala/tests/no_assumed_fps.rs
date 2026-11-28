//! No frame rate is assumed: every duration converts at the recording's
//! frame rate (or `time.fps_override`), and a recording without one fails
//! to resolve (`params::resolve`). This test keeps the shapes the 20 fps
//! fallback had out of the engine and of `qc_eval`. Test code may pass 20
//! explicitly: the scan stops at a file's first `#[cfg(test)]` and skips
//! `tests.rs` files.

use std::path::{Path, PathBuf};

/// Substrings that were the fallback (names and expressions).
const FALLBACKS: &[&str] = &[
    "DEFAULT_FPS",
    "ASSUMED_FPS",
    "QC_FPS",
    "legacy_frame_fps",
    "for_fps(20",
    "unwrap_or(20",
    "map_or(20",
    "fps } else { 20",
];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs")
            && p.file_name().is_some_and(|n| n != "tests.rs")
        {
            out.push(p);
        }
    }
}

/// The text before the file's first `#[cfg(test)]`, with whitespace runs
/// collapsed so a pattern matches across line breaks.
fn shipped_text(p: &Path) -> String {
    let text = std::fs::read_to_string(p).unwrap();
    let cut = text.find("#[cfg(test)]").unwrap_or(text.len());
    text[..cut].split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn no_frame_rate_is_assumed() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    rust_files(&root.join("src"), &mut files);
    files.push(root.join("examples/qc_eval.rs"));
    rust_files(&root.join("examples/common"), &mut files);
    let mut hits = Vec::new();
    for f in &files {
        let text = shipped_text(f);
        for pat in FALLBACKS {
            if text.contains(pat) {
                hits.push(format!(
                    "{}: {pat}",
                    f.strip_prefix(root).unwrap().display()
                ));
            }
        }
    }
    assert!(
        hits.is_empty(),
        "an assumed frame rate is back:\n{}",
        hits.join("\n")
    );
}
