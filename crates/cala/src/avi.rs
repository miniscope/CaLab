//! Plain-RIFF AVI header and frame-offset parser for uncompressed grayscale video.
//!
//! The parser never sees a whole file. The browser reads a byte *prefix*
//! (enough to cover the `hdrl` list and the start of `movi`) and, separately,
//! the `idx1` payload that follows the `movi` list, both with `File.slice`.
//! [`AviHeader::parse`] turns those into the geometry plus a table of frame
//! chunk offsets, and [`AviHeader::frame_range`] / [`AviHeader::decode_frame`]
//! then let the caller fetch and decode one frame at a time.
//!
//! # Timing
//!
//! The declared frame rate (`dwMicroSecPerFrame`) is reported but must not be
//! used for timing: real Miniscope files written at 20 fps declare 60. Take the
//! rate from `metaData.json` / `timeStamps.csv` instead.
//!
//! # Orientation
//!
//! A DIB with a positive `biHeight` stores rows bottom-up. Miniscope files have
//! a positive `biHeight`, yet OpenCV (and so minian and the Miniscope analysis
//! tools) hands back the rows as stored, top row first, and every downstream
//! coordinate (cell footprints, ROIs, registrations) in that ecosystem is in
//! that as-stored frame. So the default here is to NOT flip, to match what the
//! rest of the toolchain shows. The flag is reported in [`AviInfo::bottom_up`]
//! and flipping is opt-in via [`AviHeader::set_flip_bottom_up`].
//!
//! # Scope
//!
//! Supported: uncompressed 8-bit grayscale (`GREY`, `Y800`, `Y8  `, or `BI_RGB`
//! at 8 bits per pixel) and 16-bit grayscale (`Y16 `). Compressed codecs and
//! OpenDML (`indx`, `odml`, `AVIX`) return [`AviError::Unsupported`].

use std::fmt;

/// Upper bound on one decoded frame's chunk payload, so a corrupt header
/// cannot make the caller allocate gigabytes.
pub const MAX_FRAME_BYTES: u64 = 1 << 28;

/// Error returned by every fallible AVI entry point.
#[derive(Debug, Clone, PartialEq)]
pub enum AviError {
    /// The prefix ends before the header is complete; retry with at least
    /// `needed` bytes (a lower bound, not an exact size).
    NeedMoreData { needed: u64 },
    /// Not a RIFF/AVI file, or the header structure is malformed.
    InvalidHeader(String),
    /// A valid AVI this crate does not handle (compressed codec, OpenDML, ...).
    Unsupported(String),
    /// The `idx1` payload is inconsistent with the header.
    InvalidIndex(String),
    /// Frame bytes do not match what the header promises.
    InvalidFrame(String),
    /// A frame index past the end.
    OutOfRange { index: u32, frame_count: u32 },
}

impl fmt::Display for AviError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AviError::NeedMoreData { needed } => {
                write!(f, "need more data: header needs at least {needed} bytes")
            }
            AviError::InvalidHeader(m) => write!(f, "invalid AVI header: {m}"),
            AviError::Unsupported(m) => write!(f, "unsupported AVI: {m}"),
            AviError::InvalidIndex(m) => write!(f, "invalid AVI index: {m}"),
            AviError::InvalidFrame(m) => write!(f, "invalid AVI frame: {m}"),
            AviError::OutOfRange { index, frame_count } => {
                write!(f, "frame {index} out of range (frame count {frame_count})")
            }
        }
    }
}

impl std::error::Error for AviError {}

/// Pixel layout of the decoded frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    /// One byte per pixel.
    Gray8,
    /// Two bytes per pixel, little-endian.
    Gray16,
}

impl PixelFormat {
    pub fn bytes_per_pixel(self) -> u32 {
        match self {
            PixelFormat::Gray8 => 1,
            PixelFormat::Gray16 => 2,
        }
    }
}

