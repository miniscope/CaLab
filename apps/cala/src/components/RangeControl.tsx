import { createSignal, untrack, type JSX } from 'solid-js';
import { RangeHold, type DisplayPixels, type DisplayRange } from '../lib/frame-display.ts';

/** Display range held for one panel; see `RangeHold`. */
export interface HeldRange {
  /** Range now in use (reactive); null before the first image. */
  range: () => DisplayRange | null;
  /** Bumps on a manual change or re-fit so the panel redraws. */
  revision: () => number;
  /** Feed a new image; returns the range to draw it with. */
  observe: (pixels: DisplayPixels) => DisplayRange | null;
  reset: () => void;
  setManual: (r: DisplayRange) => void;
  refit: () => void;
}

export function createHeldRange(): HeldRange {
  const hold = new RangeHold();
  const [range, setRange] = createSignal<DisplayRange | null>(null);
  const [revision, setRevision] = createSignal(0);
  const changed = () => {
    setRange(hold.range);
    setRevision((v) => v + 1);
  };
  return {
    range,
    revision,
    observe: (pixels) => {
      const r = hold.observe(pixels);
      const cur = untrack(range);
      if (r?.lo !== cur?.lo || r?.hi !== cur?.hi) setRange(r);
      return r;
    },
    reset: () => {
      if (hold.range === null) return;
      hold.reset();
      setRange(null);
    },
    setManual: (r) => {
      hold.setManual(r);
      changed();
    },
    refit: () => {
      hold.refit();
      changed();
    },
  };
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(3));

/** Small lo/hi inputs and a re-fit button for one panel's held display range. */
export function RangeControl(props: { held: HeldRange; label: string }): JSX.Element {
  const commit = (which: 'lo' | 'hi', text: string) => {
    const r = props.held.range();
    const v = Number(text);
    if (!r || !Number.isFinite(v) || text.trim() === '') return;
    props.held.setManual({ ...r, [which]: v });
  };
  return (
    <span class="cala-range" data-testid="range-control">
      <input
        type="number"
        step="any"
        class="cala-range__input"
        aria-label={`${props.label} display minimum`}
        data-testid="range-lo"
        value={props.held.range() ? fmt(props.held.range()!.lo) : ''}
        onChange={(e) => commit('lo', e.currentTarget.value)}
      />
      <span aria-hidden="true">&ndash;</span>
      <input
        type="number"
        step="any"
        class="cala-range__input"
        aria-label={`${props.label} display maximum`}
        data-testid="range-hi"
        value={props.held.range() ? fmt(props.held.range()!.hi) : ''}
        onChange={(e) => commit('hi', e.currentTarget.value)}
      />
      <button
        type="button"
        class="btn-secondary btn-small"
        data-testid="range-refit"
        title="Fixed display range (never auto-adjusts; values outside clip). Re-fit once from the most recent frames."
        onClick={() => props.held.refit()}
      >
        Re-fit range
      </button>
    </span>
  );
}
