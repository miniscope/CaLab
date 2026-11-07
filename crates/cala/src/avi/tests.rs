//! Tests against a synthetic AVI byte builder.

use super::*;

#[derive(Clone, Copy, PartialEq)]
enum Idx {
    None,
    Relative,
    Absolute,
}

#[derive(Clone)]
struct Synth {
    /// `biCompression` bytes (all zero = BI_RGB).
    compression: [u8; 4],
    bit_count: u16,
    width: u32,
    /// Signed `biHeight`: positive = bottom-up.
    height: i32,
    frames: u32,
    idx: Idx,
    /// Odd-sized JUNK chunk before `movi` (exercises RIFF pad bytes).
    junk: bool,
    /// Extra `indx` chunk in the stream list (OpenDML marker).
    indx: bool,
    /// Declared microseconds per frame in `avih`.
    usec: u32,
    /// Value written into the `movi` LIST size field (None = correct).
    movi_size_override: Option<u32>,
    /// A JUNK chunk before the first frame inside movi.
    junk_in_movi: bool,
    /// `dwTotalFrames` written to avih (None = the real count).
    avih_frames: Option<u32>,
    /// A zero-size video entry appended to idx1 (a frame the writer dropped).
    empty_entry: bool,
}

impl Synth {
    fn grey(width: u32, height: i32, frames: u32) -> Synth {
        Synth {
            compression: *b"GREY",
            bit_count: 8,
            width,
            height,
            frames,
            idx: Idx::Relative,
            junk: false,
            indx: false,
            usec: 16_666,
            movi_size_override: None,
            junk_in_movi: false,
            avih_frames: None,
            empty_entry: false,
        }
    }

    fn stride(&self) -> usize {
        let bpp = self.bit_count as usize;
        (self.width as usize * bpp).div_ceil(32) * 4
    }

    fn frame_bytes(&self) -> usize {
        self.stride() * self.height.unsigned_abs() as usize
    }

    /// Payload of frame `f`: pixel (x, y) of the stored row r has value
    /// `(f * 31 + r * 7 + x) mod 251`, padding bytes are 0xEE.
    fn payload(&self, f: u32) -> Vec<u8> {
        let bpp = self.bit_count as usize / 8;
        let mut out = vec![0xEE; self.frame_bytes()];
        for r in 0..self.height.unsigned_abs() as usize {
            for x in 0..self.width as usize {
                for b in 0..bpp {
                    out[r * self.stride() + x * bpp + b] =
                        ((f as usize * 31 + r * 7 + x + b * 100) % 251) as u8;
                }
            }
        }
        out
    }

