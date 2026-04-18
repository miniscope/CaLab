//! Parser for uncompressed 8-bit / 24-bit AVI files.
//!
//! CaLa's v1 input path: miniscope recorders emit raw RIFF-AVI with
//! `BI_RGB` (uncompressed) frames — 8-bit grayscale is the common case;
//! 24-bit BGR shows up when recorders run in color mode. This reader
//! does a single in-memory parse over the byte buffer, collects frame
//! offsets, and lets callers grab individual frames on demand. No
//! allocations per frame — the returned slices alias `data`.
//!
//! Compressed codecs, `indx` super-indexes, multi-stream files, and
//! color-space variants other than BGR are explicitly out of scope
//! for Phase 1 (see design §11).

use crate::config::GrayscaleMethod;

/// Upper bound on `width · height · channels` we'll accept from an AVI
/// header. Malformed or hostile files can declare arbitrarily large
/// dimensions; without a cap, the multiplication silently wraps on
/// 32-bit targets (wasm32) and forces huge downstream allocations on
/// 64-bit. 512 MiB is well above realistic miniscope frames (the
/// largest stream we've seen is ~4 MiB per frame) while keeping
/// attacks bounded to a single large-but-survivable alloc.
pub const MAX_FRAME_BYTES: usize = 512 * 1024 * 1024;

