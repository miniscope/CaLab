//! Minimal `.npy` reader for test fixtures: C-order `u1`, `<i8`, `<f4` and `<f8`
//! arrays, format versions 1-3. Not a general parser.

use std::path::Path;

pub struct Npy {
    pub shape: Vec<usize>,
    pub data: NpyData,
}

pub enum NpyData {
    U8(Vec<u8>),
    F32(Vec<f32>),
    F64(Vec<f64>),
    I64(Vec<i64>),
}

impl Npy {
    pub fn read(path: impl AsRef<Path>) -> Result<Npy, String> {
        let path = path.as_ref();
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Self::parse(&bytes).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn parse(b: &[u8]) -> Result<Npy, String> {
        if b.len() < 10 || &b[..6] != b"\x93NUMPY" {
            return Err("not an .npy file".into());
        }
        let (hlen, start) = match b[6] {
            1 => (u16::from_le_bytes([b[8], b[9]]) as usize, 10),
            2 | 3 => {
                if b.len() < 12 {
                    return Err("truncated header".into());
                }
                (u32::from_le_bytes([b[8], b[9], b[10], b[11]]) as usize, 12)
            }
            v => return Err(format!("unsupported npy version {v}")),
        };
        let header = std::str::from_utf8(b.get(start..start + hlen).ok_or("truncated header")?)
            .map_err(|_| "header is not UTF-8")?;
        if header.contains("'fortran_order': True") {
            return Err("Fortran-order arrays are not supported".into());
        }
        let field = |key: &str| -> Result<&str, String> {
            let i = header.find(key).ok_or(format!("header lacks {key}"))? + key.len();
            Ok(header[i..].trim_start_matches([':', ' ']))
        };
        let descr = field("'descr'")?;
        let descr = &descr[1..descr[1..].find('\'').ok_or("bad descr")? + 1];
        let shape_s = field("'shape'")?;
        let close = shape_s.find(')').ok_or("bad shape")?;
        let shape: Vec<usize> = shape_s[1..close]
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.parse::<usize>().map_err(|e| e.to_string()))
            .collect::<Result<_, _>>()?;
        let n: usize = shape.iter().product();
        let body = &b[start + hlen..];
        let need = |size: usize| -> Result<&[u8], String> {
            body.get(..n * size).ok_or(format!(
                "body holds {} bytes, need {}",
                body.len(),
                n * size
            ))
        };
        let data = match descr {
            "|u1" | "<u1" => NpyData::U8(need(1)?.to_vec()),
            "<f4" => NpyData::F32(
                need(4)?
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|c| f32::from_le_bytes(*c))
                    .collect(),
            ),
            "<f8" => NpyData::F64(
                need(8)?
                    .as_chunks::<8>()
                    .0
                    .iter()
                    .map(|c| f64::from_le_bytes(*c))
                    .collect(),
            ),
            "<i8" => NpyData::I64(
                need(8)?
                    .as_chunks::<8>()
                    .0
                    .iter()
                    .map(|c| i64::from_le_bytes(*c))
                    .collect(),
            ),
            d => return Err(format!("unsupported dtype {d}")),
        };
        Ok(Npy { shape, data })
    }

    pub fn into_u8(self) -> Result<Vec<u8>, String> {
        match self.data {
            NpyData::U8(v) => Ok(v),
            _ => Err("expected a u8 array".into()),
        }
    }

    pub fn into_f64(self) -> Vec<f64> {
        match self.data {
            NpyData::U8(v) => v.into_iter().map(f64::from).collect(),
            NpyData::F32(v) => v.into_iter().map(f64::from).collect(),
            NpyData::F64(v) => v,
            NpyData::I64(v) => v.into_iter().map(|x| x as f64).collect(),
        }
    }
}
