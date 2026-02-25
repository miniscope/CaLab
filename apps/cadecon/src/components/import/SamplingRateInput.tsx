import { createSignal, Show, For, type JSX } from 'solid-js';
import { SAMPLING_RATE_PRESETS } from '@calab/core';
import { numTimepoints, setSamplingRate } from '../../lib/data-store.ts';

export function SamplingRateInput(): JSX.Element {
  const [selectedRate, setSelectedRate] = createSignal<number | null>(null);
  const [customValue, setCustomValue] = createSignal<string>('');

  const duration = () => {
    const rate = selectedRate();
    const tp = numTimepoints();
    if (!rate || rate <= 0 || !tp) return null;
    return tp / rate;
  };

  const durationDisplay = () => {
    const d = duration();
    if (d === null) return null;
    const minutes = d / 60;
    if (minutes >= 1) {
      return `${d.toFixed(1)} seconds (${minutes.toFixed(1)} min)`;
    }
    return `${d.toFixed(1)} seconds`;
  };

  const handlePreset = (value: number) => {
    setSelectedRate(value);
    setCustomValue(String(value));
  };

  const handleCustomInput = (e: Event) => {
    const val = (e.target as HTMLInputElement).value;
    setCustomValue(val);
    const num = parseFloat(val);
    setSelectedRate(!isNaN(num) && num > 0 ? num : null);
  };

  const handleConfirm = () => {
    const rate = selectedRate();
    if (rate && rate > 0) {
      setSamplingRate(rate);
    }
  };

  return (
    <div class="card">
      <h3 class="card__title">Set Sampling Rate</h3>
      <p class="text-secondary">
        Select a preset or enter a custom sampling rate. This is required for correct deconvolution.
      </p>

      <div class="preset-buttons">
        <For each={[...SAMPLING_RATE_PRESETS]}>
          {(preset) => (
            <button
              class={`btn-preset ${selectedRate() === preset.value ? 'btn-preset--active' : ''}`}
              onClick={() => handlePreset(preset.value)}
            >
              {preset.label}
            </button>
          )}
        </For>
      </div>

      <div class="custom-rate-input">
        <label class="custom-rate-input__label">
          Custom rate (Hz):
          <input
            type="number"
            min="1"
            step="0.1"
            class="custom-rate-input__field"
            value={customValue()}
            onInput={handleCustomInput}
            placeholder="Enter Hz"
          />
        </label>
      </div>

      <Show when={selectedRate() && durationDisplay()}>
        <div class="duration-display">
          <p>
            At <strong>{selectedRate()} Hz</strong>, this recording is{' '}
            <strong>{durationDisplay()}</strong>
          </p>
          <p class="text-secondary" style="font-size: 0.85em; margin-top: 4px;">
            If this duration does not match your recording, the sampling rate may be incorrect.
          </p>
        </div>
      </Show>

      <div class="dimension-actions">
        <button
          class="btn-primary"
          disabled={!selectedRate() || selectedRate()! <= 0}
          onClick={handleConfirm}
        >
          Confirm
        </button>
      </div>
    </div>
  );
}