    fn build(&self) -> Vec<u8> {
        fn chunk(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
            let mut v = id.to_vec();
            v.extend((body.len() as u32).to_le_bytes());
            v.extend(body);
            if body.len() % 2 == 1 {
                v.push(0);
            }
            v
        }
        fn list(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
            let mut inner = kind.to_vec();
            inner.extend(body);
            chunk(b"LIST", &inner)
        }

        let mut avih = vec![0u8; 56];
        avih[0..4].copy_from_slice(&self.usec.to_le_bytes());
        avih[16..20].copy_from_slice(&self.avih_frames.unwrap_or(self.frames).to_le_bytes());
        avih[32..36].copy_from_slice(&self.width.to_le_bytes());
        avih[36..40].copy_from_slice(&(self.height.unsigned_abs()).to_le_bytes());

        let mut strh = vec![0u8; 56];
        strh[0..4].copy_from_slice(b"vids");
        strh[4..8].copy_from_slice(&self.compression);

        let mut strf = vec![0u8; 40];
        strf[0..4].copy_from_slice(&40u32.to_le_bytes());
        strf[4..8].copy_from_slice(&self.width.to_le_bytes());
        strf[8..12].copy_from_slice(&self.height.to_le_bytes());
        strf[12..14].copy_from_slice(&1u16.to_le_bytes());
        strf[14..16].copy_from_slice(&self.bit_count.to_le_bytes());
        strf[16..20].copy_from_slice(&self.compression);
        strf[20..24].copy_from_slice(&(self.frame_bytes() as u32).to_le_bytes());

        let mut strl_body = chunk(b"strh", &strh);
        strl_body.extend(chunk(b"strf", &strf));
        if self.indx {
            strl_body.extend(chunk(b"indx", &[0u8; 24]));
        }
        let mut hdrl_body = chunk(b"avih", &avih);
        hdrl_body.extend(list(b"strl", &strl_body));
        let hdrl = list(b"hdrl", &hdrl_body);

        let mut file = b"RIFF\0\0\0\0AVI ".to_vec();
        file.extend(&hdrl);
        if self.junk {
            file.extend(chunk(b"JUNK", &[0u8; 13])); // odd size: one pad byte
        }
        file.extend(chunk(b"JUNK", &[0u8; 100]));

        // movi list, tracking chunk offsets for idx1.
        let movi_start = file.len();
        let movi_fourcc = movi_start + 8;
        let mut movi_body = Vec::new();
        let mut entries = Vec::new();
        if self.junk_in_movi {
            movi_body.extend(chunk(b"JUNK", &[0u8; 10]));
        }
        for f in 0..self.frames {
            let abs = movi_fourcc + 4 + movi_body.len();
            entries.push(abs);
            movi_body.extend(chunk(b"00dc", &self.payload(f)));
        }
        let mut movi = list(b"movi", &movi_body);
        if let Some(sz) = self.movi_size_override {
            movi[4..8].copy_from_slice(&sz.to_le_bytes());
        }
        file.extend(movi);

        if self.idx != Idx::None {
            let mut idx = Vec::new();
            for &abs in &entries {
                idx.extend(b"00dc");
                idx.extend(0x10u32.to_le_bytes());
                let off = if self.idx == Idx::Absolute {
                    abs
                } else {
                    abs - movi_fourcc
                };
                idx.extend((off as u32).to_le_bytes());
                idx.extend((self.frame_bytes() as u32).to_le_bytes());
            }
            if self.empty_entry {
                idx.extend(b"00dc");
                idx.extend(0u32.to_le_bytes());
                idx.extend(0u32.to_le_bytes());
                idx.extend(0u32.to_le_bytes());
            }
            file.extend(chunk(b"idx1", &idx));
        }
        let riff = (file.len() - 8) as u32;
        file[4..8].copy_from_slice(&riff.to_le_bytes());
        file
    }

    /// The `idx1` payload of a built file, if any.
    fn idx1_of<'a>(&self, file: &'a [u8], h: &AviHeader) -> Option<&'a [u8]> {
        if self.idx == Idx::None {
            return None;
        }
        let at = h.info().movi_end as usize;
        let len = idx1_payload_len(&file[at..at + 8]).unwrap() as usize;
        Some(&file[at + 8..at + 8 + len])
    }
}

/// Parse like the TS frame source does: header from a prefix, then idx1.
fn parse_full(s: &Synth, file: &[u8]) -> Result<AviHeader, AviError> {
    if s.idx == Idx::None {
        return AviHeader::parse(file, None);
    }
    // The first pass (stride path) only locates movi_end, as the TS source does.
    let probe = AviHeader::parse(file, None)?;
    AviHeader::parse(file, s.idx1_of(file, &probe))
}

fn expect_frames(s: &Synth, file: &[u8], h: &AviHeader, flip: bool) {
    let w = s.width as usize;
    let rows = s.height.unsigned_abs() as usize;
    for f in 0..s.frames {
        let (a, b) = h.frame_range(f).unwrap();
        let px = h.decode_frame(&file[a as usize..b as usize]).unwrap();
        assert_eq!(px.len(), w * rows * (s.bit_count as usize / 8));
        let bpp = s.bit_count as usize / 8;
        let stored = s.payload(f);
        for r in 0..rows {
            let src = if flip { rows - 1 - r } else { r };
            let want = &stored[src * s.stride()..src * s.stride() + w * bpp];
            assert_eq!(
                &px[r * w * bpp..(r + 1) * w * bpp],
                want,
                "frame {f} row {r}"
            );
        }
    }
}

#[test]
fn grey_with_relative_idx1() {
    let s = Synth::grey(8, 4, 5);
    let file = s.build();
    let h = parse_full(&s, &file).unwrap();
    let i = h.info();
    assert_eq!((i.width, i.height, i.bit_depth), (8, 4, 8));
    assert_eq!(i.fourcc, "GREY");
    assert_eq!(i.frame_count, 5);
    assert_eq!((i.frame_bytes, i.row_stride), (32, 8));
    assert!(i.has_idx1 && !i.idx1_absolute);
    assert!(!i.bottom_up || s.height > 0);
    expect_frames(&s, &file, &h, false);
}