/// Errors surfaced by the AVI reader.
#[derive(Debug, Clone, PartialEq)]
pub enum AviError {
    /// Magic didn't match `"RIFF"…"AVI "`.
    NotAvi,
    /// Ran off the end of the buffer mid-parse; context string names
    /// the field we were trying to read.
    Truncated(&'static str),
    /// Format is structurally valid but outside Phase 1 support
    /// (e.g. 16-bit depth, JPEG codec, stride-padded rows).
    Unsupported(&'static str),
    /// A structural field held an unexpected value.
    BadHeader(&'static str),
    /// Caller asked for a frame index ≥ `frame_count`.
    FrameOutOfRange(u32),
    /// Grayscale output buffer is the wrong length for this stream.
    OutputLengthMismatch { expected: usize, actual: usize },
    /// `width · height · channels` exceeded `MAX_FRAME_BYTES` or
    /// overflowed `usize` arithmetic.
    FrameTooLarge,
}

/// Reader over an in-memory uncompressed AVI.
#[derive(Debug)]
pub struct AviUncompressedReader<'a> {
    data: &'a [u8],
    width: u32,
    height: u32,
    frame_count: u32,
    micro_sec_per_frame: u32,
    bit_depth: u16,
    channels: u8,
    frame_byte_size: usize,
    /// Byte offsets of each frame's pixel data (past the 8-byte chunk
    /// header), into `data`.
    frame_offsets: Vec<usize>,
}

impl<'a> AviUncompressedReader<'a> {
    pub fn new(data: &'a [u8]) -> Result<Self, AviError> {
        let mut p = Parser::new(data);

        if p.read_fourcc()? != *b"RIFF" {
            return Err(AviError::NotAvi);
        }
        // riff_size is the size of the remainder; we don't enforce it
        // since downstream chunk reads catch truncation.
        let _riff_size = p.read_u32()?;
        if p.read_fourcc()? != *b"AVI " {
            return Err(AviError::NotAvi);
        }

        let mut header: Option<AviHeader> = None;
        let mut stream: Option<StreamHeader> = None;
        let mut format: Option<VideoFormat> = None;
        let mut movi_range: Option<(usize, usize)> = None;

        while !p.at_end() {
            let fcc = p.read_fourcc()?;
            let size = p.read_u32()? as usize;
            let content_start = p.pos;
            let content_end = content_start
                .checked_add(size)
                .ok_or(AviError::BadHeader("chunk size overflow"))?;
            if content_end > data.len() {
                return Err(AviError::Truncated("top-level chunk"));
            }

            if &fcc == b"LIST" {
                let list_type = p.read_fourcc()?;
                match &list_type {
                    b"hdrl" => {
                        parse_hdrl(
                            &data[p.pos..content_end],
                            &mut header,
                            &mut stream,
                            &mut format,
                        )?;
                    }
                    b"movi" => {
                        movi_range = Some((p.pos, content_end));
                    }
                    _ => {}
                }
            }
            // idx1 and unknown top-level chunks are skipped; scan over
            // movi is the source of truth for frame offsets.

            p.pos = content_end;
            if p.pos % 2 == 1 && p.pos < data.len() {
                p.pos += 1; // RIFF word-alignment pad byte
            }
        }

        let header = header.ok_or(AviError::BadHeader("missing avih"))?;
        let stream = stream.ok_or(AviError::BadHeader("missing strh"))?;
        let format = format.ok_or(AviError::BadHeader("missing strf"))?;
        let (movi_start, movi_end) = movi_range.ok_or(AviError::BadHeader("missing movi"))?;

        if format.compression != 0 {
            return Err(AviError::Unsupported("compressed codec"));
        }
        let (channels, bit_depth) = match format.bit_depth {
            8 => (1u8, 8u16),
            24 => (3u8, 24u16),
            _ => return Err(AviError::Unsupported("bit depth")),
        };
        let width = header.width.max(format.width.max(0) as u32);
        let height = header.height.max(format.height.unsigned_abs());
        if width == 0 || height == 0 {
            return Err(AviError::BadHeader("zero frame dimension"));
        }
        // Use checked arithmetic: on 32-bit/wasm32 these multiplications
        // can silently wrap, so a hostile header would otherwise bypass
        // any size check. Cap the result at MAX_FRAME_BYTES.
        let frame_byte_size = (width as usize)
            .checked_mul(height as usize)
            .and_then(|v| v.checked_mul(channels as usize))
            .ok_or(AviError::FrameTooLarge)?;
        if frame_byte_size > MAX_FRAME_BYTES {
            return Err(AviError::FrameTooLarge);
        }
        // Stride-padded rows (common in BMP) are outside Phase 1 scope.
        // Most miniscope recorders pack tightly, so we require that.
        if format.size_image != 0 && (format.size_image as usize) != frame_byte_size {
            return Err(AviError::Unsupported("stride-padded rows"));
        }

        let frame_offsets =
            scan_movi_for_frame_offsets(&data[movi_start..movi_end], movi_start, frame_byte_size)?;

        // Prefer the concrete frame count recovered from the movi scan
        // over the one declared in avih/strh — headers can lie.
        let declared = if stream.length > 0 {
            stream.length
        } else {
            header.total_frames
        };
        let frame_count = if declared > 0 {
            declared.min(frame_offsets.len() as u32)
        } else {
            frame_offsets.len() as u32
        };

        Ok(Self {
            data,
            width,
            height,
            frame_count,
            micro_sec_per_frame: header.micro_sec_per_frame,
            bit_depth,
            channels,
            frame_byte_size,
            frame_offsets,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }

    /// Frames per second, derived from avih's `dwMicroSecPerFrame`.
    /// Returns `0.0` if the header didn't set a sensible value.
    pub fn fps(&self) -> f32 {
        if self.micro_sec_per_frame == 0 {
            0.0
        } else {
            1_000_000.0 / self.micro_sec_per_frame as f32
        }
    }

    pub fn bit_depth(&self) -> u16 {
        self.bit_depth
    }

    pub fn channels(&self) -> u8 {
        self.channels
    }

    /// Raw pixel bytes for frame `n` (length = `width·height·channels`).
    pub fn frame_bytes(&self, n: u32) -> Result<&'a [u8], AviError> {
        if n >= self.frame_count {
            return Err(AviError::FrameOutOfRange(n));
        }
        let offset = self.frame_offsets[n as usize];
        let end = offset
            .checked_add(self.frame_byte_size)
            .ok_or(AviError::Truncated("frame end"))?;
        if end > self.data.len() {
            return Err(AviError::Truncated("frame data"));
        }
        Ok(&self.data[offset..end])
    }

    /// Decode frame `n` into an `f32` grayscale buffer.
    ///
    /// - 8-bit streams: each byte is taken directly as intensity
    ///   (palette, if any, is ignored — consistent with the
    ///   "mono 8-bit" convention used by miniscope recorders).
    /// - 24-bit streams: reduced to grayscale using `method`.
    ///
    /// `output` must be exactly `width·height` long.
    pub fn read_frame_grayscale_f32(
        &self,
        n: u32,
        output: &mut [f32],
        method: GrayscaleMethod,
    ) -> Result<(), AviError> {
        let pixels = (self.width as usize) * (self.height as usize);
        if output.len() != pixels {
            return Err(AviError::OutputLengthMismatch {
                expected: pixels,
                actual: output.len(),
            });
        }
        let bytes = self.frame_bytes(n)?;
        match self.channels {
            1 => {
                for (i, &b) in bytes.iter().enumerate() {
                    output[i] = b as f32;
                }
            }
            3 => {
                for i in 0..pixels {
                    let b = bytes[i * 3] as f32;
                    let g = bytes[i * 3 + 1] as f32;
                    let r = bytes[i * 3 + 2] as f32;
                    output[i] = match method {
                        GrayscaleMethod::Green => g,
                        GrayscaleMethod::Luminance => 0.299 * r + 0.587 * g + 0.114 * b,
                    };
                }
            }
            _ => return Err(AviError::Unsupported("channel count")),
        }
        Ok(())
    }
}

// ---- Intermediate parse results ----

struct AviHeader {
    micro_sec_per_frame: u32,
    total_frames: u32,
    width: u32,
    height: u32,
}

struct StreamHeader {
    length: u32,
}

struct VideoFormat {
    width: i32,
    height: i32,
    bit_depth: u16,
    compression: u32,
    size_image: u32,
}

// ---- Parser helpers ----

struct Parser<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn at_end(&self) -> bool {
        self.pos >= self.data.len()
    }

    fn remaining(&self) -> usize {
        self.data.len() - self.pos
    }

    fn read_fourcc(&mut self) -> Result<[u8; 4], AviError> {
        if self.remaining() < 4 {
            return Err(AviError::Truncated("fourcc"));
        }
        let mut fcc = [0u8; 4];
        fcc.copy_from_slice(&self.data[self.pos..self.pos + 4]);
        self.pos += 4;
        Ok(fcc)
    }

    fn read_u32(&mut self) -> Result<u32, AviError> {
        if self.remaining() < 4 {
            return Err(AviError::Truncated("u32"));
        }
        let v = u32::from_le_bytes(self.data[self.pos..self.pos + 4].try_into().unwrap());
        self.pos += 4;
        Ok(v)
    }
}

fn read_u32_le(buf: &[u8], offset: usize) -> Result<u32, AviError> {
    if offset + 4 > buf.len() {
        return Err(AviError::Truncated("u32 slice"));
    }
    Ok(u32::from_le_bytes(
        buf[offset..offset + 4].try_into().unwrap(),
    ))
}

fn read_i32_le(buf: &[u8], offset: usize) -> Result<i32, AviError> {
    if offset + 4 > buf.len() {
        return Err(AviError::Truncated("i32 slice"));
    }
    Ok(i32::from_le_bytes(
        buf[offset..offset + 4].try_into().unwrap(),
    ))
}

fn read_u16_le(buf: &[u8], offset: usize) -> Result<u16, AviError> {
    if offset + 2 > buf.len() {
        return Err(AviError::Truncated("u16 slice"));
    }
    Ok(u16::from_le_bytes(
        buf[offset..offset + 2].try_into().unwrap(),
    ))
}

/// Walk `LIST hdrl` contents: pick off `avih`, recurse into `LIST strl`.
fn parse_hdrl(
    hdrl_body: &[u8],
    header_out: &mut Option<AviHeader>,
    stream_out: &mut Option<StreamHeader>,
    format_out: &mut Option<VideoFormat>,
) -> Result<(), AviError> {
    let mut pos = 0;
    while pos + 8 <= hdrl_body.len() {
        let fcc: [u8; 4] = hdrl_body[pos..pos + 4].try_into().unwrap();
        let size = read_u32_le(hdrl_body, pos + 4)? as usize;
        let body_start = pos + 8;
        let body_end = body_start
            .checked_add(size)
            .ok_or(AviError::BadHeader("hdrl chunk size overflow"))?;
        if body_end > hdrl_body.len() {
            return Err(AviError::Truncated("hdrl chunk"));
        }
        let body = &hdrl_body[body_start..body_end];
        match &fcc {
            b"avih" => *header_out = Some(parse_avih(body)?),
            b"LIST" if body.len() >= 4 && &body[..4] == b"strl" => {
                let (s, f) = parse_strl(&body[4..])?;
                if stream_out.is_none() {
                    *stream_out = Some(s);
                }
                if format_out.is_none() {
                    *format_out = Some(f);
                }
            }
            _ => {}
        }
        pos = body_end;
        if pos % 2 == 1 && pos < hdrl_body.len() {
            pos += 1;
        }
    }
    Ok(())
}

fn parse_avih(body: &[u8]) -> Result<AviHeader, AviError> {
    // Layout (little-endian u32 fields, offsets in bytes):
    //   0  dwMicroSecPerFrame
    //  16  dwTotalFrames
    //  32  dwWidth
    //  36  dwHeight
    if body.len() < 40 {
        return Err(AviError::Truncated("avih body"));
    }
    Ok(AviHeader {
        micro_sec_per_frame: read_u32_le(body, 0)?,
        total_frames: read_u32_le(body, 16)?,
        width: read_u32_le(body, 32)?,
        height: read_u32_le(body, 36)?,
    })
}

/// Walk `LIST strl` contents (body starts past the `strl` fourcc):
/// pick off `strh` and the video `strf`.
fn parse_strl(body: &[u8]) -> Result<(StreamHeader, VideoFormat), AviError> {
    let mut pos = 0;
    let mut strh: Option<StreamHeader> = None;
    let mut strf: Option<VideoFormat> = None;
    let mut stream_is_video = false;
    while pos + 8 <= body.len() {
        let fcc: [u8; 4] = body[pos..pos + 4].try_into().unwrap();
        let size = read_u32_le(body, pos + 4)? as usize;
        let b_start = pos + 8;
        let b_end = b_start
            .checked_add(size)
            .ok_or(AviError::BadHeader("strl chunk size overflow"))?;
        if b_end > body.len() {
            return Err(AviError::Truncated("strl chunk"));
        }
        let b = &body[b_start..b_end];
        match &fcc {
            b"strh" => {
                if b.len() < 32 {
                    return Err(AviError::Truncated("strh body"));
                }
                stream_is_video = &b[0..4] == b"vids";
                // dwLength sits at offset 32.
                let length = if b.len() >= 36 {
                    read_u32_le(b, 32)?
                } else {
                    0
                };
                strh = Some(StreamHeader { length });
            }
            b"strf" if stream_is_video => {
                strf = Some(parse_bitmap_info_header(b)?);
            }
            _ => {}
        }
        pos = b_end;
        if pos % 2 == 1 && pos < body.len() {
            pos += 1;
        }
    }
    if !stream_is_video {
        return Err(AviError::Unsupported("non-video stream"));
    }
    Ok((
        strh.ok_or(AviError::BadHeader("missing strh"))?,
        strf.ok_or(AviError::BadHeader("missing strf"))?,
    ))
}

fn parse_bitmap_info_header(body: &[u8]) -> Result<VideoFormat, AviError> {
    // BITMAPINFOHEADER layout:
    //   0  biSize (u32)
    //   4  biWidth (i32)
    //   8  biHeight (i32)
    //  12  biPlanes (u16)
    //  14  biBitCount (u16)
    //  16  biCompression (u32)
    //  20  biSizeImage (u32)
    if body.len() < 40 {
        return Err(AviError::Truncated("BITMAPINFOHEADER"));
    }
    Ok(VideoFormat {
        width: read_i32_le(body, 4)?,
        height: read_i32_le(body, 8)?,
        bit_depth: read_u16_le(body, 14)?,
        compression: read_u32_le(body, 16)?,
        size_image: read_u32_le(body, 20)?,
    })
}

/// Scan the `movi` list body for frame chunks. Accepts `00db`
/// (uncompressed keyframe) and `00dc` (delta, here always treated
/// as uncompressed since we already rejected compressed codecs).
/// Returns absolute byte offsets of each frame's pixel data into
/// the full file `data`.
fn scan_movi_for_frame_offsets(
    movi_body: &[u8],
    movi_start_in_file: usize,
    expected_frame_size: usize,
) -> Result<Vec<usize>, AviError> {
    let mut offsets = Vec::new();
    let mut pos = 0;
    while pos + 8 <= movi_body.len() {
        let fcc: [u8; 4] = movi_body[pos..pos + 4].try_into().unwrap();
        let size = read_u32_le(movi_body, pos + 4)? as usize;
        let body_start = pos + 8;
        let body_end = body_start
            .checked_add(size)
            .ok_or(AviError::BadHeader("movi chunk size overflow"))?;
        if body_end > movi_body.len() {
            return Err(AviError::Truncated("movi chunk"));
        }
        if is_frame_chunk(&fcc) {
            if size != expected_frame_size {
                return Err(AviError::Unsupported("unexpected frame chunk size"));
            }
            offsets.push(movi_start_in_file + body_start);
        }
        pos = body_end;
        if pos % 2 == 1 && pos < movi_body.len() {
            pos += 1;
        }
    }
    Ok(offsets)
}

fn is_frame_chunk(fcc: &[u8; 4]) -> bool {
    // "NNdb" or "NNdc" where NN are ASCII digits identifying the stream.
    fcc[0].is_ascii_digit()
        && fcc[1].is_ascii_digit()
        && fcc[2] == b'd'
        && (fcc[3] == b'b' || fcc[3] == b'c')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_frame_chunk_accepts_00db_and_01dc() {
        assert!(is_frame_chunk(b"00db"));
        assert!(is_frame_chunk(b"00dc"));
        assert!(is_frame_chunk(b"01db"));
        assert!(!is_frame_chunk(b"hdrl"));
        assert!(!is_frame_chunk(b"idx1"));
        assert!(!is_frame_chunk(b"abdb"));
    }
}
