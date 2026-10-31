// Dev-only solver backend readout, rendered only when the GPU backend was
// requested (`?backend=gpu` or localStorage 'calab:backend' = 'gpu'). Shows the
// active backend, adapter, batch size and throughput, and for the selected
// cell a GPU-vs-WASM check: the GPU's latest converged window re-solved with a
// WASM Solver in a worker (same warm start and strategy, no mid-solve getters).
// At most one reference solve is in flight; while it runs, only the newest
// request is remembered, and stale ones are skipped.

import { Show, createEffect, createSignal, on, onCleanup, type Component } from 'solid-js';
import { selectedCell } from '../../lib/viz-store.ts';
import {
  backendStatus,
  calibrationVerdict,
  compareWithWasm,
  gpuPrepStats,
  gpuResultVersion,
  gpuStats,
  latestGpuResult,
  type BackendComparison,
  type GpuCellRecord,
} from '../../lib/solver-backend.ts';

const COMPARE_DEBOUNCE_MS = 400;

const boxStyle = {
  position: 'fixed',
  right: '8px',
  bottom: '8px',
  'z-index': '1000',
  'max-width': '360px',
  padding: '6px 8px',
  font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
  color: 'var(--text-primary, #222)',
  background: 'var(--bg-primary, #fff)',
  border: '1px solid var(--border-default, #ccc)',
  'border-radius': '4px',
  opacity: '0.92',
  'pointer-events': 'auto',
} as const;

function fmtRate(x: number): string {
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)} G`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)} M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)} k`;
  return x.toFixed(0);
}

export const BackendDevReadout: Component = () => {
  const [cmp, setCmp] = createSignal<BackendComparison | null>(null);
  const [cmpState, setCmpState] = createSignal<string>('waiting for a converged GPU result');
  const [collapsed, setCollapsed] = createSignal(false);
  const [prep, setPrep] = createSignal(gpuPrepStats());
  let lastCompared: GpuCellRecord | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** A reference solve is running in the worker. */
  let running = false;
  /** Cell to compare once the running solve is done (newest request only). */
  let queued: number | null = null;
  let alive = true;

  function runCompare(cell: number): void {
    const rec = latestGpuResult(cell);
    if (!rec) {
      setCmpState(`cell ${cell}: no converged GPU result yet`);
      return;
    }
    if (rec === lastCompared) return;
    if (running) {
      queued = cell; // replaces any older queued request
      setCmpState(`cell ${rec.cellIndex}: queued behind the running WASM reference`);
      return;
    }
    lastCompared = rec;
    running = true;
    setCmpState(`cell ${rec.cellIndex}: running WASM reference...`);
    compareWithWasm(cell)
      .then((c) => {
        if (!alive) return;
        setCmp(c);
        setCmpState('');
        if (c) {
          console.info(
            `[solver-backend] cell ${c.cellIndex}: GPU vs WASM relL2 ${c.relL2.toExponential(2)}, ` +
              `max|d| ${c.maxAbs.toExponential(1)}, iterations GPU ${c.gpuIterations}` +
              `${c.gpuWarmStarted ? ` (${c.warmStrategy})` : ''} / WASM ${c.wasmIterations}`,
          );
        }
      })
      .catch((err) => {
        if (alive) setCmpState(`compare failed: ${String(err)}`);
      })
      .finally(() => {
        running = false;
        setPrep(gpuPrepStats());
        const next = queued;
        queued = null;
        if (alive && next !== null) runCompare(next);
      });
  }

  createEffect(
    on([selectedCell, gpuResultVersion], ([cell]) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setPrep(gpuPrepStats());
        runCompare(cell);
      }, COMPARE_DEBOUNCE_MS);
    }),
  );
  onCleanup(() => {
    alive = false;
    if (timer) clearTimeout(timer);
  });

  return (
    <div style={boxStyle} data-testid="backend-dev-readout">
      <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px' }}>
        <strong>
          solver: {backendStatus().active}
          <Show when={backendStatus().adapter}> ({backendStatus().adapter})</Show>
        </strong>
        <button
          style={{ font: 'inherit', padding: '0 4px', cursor: 'pointer' }}
          onClick={() => setCollapsed((c) => !c)}
          aria-label="Toggle solver readout"
        >
          {collapsed() ? '+' : '-'}
        </button>
      </div>
      <Show when={!collapsed()}>
        <Show when={backendStatus().reason}>
          <div style={{ color: 'var(--color-warning, #a60)' }}>{backendStatus().reason}</div>
        </Show>
        <Show when={gpuStats()}>
          {(s) => (
            <>
              <div>
                gpu {s().state}: {s().cellsLoaded} cells x {s().samplesPerCell} samples
                {s().groups > 1 ? `, ${s().groups} groups` : ''}; read back {s().lastReadbackCells};
                yielded {s().yieldedTiles}; budget {(s().memoryBudgetBytes / 2 ** 20).toFixed(0)}{' '}
                MiB
              </div>
              <div>
                {s().iterationsPerSec.toFixed(0)} it/s, {fmtRate(s().sampleItersPerSec)}
                sample-it/s (quantum {s().lastQuantumIterations} it / {s().lastQuantumMs.toFixed(0)}{' '}
                ms)
              </div>
            </>
          )}
        </Show>
        <Show when={prep()}>
          {(p) => (
            <div>
              prep: {p().computed} traces
              {p().computed > 0 ? `, ${(p().totalMs / p().computed).toFixed(1)} ms avg` : ''};{' '}
              {p().cacheHits} cache hits
            </div>
          )}
        </Show>
        <Show when={backendStatus().wasmWorkers}>
          <div>wasm workers: {backendStatus().wasmWorkers}</div>
        </Show>
        <Show when={calibrationVerdict()}>
          <div style={{ color: 'var(--color-warning, #a60)' }}>
            calibration gate (advisory): {calibrationVerdict()}
          </div>
        </Show>
        <Show when={cmp()}>
          {(c) => (
            <div>
              cell {c().cellIndex} GPU vs WASM: relL2 {c().relL2.toExponential(2)}, max|d|{' '}
              {c().maxAbs.toExponential(1)}; it GPU {c().gpuIterations}
              {c().gpuWarmStarted ? ` (${c().warmStrategy})` : ''} / WASM {c().wasmIterations}
              {c().wasmConverged ? '' : ' (unconverged)'} ({c().wasmMs.toFixed(0)} ms)
            </div>
          )}
        </Show>
        <Show when={cmpState()}>
          <div style={{ opacity: '0.7' }}>{cmpState()}</div>
        </Show>
      </Show>
    </div>
  );
};
