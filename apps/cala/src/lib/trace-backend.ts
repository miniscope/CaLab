/** The real WASM trace solver and QC monitor, as the fast loop builds them. */
import { QcMonitor, TraceEngine, TraceLibrary } from './cala-wasm.ts';
import type { TraceBackend } from './fast-loop.ts';

export const traceBackend: TraceBackend = {
  libraryFromBytes: (bytes) => TraceLibrary.fromBytes(bytes),
  // 0, 0: the solver's default tolerance and sweep cap.
  newEngine: (lib) => new TraceEngine(lib as TraceLibrary, 0, 0),
  // 0: the default trace window (one minute).
  newQc: (s) => {
    const qc = new QcMonitor(s.width, s.height, s.fov, s.noise, s.fps, 0);
    return {
      processFrames: (engine, frames, count) =>
        qc.processFrames(engine as TraceEngine, frames, count),
      setNoise: (noise) => qc.setNoise(noise),
      cellMetrics: () => qc.cellMetrics(),
      globalMetrics: () => qc.globalMetrics(),
      neighbours: (slot) => qc.neighbours(slot),
      residualMap: () => qc.residualMap(),
      residualMapDims: () => qc.residualMapDims(),
      free: () => qc.free(),
    };
  },
  qcFields: () => ({ cell: QcMonitor.cellFields(), global: QcMonitor.globalFields() }),
};
