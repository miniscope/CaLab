import type { JSX, Accessor } from 'solid-js';

interface DualRangeSliderProps {
  label: string;
  lowLabel: string;
  highLabel: string;
  lowValue: Accessor<number>;
  highValue: Accessor<number>;
  setLowValue: (v: number) => void;
  setHighValue: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  unit?: string;
  disabled?: boolean;
}

function parseInput(e: Event): number | null {
  const raw = parseFloat((e.target as HTMLInputElement).value);
  return isNaN(raw) ? null : raw;
}

export function DualRangeSlider(props: DualRangeSliderProps): JSX.Element {
  const fmt = (v: number) => (props.format ? props.format(v) : v.toString());

  const lowPct = () => ((props.lowValue() - props.min) / (props.max - props.min)) * 100;
  const highPct = () => ((props.highValue() - props.min) / (props.max - props.min)) * 100;

  function handleLowRange(e: Event) {
    const raw = parseInput(e);
    if (raw === null) return;
    // Clamp: can't exceed high value
    props.setLowValue(Math.min(raw, props.highValue() - props.step));
  }

  function handleHighRange(e: Event) {
    const raw = parseInput(e);
    if (raw === null) return;
    // Clamp: can't go below low value
    props.setHighValue(Math.max(raw, props.lowValue() + props.step));
  }

  function handleLowNumber(e: Event) {
    const raw = parseInput(e);
    if (raw === null) return;
    const clamped = Math.max(props.min, Math.min(props.highValue() - props.step, raw));
    props.setLowValue(clamped);
  }

  function handleHighNumber(e: Event) {
    const raw = parseInput(e);
    if (raw === null) return;
    const clamped = Math.min(props.max, Math.max(props.lowValue() + props.step, raw));
    props.setHighValue(clamped);
  }

  return (
    <div class="dual-range" classList={{ 'dual-range--disabled': !!props.disabled }}>
      <div class="dual-range__header">
        <span class="param-slider__label">{props.label}</span>
      </div>
      <div class="dual-range__values">
        <label class="dual-range__field">
          <span class="dual-range__field-label">{props.lowLabel}</span>
          <input
            type="number"
            class="param-slider__number"
            value={fmt(props.lowValue())}
            min={props.min}
            max={props.highValue() - props.step}
            step={props.step}
            disabled={props.disabled}
            onInput={handleLowNumber}
          />
          <span class="param-slider__unit">{props.unit ?? ''}</span>
        </label>
        <label class="dual-range__field">
          <span class="dual-range__field-label">{props.highLabel}</span>
          <input
            type="number"
            class="param-slider__number"
            value={fmt(props.highValue())}
            min={props.lowValue() + props.step}
            max={props.max}
            step={props.step}
            disabled={props.disabled}
            onInput={handleHighNumber}
          />
          <span class="param-slider__unit">{props.unit ?? ''}</span>
        </label>
      </div>
      <div class="dual-range__track">
        <div
          class="dual-range__fill"
          style={{ left: `${lowPct()}%`, width: `${highPct() - lowPct()}%` }}
        />
        <input
          type="range"
          class="dual-range__input dual-range__input--low"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.lowValue()}
          disabled={props.disabled}
          onInput={handleLowRange}
        />
        <input
          type="range"
          class="dual-range__input dual-range__input--high"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.highValue()}
          disabled={props.disabled}
          onInput={handleHighRange}
        />
      </div>
    </div>
  );
}