#[test]
fn grey_with_absolute_idx1() {
    let mut s = Synth::grey(8, 4, 6);
    s.idx = Idx::Absolute;
    let file = s.build();
    let h = parse_full(&s, &file).unwrap();
    assert!(h.info().has_idx1 && h.info().idx1_absolute);
    assert_eq!(h.frame_count(), 6);
    expect_frames(&s, &file, &h, false);
}

#[test]
fn y800_and_bi_rgb_formats() {
    for (comp, name) in [(*b"Y800", "Y800"), (*b"Y8  ", "Y8  "), ([0; 4], "BI_RGB")] {
        let mut s = Synth::grey(12, 3, 3);
        s.compression = comp;
        let file = s.build();
        let h = parse_full(&s, &file).unwrap();
        assert_eq!(h.info().fourcc, name);
        expect_frames(&s, &file, &h, false);
    }
}

#[test]
fn padded_width_strips_row_padding() {
    // width 6 -> stride 8: two padding bytes per row.
    let s = Synth::grey(6, 5, 4);
    assert_eq!(s.stride(), 8);
    let file = s.build();
    let h = parse_full(&s, &file).unwrap();
    assert_eq!((h.info().row_stride, h.info().frame_bytes), (8, 40));
    expect_frames(&s, &file, &h, false);
    let (a, b) = h.frame_range(0).unwrap();
    assert!(!h
        .decode_frame(&file[a as usize..b as usize])
        .unwrap()
        .contains(&0xEE));
}

#[test]
fn without_idx1_uses_fixed_stride() {
    let mut s = Synth::grey(10, 3, 7);
    s.idx = Idx::None;
    let file = s.build();
    let h = parse_full(&s, &file).unwrap();
    assert!(!h.info().has_idx1);
    assert_eq!(h.frame_count(), 7);
    expect_frames(&s, &file, &h, false);
}

#[test]
fn junk_chunks_and_odd_padding_before_movi() {
    for idx in [Idx::None, Idx::Relative, Idx::Absolute] {
        let mut s = Synth::grey(8, 2, 3);
        s.junk = true;
        s.idx = idx;
        let file = s.build();
        let h = parse_full(&s, &file).unwrap();
        assert_eq!(h.frame_count(), 3);
        assert_eq!(h.info().first_chunk_offset, h.info().movi_offset + 4);
        expect_frames(&s, &file, &h, false);
    }
}

#[test]
fn orientation_is_reported_and_flip_is_opt_in() {
    let s = Synth::grey(5, 4, 2);
    let file = s.build();
    let mut h = parse_full(&s, &file).unwrap();
    assert!(h.info().bottom_up);
    assert!(!h.flip_bottom_up());
    expect_frames(&s, &file, &h, false);
    h.set_flip_bottom_up(true);
    expect_frames(&s, &file, &h, true);

    // Negative biHeight is top-down: the flip option does nothing.
    let s = Synth::grey(5, -4, 2);
    let file = s.build();
    let mut h = parse_full(&s, &file).unwrap();
    assert!(!h.info().bottom_up);
    h.set_flip_bottom_up(true);
    expect_frames(&s, &file, &h, false);
}

#[test]
fn gray16_frames() {
    let mut s = Synth::grey(5, 3, 2);
    s.compression = *b"Y16 ";
    s.bit_count = 16;
    let file = s.build();
    let h = parse_full(&s, &file).unwrap();
    assert_eq!((h.info().bit_depth, h.info().row_stride), (16, 12));
    expect_frames(&s, &file, &h, false);
}

#[test]
fn declared_frame_rate_is_reported_not_trusted() {
    let mut s = Synth::grey(4, 2, 2);
    s.usec = 16_666; // "60 fps"
    let h = parse_full(&s, &s.build()).unwrap();
    assert_eq!(h.info().declared_usec_per_frame, 16_666);
}

#[test]
fn compressed_codecs_are_rejected() {
    for codec in [*b"MJPG", *b"H264", *b"XVID"] {
        let mut s = Synth::grey(8, 4, 2);
        s.compression = codec;
        s.bit_count = 24;
        let err = AviHeader::parse(&s.build(), None).unwrap_err();
        assert!(matches!(err, AviError::Unsupported(_)), "{err}");
        assert!(err
            .to_string()
            .contains(&String::from_utf8_lossy(&codec).to_string()));
    }
    let mut s = Synth::grey(8, 4, 2);
    s.compression = [0; 4];
    s.bit_count = 24;
    assert!(matches!(
        AviHeader::parse(&s.build(), None),
        Err(AviError::Unsupported(_))
    ));
}

