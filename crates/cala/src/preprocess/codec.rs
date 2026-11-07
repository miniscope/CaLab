//! Minimal little-endian binary encoding for [`super::PreprocessState`].
//!
//! The state is mostly a handful of large `f32` images, so a flat binary
//! layout is far smaller and faster than text, needs no dependency, and moves
//! across the wasm boundary as one `Uint8Array`. Every read is bounds-checked
//! and returns [`PreprocessError::InvalidState`] on truncated or corrupt input.

use super::PreprocessError;

pub(crate) struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Writer {
        Writer { buf: Vec::new() }
    }

    pub fn bytes(&mut self, b: &[u8]) {
        self.buf.extend_from_slice(b);
    }

    pub fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }

    pub fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn u64(&mut self, v: u64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn f32(&mut self, v: f32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn usize(&mut self, v: usize) {
        self.u64(v as u64);
    }

    pub fn u8s(&mut self, v: &[u8]) {
        self.usize(v.len());
        self.buf.extend_from_slice(v);
    }

    pub fn f32s(&mut self, v: &[f32]) {
        self.usize(v.len());
        self.buf.reserve(v.len() * 4);
        for x in v {
            self.buf.extend_from_slice(&x.to_le_bytes());
        }
    }

    pub fn finish(self) -> Vec<u8> {
        self.buf
    }
}

pub(crate) struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

fn corrupt(what: &str) -> PreprocessError {
    PreprocessError::InvalidState(format!("truncated or corrupt state ({what})"))
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Reader<'a> {
        Reader { buf, pos: 0 }
    }

    fn take(&mut self, n: usize, what: &str) -> Result<&'a [u8], PreprocessError> {
        let end = self.pos.checked_add(n).ok_or_else(|| corrupt(what))?;
        let s = self.buf.get(self.pos..end).ok_or_else(|| corrupt(what))?;
        self.pos = end;
        Ok(s)
    }

    pub fn bytes(&mut self, n: usize, what: &str) -> Result<&'a [u8], PreprocessError> {
        self.take(n, what)
    }

    pub fn u8(&mut self, what: &str) -> Result<u8, PreprocessError> {
        Ok(self.take(1, what)?[0])
    }

    pub fn u32(&mut self, what: &str) -> Result<u32, PreprocessError> {
        let b = self.take(4, what)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn u64(&mut self, what: &str) -> Result<u64, PreprocessError> {
        let b = self.take(8, what)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        Ok(u64::from_le_bytes(a))
    }

    pub fn f32(&mut self, what: &str) -> Result<f32, PreprocessError> {
        Ok(f32::from_bits(self.u32(what)?))
    }

    pub fn usize(&mut self, what: &str) -> Result<usize, PreprocessError> {
        usize::try_from(self.u64(what)?).map_err(|_| corrupt(what))
    }

    pub fn u8s(&mut self, what: &str) -> Result<Vec<u8>, PreprocessError> {
        let n = self.usize(what)?;
        Ok(self.take(n, what)?.to_vec())
    }

    pub fn f32s(&mut self, what: &str) -> Result<Vec<f32>, PreprocessError> {
        let n = self.usize(what)?;
        let bytes = self.take(n.checked_mul(4).ok_or_else(|| corrupt(what))?, what)?;
        let (words, _) = bytes.as_chunks::<4>();
        Ok(words.iter().map(|&c| f32::from_le_bytes(c)).collect())
    }

    pub fn done(&self) -> bool {
        self.pos == self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_truncation() {
        let mut w = Writer::new();
        w.u8(7);
        w.u32(1234);
        w.f32(-2.5);
        w.f32s(&[1.0, 2.0]);
        w.u8s(&[9, 8]);
        let b = w.finish();
        let mut r = Reader::new(&b);
        assert_eq!(r.u8("a").unwrap(), 7);
        assert_eq!(r.u32("b").unwrap(), 1234);
        assert_eq!(r.f32("c").unwrap(), -2.5);
        assert_eq!(r.f32s("d").unwrap(), vec![1.0, 2.0]);
        assert_eq!(r.u8s("e").unwrap(), vec![9, 8]);
        assert!(r.done());
        for cut in 0..b.len() {
            let mut r = Reader::new(&b[..cut]);
            let ok = r.u8("a").is_ok()
                && r.u32("b").is_ok()
                && r.f32("c").is_ok()
                && r.f32s("d").is_ok()
                && r.u8s("e").is_ok();
            assert!(!ok, "cut {cut} decoded");
        }
        // A huge length prefix must not allocate.
        let mut w = Writer::new();
        w.u64(u64::MAX);
        let b = w.finish();
        assert!(Reader::new(&b).f32s("x").is_err());
    }
}
