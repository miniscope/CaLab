/**
 * Shared simulation configuration component for CaTune and CaDecon.
 *
 * Renders an indicator dropdown, segmented buttons for single-value steps,
 * and dual-thumb range sliders for per-cell variation steps.
 */

import { For, createMemo } from 'solid-js';
import type { QualitativeSimConfig } from '@calab/compute';
import {
  INDICATOR_OPTIONS,
  SPIKE_ACTIVITY_LEVELS,
  NOISE_LEVELS,
  DRIFT_LEVELS,
  PHOTOBLEACHING_LEVELS,
  SATURATION_LEVELS,
  AMPLITUDE_VARIATION_LEVELS,
  KERNEL_VARIATION_LEVELS,
} from '@calab/compute';
import './styles/simulation-configurator.css';

export interface SimulationConfiguratorProps {
  config: QualitativeSimConfig;
  onChange: (config: QualitativeSimConfig) => void;
}

// ── Dual-thumb range slider row (per-cell variation) ─────────────

function RangeSliderRow(props: {
  label: string;
  ticks: readonly { id: string; label: string }[];
  range: [number, number];
  onChange: (range: [number, number]) => void;
}) {
  const maxIdx = createMemo(() => props.ticks.length - 1);

  const handleThumbDown = (thumb: 'low' | 'high', e: PointerEvent) => {
    const track = (e.currentTarget as HTMLElement).parentElement!;
    track.setPointerCapture(e.pointerId);

    const moveHandler = (me: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
      const idx = Math.round(pct * maxIdx());
      const [lo, hi] = props.range;
      if (thumb === 'low') {
        props.onChange([Math.min(idx, hi), hi]);
      } else {
        props.onChange([lo, Math.max(idx, lo)]);
      }
    };

    const upHandler = () => {
      track.removeEventListener('pointermove', moveHandler);
      track.removeEventListener('pointerup', upHandler);
    };

    track.addEventListener('pointermove', moveHandler);
    track.addEventListener('pointerup', upHandler);
    moveHandler(e); // snap immediately
  };

  const handleTrackClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('range-slider__thumb')) return;
    const track = e.currentTarget as HTMLElement;
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const idx = Math.round(pct * maxIdx());
    const [lo, hi] = props.range;
    const mid = (lo + hi) / 2;
    if (idx <= mid) {
      props.onChange([idx, hi]);
    } else {
      props.onChange([lo, idx]);
    }
  };

  return (
    <div class="sim-configurator__row">
      <label class="sim-configurator__label">{props.label}</label>
      <div class="range-slider" onClick={handleTrackClick}>
        <div class="range-slider__track" />
        <div
          class="range-slider__fill"
          style={{
            left: `${(props.range[0] / maxIdx()) * 100}%`,
            width: `${((props.range[1] - props.range[0]) / maxIdx()) * 100}%`,
          }}
        />
        <div
          class="range-slider__thumb"
          style={{ left: `${(props.range[0] / maxIdx()) * 100}%` }}
          onPointerDown={(e) => handleThumbDown('low', e)}
        />
        <div
          class="range-slider__thumb"
          style={{ left: `${(props.range[1] / maxIdx()) * 100}%` }}
          onPointerDown={(e) => handleThumbDown('high', e)}
        />
        <div class="range-slider__ticks">
          <For each={[...props.ticks]}>
            {(tick, i) => (
              <span
                class={`range-slider__tick-label${i() >= props.range[0] && i() <= props.range[1] ? ' range-slider__tick-label--active' : ''}`}
                style={{ left: `${(i() / maxIdx()) * 100}%` }}
              >
                {tick.label}
              </span>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────

export function SimulationConfigurator(props: SimulationConfiguratorProps) {
  const update = <K extends keyof QualitativeSimConfig>(key: K, value: QualitativeSimConfig[K]) => {
    props.onChange({ ...props.config, [key]: value });
  };

  return (
    <div class="sim-configurator">
      {/* Indicator dropdown */}
      <div class="sim-configurator__row">
        <label class="sim-configurator__label">Indicator</label>
        <select
          class="sim-configurator__select"
          value={props.config.indicator}
          onChange={(e) =>
            update('indicator', e.currentTarget.value as QualitativeSimConfig['indicator'])
          }
        >
          <For each={[...INDICATOR_OPTIONS]}>
            {(opt) => <option value={opt.id}>{opt.label}</option>}
          </For>
        </select>
      </div>

      {/* All steps: dual-thumb range sliders */}
      <RangeSliderRow
        label="Spikes"
        ticks={SPIKE_ACTIVITY_LEVELS}
        range={props.config.spikeActivity}
        onChange={(v) => update('spikeActivity', v)}
      />
      <RangeSliderRow
        label="Noise"
        ticks={NOISE_LEVELS}
        range={props.config.noise}
        onChange={(v) => update('noise', v)}
      />
      <RangeSliderRow
        label="Drift"
        ticks={DRIFT_LEVELS}
        range={props.config.drift}
        onChange={(v) => update('drift', v)}
      />
      <RangeSliderRow
        label="Bleaching"
        ticks={PHOTOBLEACHING_LEVELS}
        range={props.config.photobleaching}
        onChange={(v) => update('photobleaching', v)}
      />
      <RangeSliderRow
        label="Saturation"
        ticks={SATURATION_LEVELS}
        range={props.config.saturation}
        onChange={(v) => update('saturation', v)}
      />
      <RangeSliderRow
        label="Amp. Var."
        ticks={AMPLITUDE_VARIATION_LEVELS}
        range={props.config.amplitudeVariation}
        onChange={(v) => update('amplitudeVariation', v)}
      />
      <RangeSliderRow
        label="Kernel Var."
        ticks={KERNEL_VARIATION_LEVELS}
        range={props.config.kernelVariation}
        onChange={(v) => update('kernelVariation', v)}
      />
    </div>
  );
}
