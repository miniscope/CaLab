/** The real WASM trace solver and QC monitor, as the fast loop builds them. */
import { Preprocessor, QcMonitor, TraceEngine, TraceLibrary } from './cala-wasm.ts';
import type { TraceBackend } from './fast-loop.ts';
import { paramsHandle } from './params-handle.ts';

/** The fast loop's trace backend, built on the WASM solver and QC monitor. */
export const traceBackend: TraceBackend = {
  libraryFromBytes: (bytes) => TraceLibrary.fromBytes(bytes),
  newEngine: (lib, params) => new TraceEngine(lib as TraceLibrary, paramsHandle(params)),
  newQc: (s) => {
    const qc = new QcMonitor(s.width, s.height, s.fov, s.noise, paramsHandle(s.params));
    return {
      raw: qc,
      processFrames: (engine, frames, count) =>
        qc.processFrames(engine as TraceEngine, frames, count),
      processFramesShifted: (engine, frames, count, dy, dx) =>
        qc.processFramesShifted(engine as TraceEngine, frames, count, dy, dx),
      setNoise: (noise) => qc.setNoise(noise),
      cellMetrics: () => qc.cellMetrics(),
      globalMetrics: () => qc.globalMetrics(),
      neighbours: (slot) => qc.neighbours(slot),
      residualMap: () => qc.residualMap(),
      residualMapDims: () => qc.residualMapDims(),
      free: () => qc.free(),
    };
  },
  backAndTrace: (pre, engine, qc, frames, count, dy, dx, refreshQcNoise) => {
    const p = pre as Preprocessor;
    const e = engine as TraceEngine;
    return qc
      ? p.backTraceQcFramesRegistered(
          e,
          (qc as typeof qc & { raw: QcMonitor }).raw,
          frames,
          count,
          dy,
          dx,
          refreshQcNoise,
        )
      : p.backTraceFramesRegistered(e, frames, count, dy, dx);
  },
  qcFields: () => ({ cell: QcMonitor.cellFields(), global: QcMonitor.globalFields() }),
};
