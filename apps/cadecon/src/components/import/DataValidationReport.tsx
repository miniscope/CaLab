import { createEffect, Show, For, type JSX } from 'solid-js';
import { validateTraceData } from '@calab/io';
import type { NumericTypedArray } from '@calab/core';
import {
  parsedData,
  effectiveShape,
  validationResult,
  setValidationResult,
} from '../../lib/data-store.ts';

export function DataValidationReport(): JSX.Element {
  createEffect(() => {
    const data = parsedData();
    const shape = effectiveShape();
    if (!data || !shape) return;

    const arr = data.data;
    if (arr instanceof Float64Array || arr instanceof Float32Array) {
      setValidationResult(validateTraceData(arr, shape));
    } else {
      // For integer types, compute basic stats manually
      let min = Infinity,
        max = -Infinity,
        sum = 0;
      for (let i = 0; i < arr.length; i++) {
        const v = (arr as NumericTypedArray)[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      setValidationResult({
        isValid: true,
        warnings: [],
        errors: [],
        stats: {
          min,
          max,
          mean: arr.length > 0 ? sum / arr.length : NaN,
          nanCount: 0,
          infCount: 0,
          negativeCount: 0,
          totalElements: arr.length,
        },
      });
    }
  });

  return (
    <div class="card">
      <h3 class="card__title">Data Validation</h3>

      <Show when={validationResult()}>
        {(result) => (
          <>
            <Show when={result().errors.length > 0}>
              <For each={result().errors}>
                {(err) => (
                  <div class="error-card">
                    <span class="error-card__icon">!</span>
                    <span>{err.message}</span>
                  </div>
                )}
              </For>
              <p class="text-error" style="margin-top: 8px; font-weight: 600;">
                Data has critical issues that must be resolved.
              </p>
            </Show>

            <Show when={result().warnings.length > 0}>
              <For each={result().warnings}>
                {(warn) => (
                  <div class="warning-card">
                    <span class="warning-card__icon">!</span>
                    <div>
                      <p style="margin: 0; font-weight: 500;">{warn.message}</p>
                      <p class="text-secondary" style="margin: 4px 0 0; font-size: 0.85em;">
                        {warn.details}
                      </p>
                    </div>
                  </div>
                )}
              </For>
              <Show when={result().isValid}>
                <p class="text-warning" style="margin-top: 8px;">
                  Data loaded with {result().warnings.length} warning
                  {result().warnings.length > 1 ? 's' : ''}.
                </p>
              </Show>
            </Show>

            <Show when={result().isValid && result().warnings.length === 0}>
              <p class="text-success" style="font-weight: 600;">
                Data looks good!
              </p>
            </Show>

            <Show when={result().isValid}>
              <div class="stats-grid">
                <div class="stat-item">
                  <span class="stat-item__label">Total Elements</span>
                  <span class="stat-item__value">
                    {result().stats.totalElements.toLocaleString()}
                  </span>
                </div>
                <div class="stat-item">
                  <span class="stat-item__label">Min</span>
                  <span class="stat-item__value">{result().stats.min.toFixed(4)}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-item__label">Max</span>
                  <span class="stat-item__value">{result().stats.max.toFixed(4)}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-item__label">Mean</span>
                  <span class="stat-item__value">
                    {Number.isFinite(result().stats.mean) ? result().stats.mean.toFixed(4) : 'N/A'}
                  </span>
                </div>
                <div class="stat-item">
                  <span class="stat-item__label">NaN Count</span>
                  <span class="stat-item__value">{result().stats.nanCount.toLocaleString()}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-item__label">Inf Count</span>
                  <span class="stat-item__value">{result().stats.infCount.toLocaleString()}</span>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
