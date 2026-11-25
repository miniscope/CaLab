//! Property tests: the AVI header parsers never panic on arbitrary bytes.
//!
//! The parsers run in the browser on user-chosen files, so a panic is a WASM
//! trap. Raise the case count with `PROPTEST_CASES=5000 cargo test --test avi_proptest`.

use calab_cala::avi::{idx1_payload_len, is_avix_continuation, AviHeader};
use proptest::prelude::*;

/// Random bytes, half of them prefixed with a plausible RIFF/AVI magic so the
/// parser gets past the first check and into the chunk walker.
fn bytes() -> impl Strategy<Value = Vec<u8>> {
    let raw = prop::collection::vec(any::<u8>(), 0..2048);
    let riff = prop::collection::vec(any::<u8>(), 0..2048).prop_map(|mut v| {
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(v.len() as u32).to_le_bytes());
        out.extend_from_slice(b"AVI LIST");
        out.append(&mut v);
        out
    });
    prop_oneof![raw, riff]
}

proptest! {
    #[test]
    fn parse_header_never_panics(b in bytes()) {
        let _ = AviHeader::parse_header(&b);
    }

    #[test]
    fn parse_never_panics(b in bytes(), idx in prop::option::of(bytes())) {
        let _ = AviHeader::parse(&b, idx.as_deref());
    }

    #[test]
    fn helpers_never_panic(b in bytes()) {
        let _ = idx1_payload_len(&b);
        let _ = is_avix_continuation(&b);
    }

    /// Truncating any prefix of the input must also be safe.
    #[test]
    fn truncation_never_panics(b in bytes(), cut in 0usize..2048) {
        let cut = cut.min(b.len());
        let _ = AviHeader::parse(&b[..cut], None);
    }
}