/// Everything the header says about the video stream, plus where it lives.
#[derive(Debug, Clone, PartialEq)]
pub struct AviInfo {
    pub width: u32,
    /// Absolute value of `biHeight`.
    pub height: u32,
    pub bit_depth: u32,
    pub pixel_format: PixelFormat,
    /// `biCompression` as text (`"GREY"`, `"Y800"`, ...), or `"BI_RGB"` for 0.
    pub fourcc: String,
    pub frame_count: u32,
    /// Chunk payload size per frame: `row_stride * height`, padding included.
    pub frame_bytes: u32,
    /// DIB row stride in bytes: `((width * bit_depth + 31) / 32) * 4`.
    pub row_stride: u32,
    /// `biHeight > 0`: rows are stored bottom-up (see the module docs).
    pub bottom_up: bool,
    /// `dwMicroSecPerFrame` from `avih`. Often wrong; never use for timing.
    pub declared_usec_per_frame: u32,
    /// File offset of the `movi` fourcc (the base of idx1-relative offsets).
    pub movi_offset: u64,
    /// File offset of the first chunk inside `movi` (`movi_offset + 4`).
    pub first_chunk_offset: u64,
    /// File offset one past the `movi` list; the `idx1` chunk header starts here.
    pub movi_end: u64,
    /// File offset one past the RIFF payload (`8 + RIFF size`).
    pub riff_end: u64,
    /// Index of the video stream (selects the `NNdc` / `NNdb` chunk tag).
    pub stream_index: u32,
    /// Offsets came from an `idx1` chunk (otherwise a fixed stride from the
    /// first chunk).
    pub has_idx1: bool,
    /// The `idx1` offsets were absolute file offsets rather than relative to
    /// the `movi` fourcc. Both exist in the wild.
    pub idx1_absolute: bool,
}

/// Where each frame's chunk header (8-byte tag + size) starts in the file.
///
/// The fixed-stride case never materializes a table: a corrupt header
/// claiming ~4 billion frames must not allocate gigabytes (that aborts wasm32).
#[derive(Debug, Clone)]
enum Offsets {
    Stride {
        first: u64,
        chunk: u64,
        count: u32,
    },
    /// From idx1, clamped to the file size.
    List(Vec<u64>),
}

/// Geometry and layout from the header alone: everything except the frame
/// offsets, which come from idx1 or a fixed stride (see [`AviHeader::parse_with_size`]).
#[derive(Debug, Clone)]
pub struct HeaderLayout {
    /// `frame_count` is 0 here; `movi_end` is 0 when the movi size is unknown.
    pub info: AviInfo,
    /// `dwTotalFrames` from `avih` (0 when a crashed writer never filled it in).
    pub declared_frames: u32,
    /// Size field of the movi LIST (0 when never written).
    pub movi_size: u64,
}

/// Parsed header plus the per-frame chunk offsets.
#[derive(Debug, Clone)]
pub struct AviHeader {
    info: AviInfo,
    offsets: Offsets,
    /// Zero-size idx1 entries skipped (frames a writer dropped).
    skipped_empty: u32,
    flip_bottom_up: bool,
}

// ---------------------------------------------------------------------------
// Byte helpers (bounds-checked; the parser never indexes without a check)
// ---------------------------------------------------------------------------