#[test]
fn opendml_is_unsupported() {
    let mut s = Synth::grey(8, 4, 2);
    s.indx = true;
    assert!(matches!(
        AviHeader::parse(&s.build(), None),
        Err(AviError::Unsupported(m)) if m.contains("OpenDML")
    ));
    let mut avix = b"RIFF\0\0\0\0AVIX".to_vec();
    avix.extend([0; 16]);
    assert!(is_avix_continuation(&avix));
    assert!(!is_avix_continuation(&Synth::grey(4, 2, 1).build()));
    assert!(matches!(
        AviHeader::parse(&avix, None),
        Err(AviError::Unsupported(_))
    ));
}

#[test]
fn short_prefix_asks_for_more_data() {
    let s = Synth::grey(8, 4, 3);
    let file = s.build();
    let full = AviHeader::parse(&file, None).unwrap();
    let need = full.info().first_chunk_offset as usize;
    for len in [0, 5, 11, 40, need - 1] {
        match AviHeader::parse(&file[..len], None) {
            Err(AviError::NeedMoreData { needed }) => assert!(needed as usize > len),
            other => panic!("len {len}: {other:?}"),
        }
    }
    // Enough to reach the first chunk: succeeds (stride path).
    assert!(AviHeader::parse(&file[..need], None).is_ok());
}

#[test]
fn garbage_never_panics() {
    assert!(AviHeader::parse(b"", None).is_err());
    assert!(AviHeader::parse(b"RIFX\0\0\0\0AVI ", None).is_err());
    assert!(AviHeader::parse(b"RIFF\0\0\0\0WAVEfmt ", None).is_err());
    // Every truncation and every single-byte corruption of a valid file.
    let file = Synth::grey(6, 3, 3).build();
    for len in 0..file.len() {
        let _ = AviHeader::parse(&file[..len], None);
    }
    for i in 0..file.len().min(400) {
        let mut bad = file.clone();
        bad[i] ^= 0xFF;
        let _ = AviHeader::parse(&bad, None);
    }
}

#[test]
fn idx1_inconsistencies_are_errors() {
    let s = Synth::grey(8, 4, 3);
    let file = s.build();
    let probe = AviHeader::parse(&file, None).unwrap();
    let good = s.idx1_of(&file, &probe).unwrap().to_vec();

    // Wrong frame size.
    let mut bad = good.clone();
    bad[12..16].copy_from_slice(&7u32.to_le_bytes());
    assert!(matches!(
        AviHeader::parse(&file, Some(&bad)),
        Err(AviError::InvalidIndex(_))
    ));
    // Offset past the movi list.
    let mut bad = good.clone();
    bad[8..12].copy_from_slice(&0x00FF_FFFFu32.to_le_bytes());
    assert!(matches!(
        AviHeader::parse(&file, Some(&bad)),
        Err(AviError::InvalidIndex(_))
    ));
    // No video entries: idx1 is unusable, the stride takes over.
    let h = AviHeader::parse(&file, Some(&[])).unwrap();
    assert!(!h.info().has_idx1);
    assert_eq!(h.frame_count(), 3);
    // Non-video entries (audio chunk ids) are skipped, not fatal.
    let mut mixed = good.clone();
    mixed.extend(b"01wb\0\0\0\0\x04\0\0\0\x10\0\0\0");
    assert_eq!(
        AviHeader::parse(&file, Some(&mixed)).unwrap().frame_count(),
        3
    );
}

#[test]
fn idx1_header_checks() {
    assert_eq!(idx1_payload_len(b"idx1\x30\0\0\0").unwrap(), 0x30);
    assert!(idx1_payload_len(b"JUNK\x30\0\0\0").is_err());
    assert!(idx1_payload_len(b"idx1").is_err());
}

