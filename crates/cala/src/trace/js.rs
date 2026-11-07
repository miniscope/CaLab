//! wasm-bindgen surface of the fast loop, for a Web Worker.
//!
//! Build a library with `TraceLibraryBuilder` (footprints are unfiltered,
//! non-negative patches; `buildFlattened` applies the preprocessing high-pass
//! with the same FOV mask and σ as the preprocessing chain), wrap it in a
//! `TraceEngine`, and feed preprocessed frames in batches. A new library
//! (from the slow loop) is swapped in with `setLibrary` between batches.

use std::sync::Arc;

use wasm_bindgen::prelude::*;

use super::library::{IdentityFilter, Library, LibraryBuilder};
use super::{BackgroundModel, Footprint, FrameTraces, SolverConfig, TraceEngine, TraceError};
use crate::preprocess::flatten::{FlattenConfig, GlowFlattener};
use crate::preprocess::fov::FovMask;
use crate::preprocess::Dims;

fn js_err(func: &str, e: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("{func}: {e}"))
}

/// Collects footprints and settings for a [`JsTraceLibrary`].
#[wasm_bindgen(js_name = TraceLibraryBuilder)]
pub struct JsTraceLibraryBuilder {
    inner: Option<LibraryBuilder>,
    dims: Dims,
}

#[wasm_bindgen(js_class = TraceLibraryBuilder)]
impl JsTraceLibraryBuilder {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> Result<JsTraceLibraryBuilder, JsError> {
        console_error_panic_hook::set_once();
        let dims = Dims::new(width as usize, height as usize)
            .map_err(|e| js_err("TraceLibraryBuilder", e))?;
        Ok(JsTraceLibraryBuilder {
            inner: Some(LibraryBuilder::new(dims)),
            dims,
        })
    }

    fn take(&mut self, func: &str) -> Result<LibraryBuilder, JsError> {
        self.inner
            .take()
            .ok_or_else(|| JsError::new(&format!("{func}: builder already used")))
    }

    /// One unfiltered footprint: `values` is `height * width`, row-major.
    #[wasm_bindgen(js_name = addFootprint)]
    pub fn add_footprint(
        &mut self,
        id: u32,
        y0: u32,
        x0: u32,
        height: u32,
        width: u32,
        values: &[f32],
    ) -> Result<(), JsError> {
        let b = self
            .inner
            .as_mut()
            .ok_or_else(|| JsError::new("addFootprint: builder already used"))?;
        b.push(Footprint {
            id: u64::from(id),
            y0: y0 as usize,
            x0: x0 as usize,
            height: height as usize,
            width: width as usize,
            values: values.to_vec(),
        });
        Ok(())
    }

    /// Per-pixel noise σ of the preprocessed frames (the noise map).
    #[wasm_bindgen(js_name = setNoise)]
    pub fn set_noise(&mut self, sigma: &[f32]) -> Result<(), JsError> {
        let b = self.take("setNoise")?;
        self.inner = Some(b.noise(sigma.to_vec()));
        Ok(())
    }

    /// Background basis: `count` full-frame maps, concatenated.
    #[wasm_bindgen(js_name = setBackgroundMaps)]
    pub fn set_background_maps(&mut self, maps: &[f32], count: u32) -> Result<(), JsError> {
        let n = self.dims.pixels();
        if maps.len() != n * count as usize {
            return Err(JsError::new(&format!(
                "setBackgroundMaps: {} values for {count} maps of {n}",
                maps.len()
            )));
        }
        let b = self.take("setBackgroundMaps")?;
        let m = maps.chunks_exact(n).map(<[f32]>::to_vec).collect();
        self.inner = Some(b.background(BackgroundModel::Basis(m)));
        Ok(())
    }

    /// Ring background `inner..outer` px around each cell.
    #[wasm_bindgen(js_name = setRing)]
    pub fn set_ring(&mut self, inner_px: f32, outer_px: f32) -> Result<(), JsError> {
        let b = self.take("setRing")?;
        self.inner = Some(b.background(BackgroundModel::Ring { inner_px, outer_px }));
        Ok(())
    }

    /// Build with the glow-flattening high-pass of the preprocessing chain
    /// (`fov` = its FOV mask, `cell_diameter_px` = its setting).
    #[wasm_bindgen(js_name = buildFlattened)]
    pub fn build_flattened(
        &mut self,
        fov: &[u8],
        cell_diameter_px: f32,
    ) -> Result<JsTraceLibrary, JsError> {
        let mask = FovMask::from_mask(self.dims, fov).map_err(|e| js_err("buildFlattened", e))?;
        let cfg = FlattenConfig {
            cell_diameter_px,
            ..FlattenConfig::default()
        };
        let mut flat = GlowFlattener::new(&mask, &cfg).map_err(|e| js_err("buildFlattened", e))?;
        let b = self.take("buildFlattened")?.fov(fov.to_vec());
        let lib = b
            .build(&mut flat)
            .map_err(|e| js_err("buildFlattened", e))?;
        Ok(JsTraceLibrary {
            inner: Arc::new(lib),
        })
    }

    /// Build without filtering the footprints.
    #[wasm_bindgen(js_name = buildUnfiltered)]
    pub fn build_unfiltered(&mut self) -> Result<JsTraceLibrary, JsError> {
        let lib = self
            .take("buildUnfiltered")?
            .build(&mut IdentityFilter(self.dims))
            .map_err(|e| js_err("buildUnfiltered", e))?;
        Ok(JsTraceLibrary {
            inner: Arc::new(lib),
        })
    }
}

/// An immutable, versioned footprint library.
#[wasm_bindgen(js_name = TraceLibrary)]
pub struct JsTraceLibrary {
    inner: Arc<Library>,
}

