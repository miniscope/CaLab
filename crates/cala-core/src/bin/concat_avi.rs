//! Dev-only CLI: concatenate N uncompressed 8-bit AVIs into one.
//!
//! Gated behind the `native-cli` feature. Every input must share the
//! same width, height, bit depth, and channel count as the first input —
//! miniscope `msCam{1..N}.avi` chunks fit this by construction.
//!
//! Usage:
//!     cargo run --features native-cli --release \
//!         --bin cala-concat-avi -- OUTPUT.avi INPUT1.avi [INPUT2.avi ...]

use std::process::ExitCode;

use calab_cala_core::io::{write_uncompressed_avi_8bit, AviUncompressedReader};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!(
            "usage: {} OUTPUT.avi INPUT1.avi [INPUT2.avi ...]",
            args.first()
                .map(String::as_str)
                .unwrap_or("cala-concat-avi")
        );
        return ExitCode::from(2);
    }
    let output_path = &args[1];
    let input_paths = &args[2..];

    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;
    let mut fps: Option<f32> = None;
    let mut bit_depth: Option<u16> = None;
    let mut channels: Option<u8> = None;
    let mut all_frames: Vec<Vec<u8>> = Vec::new();

    for path in input_paths {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("error reading {path}: {e}");
                return ExitCode::from(1);
            }
        };
        let reader = match AviUncompressedReader::new(&bytes) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("error parsing {path}: {e:?}");
                return ExitCode::from(1);
            }
        };

        if reader.bit_depth() != 8 || reader.channels() != 1 {
            eprintln!(
                "error: {path} is {}-bit {}-channel; concat tool only handles 8-bit grayscale",
                reader.bit_depth(),
                reader.channels()
            );
            return ExitCode::from(1);
        }

        match (width, height) {
            (None, None) => {
                width = Some(reader.width());
                height = Some(reader.height());
                fps = Some(reader.fps());
                bit_depth = Some(reader.bit_depth());
                channels = Some(reader.channels());
            }
            (Some(w), Some(h)) => {
                if reader.width() != w || reader.height() != h {
                    eprintln!(
                        "error: {path} is {}x{}, expected {w}x{h} (matching first input)",
                        reader.width(),
                        reader.height()
                    );
                    return ExitCode::from(1);
                }
            }
            _ => unreachable!(),
        }

        eprintln!(
            "  {path}: {}x{}, {} frames, {:.2} fps",
            reader.width(),
            reader.height(),
            reader.frame_count(),
            reader.fps()
        );
        for i in 0..reader.frame_count() {
            match reader.frame_bytes(i) {
                Ok(b) => all_frames.push(b.to_vec()),
                Err(e) => {
                    eprintln!("error reading frame {i} of {path}: {e:?}");
                    return ExitCode::from(1);
                }
            }
        }
    }

    let w = width.expect("at least one input");
    let h = height.expect("at least one input");
    let out_fps = fps.expect("at least one input").round().max(1.0) as u32;
    let _ = (bit_depth, channels); // validated above; kept for clarity.

    let out_bytes = write_uncompressed_avi_8bit(w, h, out_fps, &all_frames);
    if let Err(e) = std::fs::write(output_path, &out_bytes) {
        eprintln!("error writing {output_path}: {e}");
        return ExitCode::from(1);
    }
    eprintln!(
        "wrote {output_path} ({} frames, {:.1} MB)",
        all_frames.len(),
        out_bytes.len() as f64 / (1024.0 * 1024.0)
    );
    ExitCode::SUCCESS
}