#[test]
fn decode_frame_validates_chunks() {
    let s = Synth::grey(8, 4, 2);
    let file = s.build();
    let h = parse_full(&s, &file).unwrap();
    let (a, b) = h.frame_range(0).unwrap();
    let good = file[a as usize..b as usize].to_vec();
    assert!(h.decode_frame(&good).is_ok());

    let mut bad = good.clone();
    bad[0..4].copy_from_slice(b"01dc"); // other stream
    assert!(matches!(
        h.decode_frame(&bad),
        Err(AviError::InvalidFrame(_))
    ));
    bad[0..4].copy_from_slice(b"00wb"); // audio
    assert!(matches!(
        h.decode_frame(&bad),
        Err(AviError::InvalidFrame(_))
    ));
    let mut bad = good.clone();
    bad[4..8].copy_from_slice(&9u32.to_le_bytes());
    assert!(matches!(
        h.decode_frame(&bad),
        Err(AviError::InvalidFrame(_))
    ));
    assert!(matches!(
        h.decode_frame(&good[..20]),
        Err(AviError::InvalidFrame(_))
    ));
    assert!(matches!(
        h.decode_frame(&[]),
        Err(AviError::InvalidFrame(_))
    ));
    // 00db is accepted too.
    let mut db = good;
    db[0..4].copy_from_slice(b"00db");
    assert!(h.decode_frame(&db).is_ok());
}

#[test]
fn frame_range_bounds() {
    let s = Synth::grey(8, 4, 2);
    let file = s.build();
    let h = parse_full(&s, &file).unwrap();
    assert!(h.frame_range(1).is_ok());
    assert_eq!(
        h.frame_range(2),
        Err(AviError::OutOfRange {
            index: 2,
            frame_count: 2
        })
    );
}

#[test]
fn truncated_file_drops_incomplete_frames() {
    let mut s = Synth::grey(8, 4, 5);
    s.idx = Idx::None;
    let file = s.build();
    let probe = AviHeader::parse(&file, None).unwrap();
    let (_, end3) = probe.frame_range(2).unwrap();
    // Frames 0..=2 complete, 3 cut.
    let h = AviHeader::parse_with_size(&file, None, end3 + 5).unwrap();
    assert_eq!(h.frame_count(), 3);
    assert!(h.frame_range(3).is_err());
}

#[test]
fn crash_truncated_file_counts_frames_from_its_size() {
    // The writer died before close: avih frames 0, movi size 0, no idx1.
    let mut s = Synth::grey(8, 4, 5);
    s.idx = Idx::None;
    s.avih_frames = Some(0);
    s.movi_size_override = Some(0);
    let file = s.build();
    // Nothing bounds the count without a file size.
    assert!(matches!(
        AviHeader::parse(&file, None),
        Err(AviError::InvalidIndex(_))
    ));
    let full = AviHeader::parse_with_size(&file, None, file.len() as u64).unwrap();
    assert_eq!(full.frame_count(), 5);
    let (_, end3) = full.frame_range(2).unwrap();
    let cut = &file[..end3 as usize + 7];
    let h = AviHeader::parse_with_size(cut, None, cut.len() as u64).unwrap();
    assert_eq!(h.frame_count(), 3);
    let s3 = Synth {
        frames: 3,
        ..s.clone()
    };
    expect_frames(&s3, cut, &h, false);
    // Not even one complete frame: zero frames, not an error.
    let tiny = &file[..h.info().first_chunk_offset as usize + 20];
    let h0 = AviHeader::parse_with_size(tiny, None, tiny.len() as u64).unwrap();
    assert_eq!(h0.frame_count(), 0);
}

#[test]
fn idx1_wins_over_a_stride_that_would_fail() {
    for idx in [Idx::Relative, Idx::Absolute] {
        let mut s = Synth::grey(8, 4, 4);
        s.junk_in_movi = true; // first movi chunk is JUNK: no fixed stride
        s.avih_frames = Some(0);
        s.idx = idx;
        let file = s.build();
        // Without idx1 the stride path rejects the layout...
        assert!(matches!(
            AviHeader::parse(&file, None),
            Err(AviError::InvalidIndex(_))
        ));
        // ...but with it the file opens, as the TS source now does.
        let layout = AviHeader::parse_header(&file).unwrap();
        let at = layout.info.movi_end as usize;
        let len = idx1_payload_len(&file[at..at + 8]).unwrap() as usize;
        let h =
            AviHeader::parse_with_size(&file, Some(&file[at + 8..at + 8 + len]), file.len() as u64)
                .unwrap();
        assert!(h.info().has_idx1);
        assert_eq!(h.frame_count(), 4);
        expect_frames(&s, &file, &h, false);
    }
}