#[wasm_bindgen(js_class = TraceLibrary)]
impl JsTraceLibrary {
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> f64 {
        self.inner.version() as f64
    }

    #[wasm_bindgen(getter, js_name = cellCount)]
    pub fn cell_count(&self) -> u32 {
        self.inner.len() as u32
    }

    /// Cell ids in trace order.
    pub fn ids(&self) -> Vec<u32> {
        self.inner.ids().iter().map(|&v| v as u32).collect()
    }

    /// Noise σ of each trace.
    #[wasm_bindgen(js_name = traceNoise)]
    pub fn trace_noise(&self) -> Vec<f32> {
        self.inner.trace_noise().to_vec()
    }

    /// The library as bytes, to send to another worker (`fromBytes`).
    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.inner.to_bytes()
    }

    /// A library from `toBytes` (same version; footprints are not filtered
    /// again, only the solver's precomputed terms are rebuilt).
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<JsTraceLibrary, JsError> {
        console_error_panic_hook::set_once();
        let lib = Library::from_bytes(bytes).map_err(|e| js_err("fromBytes", e))?;
        Ok(JsTraceLibrary::from_arc(Arc::new(lib)))
    }

    /// Support centre `(y, x)` of each cell, interleaved, slot order.
    pub fn centers(&self) -> Vec<f32> {
        (0..self.inner.len())
            .flat_map(|i| {
                let ((y, x), _) = self.inner.support(i);
                [y, x]
            })
            .collect()
    }

    /// Support radius of each cell, px, slot order.
    pub fn radii(&self) -> Vec<f32> {
        (0..self.inner.len())
            .map(|i| self.inner.support(i).1)
            .collect()
    }

    /// Offsets into `supportPixels` / `footprintValues`: cell `i` owns
    /// `[starts[i], starts[i + 1])` (length `cellCount + 1`).
    #[wasm_bindgen(js_name = supportStarts)]
    pub fn support_starts(&self) -> Vec<u32> {
        let mut out = Vec::with_capacity(self.inner.len() + 1);
        let mut at = 0u32;
        out.push(at);
        for i in 0..self.inner.len() {
            at += self.inner.unfiltered(i).0.len() as u32;
            out.push(at);
        }
        out
    }

    /// Row-major pixel index of every support pixel, cell after cell.
    #[wasm_bindgen(js_name = supportPixels)]
    pub fn support_pixels(&self) -> Vec<u32> {
        (0..self.inner.len())
            .flat_map(|i| self.inner.unfiltered(i).0.iter().copied())
            .collect()
    }

    /// Unfiltered footprint value of every support pixel (as `supportPixels`).
    #[wasm_bindgen(js_name = footprintValues)]
    pub fn footprint_values(&self) -> Vec<f32> {
        (0..self.inner.len())
            .flat_map(|i| self.inner.unfiltered(i).1.iter().copied())
            .collect()
    }
}

impl JsTraceLibrary {
    pub(crate) fn from_arc(inner: Arc<Library>) -> JsTraceLibrary {
        JsTraceLibrary { inner }
    }

    pub(crate) fn arc(&self) -> &Arc<Library> {
        &self.inner
    }
}

/// The per-frame trace solver.
#[wasm_bindgen(js_name = TraceEngine)]
pub struct JsTraceEngine {
    inner: TraceEngine,
    out: FrameTraces,
}

#[wasm_bindgen(js_class = TraceEngine)]
impl JsTraceEngine {
    /// `tol` (noise units) and `max_sweeps`: 0 = defaults.
    #[wasm_bindgen(constructor)]
    pub fn new(
        library: &JsTraceLibrary,
        tol: f32,
        max_sweeps: u32,
    ) -> Result<JsTraceEngine, JsError> {
        console_error_panic_hook::set_once();
        let mut cfg = SolverConfig::default();
        if tol > 0.0 {
            cfg.tol = tol;
        }
        if max_sweeps > 0 {
            cfg.max_sweeps = max_sweeps;
        }
        let inner =
            TraceEngine::new(library.inner.clone(), cfg).map_err(|e| js_err("TraceEngine", e))?;
        Ok(JsTraceEngine {
            inner,
            out: FrameTraces::default(),
        })
    }

    /// Swap the library before the next frame (warm starts follow cell ids).
    #[wasm_bindgen(js_name = setLibrary)]
    pub fn set_library(&mut self, library: &JsTraceLibrary) -> Result<(), JsError> {
        self.inner
            .set_library(library.inner.clone())
            .map_err(|e| js_err("setLibrary", e))
    }

    /// Solve `count` preprocessed frames; returns `count x cells` traces,
    /// frame after frame, in the library's id order.
    #[wasm_bindgen(js_name = processFrames)]
    pub fn process_frames(&mut self, frames: &[f32], count: u32) -> Result<Vec<f32>, JsError> {
        let n = self.inner.library().dims().pixels();
        if frames.len() != n * count as usize {
            return Err(js_err(
                "processFrames",
                TraceError::LengthMismatch {
                    what: "frames",
                    expected: n * count as usize,
                    got: frames.len(),
                },
            ));
        }
        let mut out = Vec::with_capacity(count as usize * self.inner.library().len());
        for f in frames.chunks_exact(n) {
            self.inner
                .process_into(f, &mut self.out)
                .map_err(|e| js_err("processFrames", e))?;
            out.extend_from_slice(&self.out.traces);
        }
        Ok(out)
    }

    #[wasm_bindgen(getter, js_name = nextFrame)]
    pub fn next_frame(&self) -> f64 {
        self.inner.next_frame() as f64
    }
}
