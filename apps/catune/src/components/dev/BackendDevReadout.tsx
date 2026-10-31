// Dev-only solver backend readout, rendered only when the GPU backend was
// requested (`?backend=gpu` or localStorage 'calab:backend' = 'gpu'). Shows the
// active backend, adapter, batch size and throughput, and for the selected
// cell a GPU-vs-WASM check: the GPU's latest converged window re-solved with a
// WASM Solver in a worker (same warm start, no mid-solve getters).

import { Show, createEffect, createSignal, on, onCleanup, type Component } from 'solid-js';
import { selectedCell } from '../../lib/viz-store.ts';
import {
  backendStatus,
  calibrationVerdict,
  compareWithWasm,
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
  let lastCompared: GpuCellRecord | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  createEffect(
    on([selectedCell, gpuResultVersion], ([cell]) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const rec = latestGpuResult(cell);
        if (!rec) {
          setCmpState(`cell ${cell}: no converged GPU result yet`);
          return;
        }
        if (rec === lastCompared) return;
        lastCompared = rec;
        const mine = ++seq;
        setCmpState(`cell ${rec.cellIndex}: running WASM reference...`);
        compareWithWasm(cell)
          .then((c) => {
            if (mine !== seq) return;
            setCmp(c);
            setCmpState('');
            if (c) {
              console.info(
                `[solver-backend] cell ${c.cellIndex}: GPU vs WASM relL2 ${c.relL2.toExponential(2)}, ` +
                  `iterations GPU ${c.gpuIterations}${c.gpuWarmStarted ? ' (warm)' : ''} / WASM ${c.wasmIterations}`,
              );
            }
          })
          .catch((err) => {
            if (mine === seq) setCmpState(`compare failed: ${String(err)}`);
          });
      }, COMPARE_DEBOUNCE_MS);
    }),
  );
  onCleanup(() => {
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
                budget {(s().memoryBudgetBytes / 2 ** 20).toFixed(0)} MiB
              </div>
              <div>
                {s().iterationsPerSec.toFixed(0)} it/s, {fmtRate(s().sampleItersPerSec)}
                sample-it/s (quantum {s().lastQuantumIterations} it / {s().lastQuantumMs.toFixed(0)}{' '}
                ms)
              </div>
            </>
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
              {c().gpuWarmStarted ? ' (warm)' : ''} / WASM {c().wasmIterations}
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