#[test]
fn huge_declared_frame_count_does_not_allocate() {
    let mut s = Synth::grey(8, 4, 3);
    s.idx = Idx::None;
    s.avih_frames = Some(u32::MAX);
    s.movi_size_override = Some(0);
    let file = s.build();
    // Unknown file size: the count is the declared one, held as a stride.
    let h = AviHeader::parse(&file, None).unwrap();
    assert_eq!(h.frame_count(), u32::MAX);
    assert!(h.frame_range(u32::MAX - 1).is_ok());
    // A known size bounds it to what is actually there.
    let h = AviHeader::parse_with_size(&file, None, file.len() as u64).unwrap();
    assert_eq!(h.frame_count(), 3);
}

#[test]
fn zero_size_idx1_entries_are_skipped_and_counted() {
    let mut s = Synth::grey(8, 4, 3);
    s.empty_entry = true;
    let file = s.build();
    let h = parse_full(&s, &file).unwrap();
    assert_eq!(h.frame_count(), 3);
    assert_eq!(h.skipped_empty_frames(), 1);
    expect_frames(&s, &file, &h, false);
}

#[test]
fn spans_decode_like_single_frames() {
    for idx in [Idx::None, Idx::Relative] {
        let mut s = Synth::grey(6, 3, 6);
        s.idx = idx;
        let file = s.build();
        let h = parse_full(&s, &file).unwrap();
        assert_eq!(h.contiguous_run(1, 100), 5);
        assert_eq!(h.contiguous_run(6, 1), 0);
        let (a, b) = h.span_range(2, 3).unwrap();
        let (a, b) = (a as usize, b as usize);
        let px = h.pixel_bytes();
        let mut out = vec![0u8; 3 * px];
        h.decode_span_into(&file[a..b], 3, &mut out).unwrap();
        for i in 0..3u32 {
            let (fa, fb) = h.frame_range(2 + i).unwrap();
            let one = h.decode_frame(&file[fa as usize..fb as usize]).unwrap();
            assert_eq!(&out[i as usize * px..(i as usize + 1) * px], &one[..]);
        }
        // Wrong output size and truncated spans are errors.
        assert!(h.decode_span_into(&file[a..b], 3, &mut out[1..]).is_err());
        assert!(h.decode_span_into(&file[a..b - 9], 3, &mut out).is_err());
        assert!(h.span_range(4, 5).is_err());
    }
}

#[test]
fn idx1_gaps_break_contiguity() {
    let s = Synth::grey(8, 4, 4);
    let file = s.build();
    let probe = AviHeader::parse(&file, None).unwrap();
    let mut idx = s.idx1_of(&file, &probe).unwrap().to_vec();
    // Push frame 2's offset 16 bytes later: a gap before it.
    let off = u32::from_le_bytes(idx[40..44].try_into().unwrap()) + 16;
    idx[40..44].copy_from_slice(&off.to_le_bytes());
    let h = AviHeader::parse_with_size(&file, Some(&idx), 0).unwrap();
    assert_eq!(h.contiguous_run(0, 4), 2);
    // Frame 3 no longer follows the shifted frame 2.
    assert_eq!(h.contiguous_run(2, 4), 1);
    assert!(h.span_range(0, 3).is_err());
}

#[test]
fn short_strf_is_rejected() {
    let s = Synth::grey(8, 4, 1);
    let mut file = s.build();
    let at = file.windows(4).position(|w| w == b"strf").unwrap();
    file[at + 4..at + 8].copy_from_slice(&18u32.to_le_bytes());
    assert!(AviHeader::parse(&file, None).is_err());
}

#[test]
fn unknown_movi_size_falls_back_to_declared_frames() {
    let mut s = Synth::grey(8, 4, 4);
    s.idx = Idx::None;
    s.movi_size_override = Some(0);
    let file = s.build();
    let h = AviHeader::parse(&file, None).unwrap();
    assert_eq!(h.frame_count(), 4);
    expect_frames(&s, &file, &h, false);
}

#[test]
fn stride_path_rejects_unexpected_first_chunk() {
    let mut s = Synth::grey(8, 4, 3);
    s.idx = Idx::None;
    let mut file = s.build();
    let h = AviHeader::parse(&file, None).unwrap();
    let at = h.info().first_chunk_offset as usize;
    file[at..at + 4].copy_from_slice(b"LIST");
    assert!(matches!(
        AviHeader::parse(&file, None),
        Err(AviError::InvalidIndex(_))
    ));
}
