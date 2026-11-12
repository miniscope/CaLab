// Shared time-window store for the cala Run panel and History tab.

import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';

export type TimeWindowMode = 'run' | 'last' | 'brush';

export interface TimeWindowState {
  mode: TimeWindowMode;
  /** `last` mode: window length, s (follows now). */
  lastS?: number;
  /** `brush` mode: fixed window in stream time, s. */
  t0?: number;
  t1?: number;
}

export interface TimeWindow {
  state: TimeWindowState;
  /**
   * Resolve to a concrete span. `end` is now (stream s); `runEnd` is the end of the run:
   * the recording end for a file, or now for a live run.
   */
  resolve(end: number, runEnd: number): { t0: number; t1: number };
  setRun(): void;
  setLast(lastS: number): void;
  setBrush(t0: number, t1: number): void;
  /** Inspected stream time (a click pins it), or null. */
  inspected: () => number | null;
  setInspected(t: number | null): void;
  clearInspected(): void;
}

export function createTimeWindow(initial: TimeWindowState = { mode: 'run' }): TimeWindow {
  const [state, setState] = createStore<TimeWindowState>({ ...initial });
  const [inspected, setInspectedSignal] = createSignal<number | null>(null);
  return {
    state,
    resolve(end, runEnd) {
      if (state.mode === 'last' && state.lastS !== undefined) {
        return { t0: Math.max(0, end - state.lastS), t1: end };
      }
      if (state.mode === 'brush' && state.t0 !== undefined && state.t1 !== undefined) {
        return { t0: state.t0, t1: state.t1 };
      }
      return { t0: 0, t1: Math.max(runEnd, 1e-6) };
    },
    setRun() {
      setState({ mode: 'run', lastS: undefined, t0: undefined, t1: undefined });
    },
    setLast(lastS) {
      setState({ mode: 'last', lastS, t0: undefined, t1: undefined });
    },
    setBrush(a, b) {
      setState({ mode: 'brush', lastS: undefined, t0: Math.min(a, b), t1: Math.max(a, b) });
    },
    inspected,
    setInspected: (t) => setInspectedSignal(t),
    clearInspected: () => setInspectedSignal(null),
  };
}

export interface WindowPreset {
  id: string;
  label: string;
  /** Window length, s. */
  s: number;
}

const PRESETS: WindowPreset[] = [
  { id: '24h', label: '24 h', s: 24 * 3600 },
  { id: '1h', label: '1 h', s: 3600 },
  { id: '10min', label: '10 min', s: 600 },
  { id: '1min', label: '1 min', s: 60 },
];

/** Presets shorter than the run (a 5-min file offers only 1 min). */
export function windowPresets(runEndS: number): WindowPreset[] {
  return PRESETS.filter((p) => p.s < runEndS);
}
