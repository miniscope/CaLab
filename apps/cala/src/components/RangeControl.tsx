import { createSignal, untrack, type JSX } from 'solid-js';
import { Icon } from '@calab/ui';
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

export function createHeldRange(headroom = 1): HeldRange {
  const hold = new RangeHold(undefined, headroom);
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

/**
 * One panel's held display range as a colour bar: the grey ramp the image is drawn with, its
 * end values as editable figures (type a value to set that end), and a re-fit icon. The range
 * changes only by those two edits or the re-fit click, never by itself.
 */
export function RangeControl(props: { held: HeldRange; label: string }): JSX.Element {
  const commit = (which: 'lo' | 'hi', text: string) => {
    const r = props.held.range();
    const v = Number(text);
    if (!r || !Number.isFinite(v) || text.trim() === '') return;
    props.held.setManual({ ...r, [which]: v });
  };
  return (
    <span
      class="cala-range"
      data-testid="range-control"
      title="Fixed display range: values outside it clip, and it never adjusts by itself. Type an end value to change it."
    >
      <input
        type="number"
        step="any"
        class="cala-range__input num"
        aria-label={`${props.label} display minimum`}
        data-testid="range-lo"
        value={props.held.range() ? fmt(props.held.range()!.lo) : ''}
        onChange={(e) => commit('lo', e.currentTarget.value)}
      />
      <span class="cala-range__bar" aria-hidden="true" data-testid="range-bar" />
      <input
        type="number"
        step="any"
        class="cala-range__input num"
        aria-label={`${props.label} display maximum`}
        data-testid="range-hi"
        value={props.held.range() ? fmt(props.held.range()!.hi) : ''}
        onChange={(e) => commit('hi', e.currentTarget.value)}
      />
      <button
        type="button"
        class="cala-icon-btn cala-range__refit"
        data-testid="range-refit"
        aria-label={`Re-fit the ${props.label} range`}
        title="Re-fit the display range once, from the most recent frames"
        onClick={() => props.held.refit()}
      >
        <Icon name="fit" size={14} />
      </button>
    </span>
  );
}
