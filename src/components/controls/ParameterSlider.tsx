// Reusable parameter slider + numeric input component.
// Supports both linear (tau) and log-scale (lambda) modes
// via optional fromSlider/toSlider transform functions.

import type { Accessor, Setter } from 'solid-js';

export interface ParameterSliderProps {
  label: string;
  value: Accessor<number>;
  setValue: Setter<number>;
  min: number;
  max: number;
  step: number;
  /** Called on final commit (mouse release / blur), not every tick. */
  onCommit?: (value: number) => void;
  /** Transform slider position to display value (for log scale). */
  fromSlider?: (position: number) => number;
  /** Transform display value to slider position (for log scale). */
  toSlider?: (value: number) => number;
  /** Format value for display in the numeric input. */
  format?: (value: number) => string;
  /** Unit label shown after the numeric input. */
  unit?: string;
  /** Tutorial targeting attribute for driver.js tour steps. */
  'data-tutorial'?: string;
}

export function ParameterSlider(props: ParameterSliderProps) {
  // When toSlider is provided, the range input operates in [0, 1] normalized space.
  // Otherwise it uses the raw min/max/step values.
  const sliderValue = () =>
    props.toSlider ? props.toSlider(props.value()) : props.value();

  const displayValue = () =>
    props.format ? props.format(props.value()) : props.value().toString();

  // Range input: live feedback on every tick (triggers reactive solver dispatch)
  const handleRangeInput = (e: Event) => {
    const raw = parseFloat((e.target as HTMLInputElement).value);
    if (isNaN(raw)) return;
    const val = props.fromSlider ? props.fromSlider(raw) : raw;
    props.setValue(val);
  };

  // Range input: commit on mouse release (pushes to undo history)
  const handleRangeChange = (e: Event) => {
    const raw = parseFloat((e.target as HTMLInputElement).value);
    if (isNaN(raw)) return;
    const val = props.fromSlider ? props.fromSlider(raw) : raw;
    props.onCommit?.(val);
  };

  // Numeric input: live feedback with clamping
  const handleNumericInput = (e: Event) => {
    const raw = parseFloat((e.target as HTMLInputElement).value);
    if (isNaN(raw)) return;
    const clamped = Math.max(props.min, Math.min(props.max, raw));
    props.setValue(clamped);
  };

  // Numeric input: commit on blur/enter
  const handleNumericChange = (e: Event) => {
    const raw = parseFloat((e.target as HTMLInputElement).value);
    if (isNaN(raw)) return;
    const clamped = Math.max(props.min, Math.min(props.max, raw));
    props.onCommit?.(clamped);
  };

  return (
    <div class="param-slider" data-tutorial={props['data-tutorial']}>
      <div class="param-slider__header">
        <label class="param-slider__label">{props.label}</label>
        <span class="param-slider__inline-value">
          <input
            type="number"
            class="param-slider__number"
            value={displayValue()}
            min={props.min}
            max={props.max}
            step={props.step}
            onInput={handleNumericInput}
            onChange={handleNumericChange}
          />
          {props.unit && <span class="param-slider__unit">{props.unit}</span>}
        </span>
      </div>
      <input
        type="range"
        class="param-slider__range"
        min={props.toSlider ? 0 : props.min}
        max={props.toSlider ? 1 : props.max}
        step={props.toSlider ? 0.001 : props.step}
        value={sliderValue()}
        onInput={handleRangeInput}
        onChange={handleRangeChange}
      />
    </div>
  );
}
