//! The native AVI reader of the evaluation programs: one numbered-AVI
//! recording directory (`0.avi`, `1.avi`, ...) as a single 8-bit frame stream.

use calab_cala::avi::{idx1_payload_len, AviHeader};
use calab_cala::preprocess::Dims;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// One AVI file and its parsed header and frame index.
pub struct Avi {
    pub file: File,
    pub header: AviHeader,
}

impl Avi {
    /// Parse the header and the `idx1` index (panics on an unreadable file).
    pub fn open(path: &Path) -> Avi {
        let mut file = File::open(path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        let size = file.metadata().unwrap().len();
        let mut prefix = vec![0u8; (64 * 1024).min(size as usize)];
        file.read_exact(&mut prefix).unwrap();
        let layout = AviHeader::parse_header(&prefix).expect("AVI header");
        let mut idx1 = None;
        if layout.info.movi_end > 0 && layout.info.movi_end + 8 <= size {
            let mut hdr = [0u8; 8];
            file.seek(SeekFrom::Start(layout.info.movi_end)).unwrap();
            file.read_exact(&mut hdr).unwrap();
            if let Ok(len) = idx1_payload_len(&hdr) {
                let mut payload = vec![0u8; len as usize];
                file.read_exact(&mut payload).unwrap();
                idx1 = Some(payload);
            }
        }
        let header = AviHeader::parse_with_size(&prefix, idx1.as_deref(), size).expect("AVI index");
        Avi { file, header }
    }

    /// Append frames `start..start + count` to `out`.
    pub fn read(&mut self, start: u32, count: u32, out: &mut Vec<u8>) {
        let px = self.header.pixel_bytes();
        let mut s = start;
        while s < start + count {
            let run = self.header.contiguous_run(s, start + count - s).max(1);
            let (a, b) = self.header.span_range(s, run).unwrap();
            let mut span = vec![0u8; (b - a) as usize];
            self.file.seek(SeekFrom::Start(a)).unwrap();
            self.file.read_exact(&mut span).unwrap();
            let o = out.len();
            out.resize(o + run as usize * px, 0);
            self.header
                .decode_span_into(&span, run, &mut out[o..])
                .unwrap();
            s += run;
        }
    }
}

/// The numbered AVIs of a recording directory as one frame stream.
pub struct Recording {
    pub files: Vec<Avi>,
    pub starts: Vec<u32>,
    pub dims: Dims,
    pub total: u32,
    /// Frames are binned `bin` × `bin` (1 = as recorded); `dims` is binned.
    pub bin: usize,
    pub raw_dims: Dims,
}

impl Recording {
    /// Open `dir`, binning frames `bin` x `bin` (1 = as recorded).
    pub fn open(dir: &Path, bin: usize) -> Recording {
        assert!(bin >= 1, "--bin must be at least 1");
        let mut files = Vec::new();
        for i in 0.. {
            let p = dir.join(format!("{i}.avi"));
            if !p.exists() {
                break;
            }
            files.push(Avi::open(&p));
        }
        assert!(!files.is_empty(), "no 0.avi in {dir:?}");
        let mut starts = Vec::new();
        let mut total = 0;
        for f in &files {
            starts.push(total);
            total += f.header.frame_count();
        }
        let info = files[0].header.info();
        let raw_dims = Dims::new(info.width as usize, info.height as usize).unwrap();
        let dims = Dims::new(raw_dims.width / bin, raw_dims.height / bin).unwrap();
        Recording {
            files,
            starts,
            dims,
            total,
            bin,
            raw_dims,
        }
    }

    /// Panic unless the video is 8-bit (for programs that read it as such).
    pub fn assert_8bit(&self) {
        let info = self.files[0].header.info();
        assert_eq!(info.bit_depth, 8, "this evaluation reads 8-bit video");
    }

    /// Frames `start..start + count` as one buffer (binned by `bin`).
    pub fn read(&mut self, start: u32, count: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity(count as usize * self.raw_dims.pixels());
        let mut s = start;
        while s < start + count {
            let k = self.starts.partition_point(|&x| x <= s) - 1;
            let local = s - self.starts[k];
            let n = (self.files[k].header.frame_count() - local).min(start + count - s);
            self.files[k].read(local, n, &mut out);
            s += n;
        }
        if self.bin == 1 {
            return out;
        }
        // Mean of each bin x bin block, rounded; a partial last row or column is dropped.
        let (b, rw) = (self.bin, self.raw_dims.width);
        let (h, w) = (self.dims.height, self.dims.width);
        let mut binned = Vec::with_capacity(count as usize * h * w);
        for f in out.chunks_exact(self.raw_dims.pixels()) {
            for y in 0..h {
                for x in 0..w {
                    let mut sum = 0u32;
                    for dy in 0..b {
                        let row = (y * b + dy) * rw + x * b;
                        sum += f[row..row + b].iter().map(|&v| u32::from(v)).sum::<u32>();
                    }
                    let n = (b * b) as u32;
                    binned.push(((sum + n / 2) / n) as u8);
                }
            }
        }
        binned
    }
}
