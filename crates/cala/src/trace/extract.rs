//! Re-extraction: traces for a span of frames as a pure function of the
//! library, the recorded preprocessing / motion, and the raw frames.
//!
//! Pass 2 (back-propagation of a newer library into earlier frames) is the
//! same per-frame solve as the online pass, so it is written as a replay:
//! restore the [`PreprocessState`] saved at the start of the span, apply the
//! recorded motion correction of each frame instead of re-estimating it
//! ([`ReplayRegistrar`]), and solve with the given library. With the library
//! and warm start of the online pass this reproduces the online traces bit
//! for bit; with a newer library it is the back-propagated result. Frames are
//! pulled from an iterator and results pushed to a sink one at a time, so a
//! span of any length runs in constant memory.

use std::fmt;
use std::sync::Arc;

use super::library::Library;
use super::solver::{FrameTraces, SolverConfig, TraceEngine, TraceState};
use super::{check_len, TraceError};
use crate::preprocess::{FrameRegistrar, PreprocessError, PreprocessState, Preprocessor, RawPixel};

/// A [`FrameRegistrar`] that applies a recorded correction (set with
/// [`ReplayRegistrar::set`]) through the wrapped registrar's `replay`.
pub struct ReplayRegistrar<'a, R: FrameRegistrar> {
    inner: &'a R,
    record: Option<R::Record>,
}

impl<'a, R: FrameRegistrar> ReplayRegistrar<'a, R> {
    pub fn new(inner: &'a R) -> ReplayRegistrar<'a, R> {
        ReplayRegistrar {
            inner,
            record: None,
        }
    }

    /// The record the next `register` call replays.
    pub fn set(&mut self, record: R::Record) {
        self.record = Some(record);
    }
}

/// Error of a [`ReplayRegistrar`].
#[derive(Debug, Clone)]
pub struct ReplayError(pub String);

impl fmt::Display for ReplayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl<R: FrameRegistrar> FrameRegistrar for ReplayRegistrar<'_, R> {
    type Record = R::Record;
    type Error = ReplayError;

    fn register(
        &mut self,
        frame: &mut [f32],
        width: usize,
        height: usize,
    ) -> Result<R::Record, ReplayError> {
        let rec = self
            .record
            .take()
            .ok_or_else(|| ReplayError("no motion record for this frame".into()))?;
        self.inner
            .replay(frame, width, height, &rec)
            .map_err(|e| ReplayError(e.to_string()))?;
        Ok(rec)
    }

    fn replay(
        &self,
        frame: &mut [f32],
        width: usize,
        height: usize,
        record: &R::Record,
    ) -> Result<(), ReplayError> {
        self.inner
            .replay(frame, width, height, record)
            .map_err(|e| ReplayError(e.to_string()))
    }

    fn validity(
        &self,
        record: &R::Record,
        src: &crate::motion::SourceMask,
        valid: &mut [u8],
    ) -> Result<bool, ReplayError> {
        self.inner
            .validity(record, src, valid)
            .map_err(|e| ReplayError(e.to_string()))
    }
}

/// Re-extract traces for a span of raw frames.
///
/// * `preprocess`: the preprocessing state saved just before the span's first
///   frame ([`Preprocessor::state`]).
/// * `registrar` + the per-frame records: the motion correction to replay
///   (use [`crate::preprocess::NoRegistration`] with `()` records for none).
/// * `warm_start`: the trace state at the start of the span (from
///   [`TraceEngine::state`]); `None` starts every cell at 0.
/// * `sink` receives each frame's traces in order.
///
/// Returns the trace state after the last frame.
pub fn extract_span<'f, T, R, I, S>(
    library: Arc<Library>,
    solver: SolverConfig,
    preprocess: &PreprocessState,
    registrar: &R,
    frames: I,
    warm_start: Option<&TraceState>,
    mut sink: S,
) -> Result<TraceState, TraceError>
where
    T: RawPixel + 'f,
    R: FrameRegistrar,
    R::Record: 'f,
    I: IntoIterator<Item = (&'f [T], &'f R::Record)>,
    S: FnMut(&FrameTraces),
{
    let mut pre = Preprocessor::from_state(preprocess)?;
    let n_px = pre.dims().pixels();
    if library.dims() != pre.dims() {
        return Err(TraceError::Incompatible(format!(
            "library frame {:?} != preprocessing frame {:?}",
            library.dims(),
            pre.dims()
        )));
    }
    let mut engine = TraceEngine::new(library, solver)?;
    let mut warm = warm_start.cloned().unwrap_or_default();
    warm.next_frame = pre.frames_processed();
    engine.restore(&warm)?;
    let mut replay = ReplayRegistrar::new(registrar);
    let mut buf = vec![0.0f32; n_px];
    let mut out = FrameTraces::default();
    for (raw, rec) in frames {
        check_len("raw frame", n_px, raw.len())?;
        replay.set(rec.clone());
        pre.process(raw, &mut buf, &mut replay)
            .map_err(|e: PreprocessError| TraceError::Preprocess(e))?;
        engine.process_into(&buf, &mut out)?;
        sink(&out);
    }
    Ok(engine.state())
}

/// Extract traces from already-preprocessed frames (the solve alone).
pub fn extract_preprocessed<'f, I, S>(
    library: Arc<Library>,
    solver: SolverConfig,
    frames: I,
    warm_start: Option<&TraceState>,
    mut sink: S,
) -> Result<TraceState, TraceError>
where
    I: IntoIterator<Item = &'f [f32]>,
    S: FnMut(&FrameTraces),
{
    let mut engine = TraceEngine::new(library, solver)?;
    if let Some(w) = warm_start {
        engine.restore(w)?;
    }
    let mut out = FrameTraces::default();
    for f in frames {
        engine.process_into(f, &mut out)?;
        sink(&out);
    }
    Ok(engine.state())
}
