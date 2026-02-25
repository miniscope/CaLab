// Reusable parameter slider + numeric input component.
// Supports both linear and log-scale modes via optional
// fromSlider/toSlider transform functions.

import { Show } from 'solid-js';
import type { Accessor } from 'solid-js';

export interface ParameterSliderProps {
  label: string;
  value: Accessor<number>;
  setValue: (value: number) => void;
  min: number;
  max: number;
  step: number;
  onCommit?: (value: number) => void;
  fromSlider?: (position: number) => number;
  toSlider?: (value: number) => number;
  format?: (value: number) => string;
  unit?: string;
  trueValue?: number;
}

export function ParameterSlider(props: ParameterSliderProps) {
  const sliderValue = () => (props.toSlider ? props.toSlider(props.value()) : props.value());

  const displayValue = () =>
    props.format ? props.format(props.value()) : props.value().toString();

  const handleRangeInput = (e: Event) => {
    const raw = parseFloat((e.target as HTMLInputElement).value);
    if (isNaN(raw)) return;
    const val = props.fromSlider ? props.fromSlider(raw) : raw;
    props.setValue(val);
  };

  const handleRangeChange = (e: Event) => {
    const raw = parseFloat((e.target as HTMLInputElement).value);
    if (isNaN(raw)) return;
    const val = props.fromSlider ? props.fromSlider(raw) : raw;
    props.onCommit?.(val);
  };

  const handleNumericInput = (e: Event) => {
    const raw = parseFloat((e.target as HTMLInputElement).value);
    if (isNaN(raw)) return;
    const clamped = Math.max(props.min, Math.min(props.max, raw));
    props.setValue(clamped);
  };

  const handleNumericChange = (e: Event) => {
    const raw = parseFloat((e.target as HTMLInputElement).value);
    if (isNaN(raw)) return;
    const clamped = Math.max(props.min, Math.min(props.max, raw));
    props.onCommit?.(clamped);
  };

  return (
    <div class="param-slider">
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
          <span class="param-slider__unit">{props.unit ?? ''}</span>
        </span>
      </div>
      <div class="param-slider__track-container">
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
        <Show when={props.trueValue !== undefined}>
          {(() => {
            const sliderMin = props.toSlider ? 0 : props.min;
            const sliderMax = props.toSlider ? 1 : props.max;
            const mappedValue = props.toSlider
              ? props.toSlider(props.trueValue!)
              : props.trueValue!;
            const pct = ((mappedValue - sliderMin) / (sliderMax - sliderMin)) * 100;
            const formattedValue = props.format
              ? props.format(props.trueValue!)
              : props.trueValue!.toString();
            return (
              <div
                class="param-slider__true-marker"
                style={{ left: `${pct}%` }}
                title={`True value: ${formattedValue}${props.unit ? ' ' + props.unit : ''}`}
              />
            );
          })()}
        </Show>
      </div>
    </div>
  );
}