fn u32_at(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off.checked_add(4)?)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn u16_at(b: &[u8], off: usize) -> Option<u16> {
    let s = b.get(off..off.checked_add(2)?)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

fn tag_at(b: &[u8], off: usize) -> Option<[u8; 4]> {
    let s = b.get(off..off.checked_add(4)?)?;
    Some([s[0], s[1], s[2], s[3]])
}

fn pad2(n: u64) -> u64 {
    n + (n & 1)
}

fn tag_str(t: [u8; 4]) -> String {
    t.iter()
        .map(|&c| {
            if (0x20..0x7f).contains(&c) {
                c as char
            } else {
                '?'
            }
        })
        .collect()
}

fn short(what: &str) -> AviError {
    AviError::InvalidHeader(format!("{what} is truncated"))
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Hdrl {
    usec_per_frame: u32,
    total_frames: u32,
    stream: Option<Stream>,
    opendml: bool,
}

struct Stream {
    index: u32,
    width: u32,
    height: u32,
    bottom_up: bool,
    bit_count: u16,
    compression: u32,
}

/// Parse the children of a `strl` list into the stream it describes, if it is
/// a video stream.
fn parse_strl(
    b: &[u8],
    mut pos: usize,
    end: usize,
    index: u32,
    opendml: &mut bool,
) -> Result<Option<Stream>, AviError> {
    let mut is_video = false;
    let mut out = None;
    while pos + 8 <= end {
        let id = tag_at(b, pos).ok_or_else(|| short("strl"))?;
        let size = u32_at(b, pos + 4).ok_or_else(|| short("strl"))? as usize;
        let body = pos + 8;
        let body_end = body.checked_add(size).ok_or_else(|| short("strl chunk"))?;
        if body_end > end {
            return Err(AviError::InvalidHeader(
                "strl chunk overruns its list".into(),
            ));
        }
        match &id {
            b"strh" => {
                is_video = tag_at(b, body) == Some(*b"vids");
            }
            b"strf" if is_video => {
                if size < 40 {
                    return Err(AviError::InvalidHeader(
                        "strf shorter than a 40-byte BITMAPINFOHEADER".into(),
                    ));
                }
                let w = u32_at(b, body + 4).ok_or_else(|| short("strf"))? as i32;
                let h = u32_at(b, body + 8).ok_or_else(|| short("strf"))? as i32;
                let bit_count = u16_at(b, body + 14).ok_or_else(|| short("strf"))?;
                let compression = u32_at(b, body + 16).ok_or_else(|| short("strf"))?;
                if w <= 0 || h == 0 {
                    return Err(AviError::InvalidHeader(format!("bad dimensions {w}x{h}")));
                }
                out = Some(Stream {
                    index,
                    width: w as u32,
                    height: h.unsigned_abs(),
                    bottom_up: h > 0,
                    bit_count,
                    compression,
                });
            }
            b"indx" => *opendml = true,
            _ => {}
        }
        pos = body_end + (size & 1);
    }
    Ok(out)
}

fn parse_hdrl(b: &[u8], mut pos: usize, end: usize) -> Result<Hdrl, AviError> {
    let mut h = Hdrl::default();
    let mut strl_count = 0u32;
    while pos + 8 <= end {
        let id = tag_at(b, pos).ok_or_else(|| short("hdrl"))?;
        let size = u32_at(b, pos + 4).ok_or_else(|| short("hdrl"))? as usize;
        let body = pos + 8;
        let body_end = body.checked_add(size).ok_or_else(|| short("hdrl chunk"))?;
        if body_end > end {
            return Err(AviError::InvalidHeader(
                "hdrl chunk overruns its list".into(),
            ));
        }
        match &id {
            b"avih" => {
                h.usec_per_frame = u32_at(b, body).ok_or_else(|| short("avih"))?;
                h.total_frames = u32_at(b, body + 16).ok_or_else(|| short("avih"))?;
            }
            b"LIST" => match tag_at(b, body) {
                Some(t) if &t == b"strl" => {
                    let s = parse_strl(b, body + 4, body_end, strl_count, &mut h.opendml)?;
                    strl_count += 1;
                    if h.stream.is_none() {
                        h.stream = s;
                    }
                }
                Some(t) if &t == b"odml" => h.opendml = true,
                _ => {}
            },
            _ => {}
        }
        pos = body_end + (size & 1);
    }
    Ok(h)
}

fn classify(compression: u32, bit_count: u16) -> Result<(PixelFormat, String), AviError> {
    let tag = compression.to_le_bytes();
    if compression == 0 {
        return if bit_count == 8 {
            Ok((PixelFormat::Gray8, "BI_RGB".into()))
        } else {
            Err(AviError::Unsupported(format!(
                "uncompressed BI_RGB at {bit_count} bits per pixel (only 8-bit grayscale is supported)"
            )))
        };
    }
    let (format, depth) = match &tag {
        b"GREY" | b"Y800" | b"Y8  " => (PixelFormat::Gray8, 8),
        b"Y16 " => (PixelFormat::Gray16, 16),
        _ => {
            return Err(AviError::Unsupported(format!(
                "compressed or non-grayscale codec '{}' ({bit_count} bits per pixel); \
                 only uncompressed grayscale is supported",
                tag_str(tag)
            )))
        }
    };
    if bit_count != depth {
        return Err(AviError::InvalidHeader(format!(
            "fourcc '{}' with {bit_count} bits per pixel",
            tag_str(tag)
        )));
    }
    Ok((format, tag_str(tag)))
}

impl AviHeader {
    /// Parse the geometry and list layout from a byte prefix, without
    /// choosing frame offsets. Returns [`AviError::NeedMoreData`] when the
    /// prefix stops before the start of the `movi` list.
    pub fn parse_header(prefix: &[u8]) -> Result<HeaderLayout, AviError> {
        let (tag, riff_size, form) = match (tag_at(prefix, 0), u32_at(prefix, 4), tag_at(prefix, 8))
        {
            (Some(t), Some(s), Some(f)) => (t, s, f),
            _ => return Err(AviError::NeedMoreData { needed: 12 }),
        };
        if &tag != b"RIFF" {
            return Err(AviError::InvalidHeader("missing RIFF signature".into()));
        }
        if &form == b"AVIX" {
            return Err(AviError::Unsupported(
                "OpenDML continuation (AVIX) at file start".into(),
            ));
        }
        if &form != b"AVI " {
            return Err(AviError::InvalidHeader(format!(
                "RIFF form '{}' is not 'AVI '",
                tag_str(form)
            )));
        }
        let riff_end = 8 + riff_size as u64;

        let mut hdrl: Option<Hdrl> = None;
        let mut pos: u64 = 12;
        let (movi_offset, movi_size) = loop {
            let p = pos as usize;
            let (id, size) = match (tag_at(prefix, p), u32_at(prefix, p + 4)) {
                (Some(i), Some(s)) if pos <= prefix.len() as u64 => (i, s as u64),
                _ => return Err(AviError::NeedMoreData { needed: pos + 12 }),
            };
            if &id == b"LIST" {
                let list_type = match tag_at(prefix, p + 8) {
                    Some(t) => t,
                    None => return Err(AviError::NeedMoreData { needed: pos + 12 }),
                };
                match &list_type {
                    b"hdrl" => {
                        let end = pos + 8 + size;
                        if end > prefix.len() as u64 {
                            return Err(AviError::NeedMoreData { needed: end + 12 });
                        }
                        hdrl = Some(parse_hdrl(prefix, p + 12, end as usize)?);
                    }
                    b"movi" => break (pos + 8, size),
                    _ => {}
                }
            }
            pos += 8 + pad2(size);
        };

        let hdrl =
            hdrl.ok_or_else(|| AviError::InvalidHeader("no hdrl list before movi".into()))?;
        if hdrl.opendml {
            return Err(AviError::Unsupported(
                "OpenDML AVI (indx/odml): only plain RIFF AVI is supported".into(),
            ));
        }
        let s = hdrl.stream.ok_or_else(|| {
            AviError::InvalidHeader("no video stream (strh 'vids' + strf)".into())
        })?;
        let (pixel_format, fourcc) = classify(s.compression, s.bit_count)?;

        let bpp = pixel_format.bytes_per_pixel() as u64;
        let stride = (s.width as u64 * bpp * 8).div_ceil(32) * 4;
        let frame_bytes = stride * s.height as u64;
        if s.width > 1 << 16
            || s.height > 1 << 16
            || frame_bytes == 0
            || frame_bytes > MAX_FRAME_BYTES
        {
            return Err(AviError::InvalidHeader(format!(
                "implausible frame {}x{} ({frame_bytes} bytes)",
                s.width, s.height
            )));
        }

        let first_chunk_offset = movi_offset + 4;
        // A size of 0 (streaming writers) or one too small to hold the list
        // type makes the end unknowable.
        let movi_end = if movi_size >= 4 {
            movi_offset + movi_size
        } else {
            u64::MAX
        };

        let info = AviInfo {
            width: s.width,
            height: s.height,
            bit_depth: pixel_format.bytes_per_pixel() * 8,
            pixel_format,
            fourcc,
            frame_count: 0,
            frame_bytes: frame_bytes as u32,
            row_stride: stride as u32,
            bottom_up: s.bottom_up,
            declared_usec_per_frame: hdrl.usec_per_frame,
            movi_offset,
            first_chunk_offset,
            movi_end: if movi_end == u64::MAX { 0 } else { movi_end },
            riff_end,
            stream_index: s.index,
            has_idx1: false,
            idx1_absolute: false,
        };

        Ok(HeaderLayout {
            info,
            declared_frames: hdrl.total_frames,
            movi_size,
        })
    }

    /// [`parse_with_size`](Self::parse_with_size) with the file size unknown.
    pub fn parse(prefix: &[u8], idx1: Option<&[u8]>) -> Result<AviHeader, AviError> {
        Self::parse_with_size(prefix, idx1, 0)
    }

    /// Parse a header from a byte prefix and, when the file has one, the
    /// payload of its `idx1` chunk (the bytes after the 8-byte chunk header).
    ///
    /// A usable idx1 decides the frame offsets. Only without one (absent, or
    /// listing no video frames) is a fixed stride from the first chunk
    /// assumed and validated. `file_size` (0 = unknown) bounds the frame
    /// count so a file cut short by a crash, whose `avih` and movi sizes were
    /// never written, still yields exactly its complete frames.
    pub fn parse_with_size(
        prefix: &[u8],
        idx1: Option<&[u8]>,
        file_size: u64,
    ) -> Result<AviHeader, AviError> {
        let layout = Self::parse_header(prefix)?;
        let mut info = layout.info;
        let movi_end = if info.movi_end == 0 {
            u64::MAX
        } else {
            info.movi_end
        };
        let digits = stream_tag_prefix(info.stream_index);

        let from_idx1 = match idx1 {
            Some(table) => offsets_from_idx1(table, &info, movi_end, digits, file_size)?,
            None => None,
        };
        let (offsets, skipped_empty) = match from_idx1 {
            Some((offs, absolute, skipped)) => {
                info.has_idx1 = true;
                info.idx1_absolute = absolute;
                (Offsets::List(offs), skipped)
            }
            None => (
                offsets_from_stride(
                    prefix,
                    &info,
                    layout.movi_size,
                    layout.declared_frames,
                    file_size,
                    digits,
                )?,
                0,
            ),
        };
        info.frame_count = match &offsets {
            Offsets::Stride { count, .. } => *count,
            Offsets::List(v) => u32::try_from(v.len())
                .map_err(|_| AviError::InvalidIndex("too many frames".into()))?,
        };

        Ok(AviHeader {
            info,
            offsets,
            skipped_empty,
            flip_bottom_up: false,
        })
    }

    pub fn info(&self) -> &AviInfo {
        &self.info
    }

    pub fn frame_count(&self) -> u32 {
        self.info.frame_count
    }

    /// Opt in to returning bottom-up frames top-down. Default: off (see the
    /// module docs). Has no effect on files with a negative `biHeight`.
    pub fn set_flip_bottom_up(&mut self, flip: bool) {
        self.flip_bottom_up = flip;
    }

    pub fn flip_bottom_up(&self) -> bool {
        self.flip_bottom_up
    }

    /// Frames skipped because their idx1 entry had size 0 (dropped by the writer).
    pub fn skipped_empty_frames(&self) -> u32 {
        self.skipped_empty
    }

    /// Length of one chunk in `movi`: header plus payload padded to even.
    fn chunk_len(&self) -> u64 {
        8 + pad2(self.info.frame_bytes as u64)
    }

    fn offset_of(&self, index: u32) -> Option<u64> {
        match &self.offsets {
            Offsets::Stride {
                first,
                chunk,
                count,
            } => (index < *count).then(|| first + index as u64 * chunk),
            Offsets::List(v) => v.get(index as usize).copied(),
        }
    }

    /// Byte range `[start, end)` of frame `index`'s whole chunk (8-byte header
    /// plus payload), to pass to [`AviHeader::decode_frame`].
    pub fn frame_range(&self, index: u32) -> Result<(u64, u64), AviError> {
        let off = self.offset_of(index).ok_or(AviError::OutOfRange {
            index,
            frame_count: self.info.frame_count,
        })?;
        Ok((off, off + 8 + self.info.frame_bytes as u64))
    }

    /// How many frames starting at `start` (at most `max`) are stored back to
    /// back, so one read can fetch them. Always `max` (clamped to the end) for
    /// a fixed stride; idx1 files can have gaps.
    pub fn contiguous_run(&self, start: u32, max: u32) -> u32 {
        let n = self.info.frame_count;
        if start >= n || max == 0 {
            return 0;
        }
        let limit = max.min(n - start);
        match &self.offsets {
            Offsets::Stride { .. } => limit,
            Offsets::List(v) => {
                let chunk = self.chunk_len();
                let mut run = 1;
                while run < limit
                    && v[(start + run) as usize] == v[(start + run - 1) as usize] + chunk
                {
                    run += 1;
                }
                run
            }
        }
    }

    /// Byte range of `count` back-to-back frames starting at `start`, for
    /// [`decode_span_into`](Self::decode_span_into). Errors if they are not
    /// contiguous in the file (check with [`contiguous_run`](Self::contiguous_run)).
    pub fn span_range(&self, start: u32, count: u32) -> Result<(u64, u64), AviError> {
        if count == 0 || self.contiguous_run(start, count) != count {
            return Err(AviError::InvalidIndex(format!(
                "frames {start}..{} are not a contiguous run",
                start as u64 + count as u64
            )));
        }
        let (first, _) = self.frame_range(start)?;
        let (_, last_end) = self.frame_range(start + count - 1)?;
        Ok((first, last_end))
    }

    /// Bytes of one decoded frame: `width * height * bytes_per_pixel`.
    pub fn pixel_bytes(&self) -> usize {
        self.info.width as usize
            * self.info.height as usize
            * self.info.pixel_format.bytes_per_pixel() as usize
    }

    /// Validate a frame chunk (tag `NNdc`/`NNdb`, size) and return its pixels
    /// with the row padding removed, `width * height * bytes_per_pixel` bytes,
    /// rows in stored order unless [`set_flip_bottom_up`](Self::set_flip_bottom_up)
    /// was enabled on a bottom-up file.
    pub fn decode_frame(&self, chunk: &[u8]) -> Result<Vec<u8>, AviError> {
        let mut out = vec![0u8; self.pixel_bytes()];
        self.decode_chunk_into(chunk, &mut out)?;
        Ok(out)
    }

    /// Decode `count` back-to-back chunks (from [`span_range`](Self::span_range))
    /// into `out`, which must hold exactly `count * pixel_bytes()` bytes.
    pub fn decode_span_into(
        &self,
        span: &[u8],
        count: u32,
        out: &mut [u8],
    ) -> Result<(), AviError> {
        let px = self.pixel_bytes();
        if out.len() as u64 != px as u64 * count as u64 {
            return Err(AviError::InvalidFrame(format!(
                "output holds {} bytes, need {} for {count} frames",
                out.len(),
                px as u64 * count as u64
            )));
        }
        let chunk = self.chunk_len() as usize;
        for i in 0..count as usize {
            let c = span
                .get(i * chunk..)
                .ok_or_else(|| AviError::InvalidFrame(format!("span ends before frame {i}")))?;
            self.decode_chunk_into(c, &mut out[i * px..(i + 1) * px])?;
        }
        Ok(())
    }

    fn decode_chunk_into(&self, chunk: &[u8], out: &mut [u8]) -> Result<(), AviError> {
        let fb = self.info.frame_bytes as usize;
        let tag = tag_at(chunk, 0)
            .ok_or_else(|| AviError::InvalidFrame("shorter than a chunk header".into()))?;
        let digits = stream_tag_prefix(self.info.stream_index);
        if tag[..2] != digits || !(&tag[2..] == b"dc" || &tag[2..] == b"db") {
            return Err(AviError::InvalidFrame(format!(
                "chunk tag '{}' is not a video frame of stream {}",
                tag_str(tag),
                self.info.stream_index
            )));
        }
        let size = u32_at(chunk, 4).unwrap_or(0) as usize;
        if size != fb {
            return Err(AviError::InvalidFrame(format!(
                "chunk size {size} does not match the expected frame size {fb}"
            )));
        }
        let payload = chunk.get(8..8 + fb).ok_or_else(|| {
            AviError::InvalidFrame(format!("{} bytes given, need {}", chunk.len(), 8 + fb))
        })?;

        let row = self.info.width as usize * self.info.pixel_format.bytes_per_pixel() as usize;
        let stride = self.info.row_stride as usize;
        let h = self.info.height as usize;
        if out.len() != row * h {
            return Err(AviError::InvalidFrame("output buffer size mismatch".into()));
        }
        let flip = self.flip_bottom_up && self.info.bottom_up;
        for r in 0..h {
            let src = if flip { h - 1 - r } else { r };
            let start = src * stride;
            let line = payload
                .get(start..start + row)
                .ok_or_else(|| AviError::InvalidFrame("row outside payload".into()))?;
            out[r * row..(r + 1) * row].copy_from_slice(line);
        }
        Ok(())
    }
}

/// ASCII stream-number prefix of a chunk tag: stream 0 is `"00"`.
fn stream_tag_prefix(index: u32) -> [u8; 2] {
    let i = index.min(99) as u8;
    [b'0' + i / 10, b'0' + i % 10]
}

/// Read the 8-byte header of the `idx1` chunk that follows `movi` and return
/// its payload length. Errors if the bytes are not an `idx1` header.
pub fn idx1_payload_len(header: &[u8]) -> Result<u32, AviError> {
    match (tag_at(header, 0), u32_at(header, 4)) {
        (Some(t), Some(len)) if &t == b"idx1" => Ok(len),
        (Some(t), Some(_)) => Err(AviError::InvalidIndex(format!(
            "expected 'idx1' after movi, found '{}'",
            tag_str(t)
        ))),
        _ => Err(AviError::InvalidIndex("idx1 header is truncated".into())),
    }
}

/// True when `bytes` (read at the end of the RIFF payload) start another RIFF
/// chunk of form `AVIX`, i.e. the file is OpenDML and spans several RIFF chunks.
pub fn is_avix_continuation(bytes: &[u8]) -> bool {
    matches!(
        (tag_at(bytes, 0), tag_at(bytes, 8)),
        (Some(r), Some(f)) if &r == b"RIFF" && &f == b"AVIX"
    )
}

/// Frame offsets from an idx1 payload: `Ok(None)` if it lists no video frames
/// (not usable, so the caller falls back to the stride), else the offsets,
/// whether they were absolute, and how many zero-size entries were skipped.
/// Any size other than 0 or the frame size is an error.
#[allow(clippy::type_complexity)]
fn offsets_from_idx1(
    table: &[u8],
    info: &AviInfo,
    movi_end: u64,
    digits: [u8; 2],
    file_size: u64,
) -> Result<Option<(Vec<u64>, bool, u32)>, AviError> {
    let mut raw: Vec<u64> = Vec::with_capacity(table.len() / 16);
    let mut skipped = 0u32;
    for entry in table.as_chunks::<16>().0 {
        let id = [entry[0], entry[1], entry[2], entry[3]];
        if id[..2] != digits || !(&id[2..] == b"dc" || &id[2..] == b"db") {
            continue;
        }
        let offset = u32::from_le_bytes([entry[8], entry[9], entry[10], entry[11]]) as u64;
        let size = u32::from_le_bytes([entry[12], entry[13], entry[14], entry[15]]) as u64;
        if size == 0 {
            // ffmpeg writes a zero-size entry for a dropped frame.
            skipped += 1;
        } else if size != info.frame_bytes as u64 {
            return Err(AviError::InvalidIndex(format!(
                "entry {} has size {size}, expected {}",
                raw.len() as u32 + skipped,
                info.frame_bytes
            )));
        } else {
            raw.push(offset);
        }
    }
    if raw.is_empty() {
        return Ok(None);
    }

    // idx1 offsets are relative to the 'movi' fourcc by the spec, but many
    // writers store absolute file offsets. Decide from where the entries land.
    let size = info.frame_bytes as u64;
    let fits = |absolute: bool| {
        raw.iter().all(|&off| {
            let pos = if absolute {
                off
            } else {
                info.movi_offset + off
            };
            pos >= info.first_chunk_offset && pos + 8 + size <= movi_end
        })
    };
    let absolute = match (fits(false), fits(true)) {
        (true, false) => false,
        (false, true) => true,
        // Both fit: the first entry pointing exactly at the first chunk
        // decides (the relative form is then 4, never a file offset).
        (true, true) => raw[0] == info.first_chunk_offset,
        (false, false) => {
            return Err(AviError::InvalidIndex(
                "idx1 offsets fall outside the movi list under both the relative and absolute interpretation".into(),
            ))
        }
    };
    let mut offsets: Vec<u64> = raw
        .iter()
        .map(|&off| {
            if absolute {
                off
            } else {
                info.movi_offset + off
            }
        })
        .collect();
    // A file cut short: drop frames that do not fit (order-preserving).
    if file_size > 0 {
        offsets.retain(|&o| o + 8 + size <= file_size);
    }
    Ok(Some((offsets, absolute, skipped)))
}

fn offsets_from_stride(
    prefix: &[u8],
    info: &AviInfo,
    movi_size: u64,
    declared_frames: u32,
    file_size: u64,
    digits: [u8; 2],
) -> Result<Offsets, AviError> {
    let chunk = 8 + pad2(info.frame_bytes as u64);
    let first = info.first_chunk_offset;
    // The first chunk must be a frame of the right size, if the prefix reaches it.
    if let (Some(tag), Some(size)) = (
        tag_at(prefix, first as usize),
        u32_at(prefix, first as usize + 4),
    ) {
        let ok_tag = tag[..2] == digits && (&tag[2..] == b"dc" || &tag[2..] == b"db");
        if !ok_tag || size != info.frame_bytes {
            return Err(AviError::InvalidIndex(format!(
                "no idx1 and the first movi chunk is '{}' of {size} bytes, not a {}-byte frame; \
                 cannot assume a fixed frame stride",
                tag_str(tag),
                info.frame_bytes
            )));
        }
    }
    // Every bound that is known applies; a crashed writer leaves the header
    // count and the movi size at 0, so the file size is then the only bound.
    let mut count = u64::MAX;
    if declared_frames > 0 {
        count = count.min(declared_frames as u64);
    }
    if movi_size >= 4 {
        count = count.min((movi_size - 4) / chunk);
    }
    if file_size > 0 {
        count = count.min(file_size.saturating_sub(first) / chunk);
    }
    if count == u64::MAX {
        return Err(AviError::InvalidIndex(
            "no idx1, and neither the header, the movi size nor the file size bounds the frame count"
                .into(),
        ));
    }
    Ok(Offsets::Stride {
        first,
        chunk,
        count: count.min(u32::MAX as u64) as u32,
    })
}

#[cfg(test)]
mod tests;
