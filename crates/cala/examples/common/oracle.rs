//! Shared CALAORC1 ground-truth reader for the native evaluation programs.

use calab_cala::preprocess::Dims;
use calab_cala::trace::Footprint;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

pub(super) struct Unit {
    pub detectable: bool,
    pub in_focus: bool,
    pub center: (f32, f32),
    pub full: Footprint,
    pub core: Footprint,
}

pub(super) struct Oracle {
    pub dims: Dims,
    pub units: Vec<Unit>,
    pub n_frames: usize,
    /// `C[unit * n_frames + t]`.
    pub c: Vec<f32>,
}

pub(super) fn read_u32(r: &mut impl Read) -> u32 {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).unwrap();
    u32::from_le_bytes(b)
}

pub(super) fn read_f32s(r: &mut impl Read, n: usize) -> Vec<f32> {
    let mut b = vec![0u8; 4 * n];
    r.read_exact(&mut b).unwrap();
    b.as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect()
}

pub(super) fn read_oracle(path: &Path) -> Oracle {
    let mut r = BufReader::new(File::open(path).unwrap_or_else(|e| panic!("{path:?}: {e}")));
    let mut magic = [0u8; 8];
    r.read_exact(&mut magic).unwrap();
    assert_eq!(&magic, b"CALAORC1");
    let h = read_u32(&mut r) as usize;
    let w = read_u32(&mut r) as usize;
    let n = read_u32(&mut r) as usize;
    let t = read_u32(&mut r) as usize;
    let mut units = Vec::with_capacity(n);
    for _ in 0..n {
        let id = read_u32(&mut r);
        let mut flags = [0u8; 4];
        r.read_exact(&mut flags).unwrap();
        let cy = read_f32s(&mut r, 1)[0];
        let cx = read_f32s(&mut r, 1)[0];
        let mut fps = Vec::new();
        for _ in 0..2 {
            let y0 = read_u32(&mut r) as i32;
            let x0 = read_u32(&mut r) as i32;
            let ph = read_u32(&mut r) as usize;
            let pw = read_u32(&mut r) as usize;
            let values: Vec<f32> = read_f32s(&mut r, ph * pw)
                .into_iter()
                .map(|v| v.max(0.0))
                .collect();
            fps.push(Footprint {
                id: u64::from(id),
                y0: y0.max(0) as usize,
                x0: x0.max(0) as usize,
                height: ph,
                width: pw,
                values,
            });
        }
        let core = fps.pop().unwrap();
        let full = fps.pop().unwrap();
        units.push(Unit {
            detectable: flags[0] != 0,
            in_focus: flags[1] != 0,
            center: (cy, cx),
            full,
            core,
        });
    }
    let c = read_f32s(&mut r, n * t);
    Oracle {
        dims: Dims::new(w, h).unwrap(),
        units,
        n_frames: t,
        c,
    }
}
