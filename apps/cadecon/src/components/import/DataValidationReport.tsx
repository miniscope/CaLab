// DataValidationReport - Validation warnings and errors display
// Runs validation automatically when shown, displays results

import { createEffect, Show, For } from 'solid-js';
import { validateTraceData } from '@calab/io';
import type { NumericTypedArray } from '@calab/core';
import {
  parsedData,
  effectiveShape,
  validationResult,
  setValidationResult,
} from '../../lib/data-store.ts';

export function DataValidationReport() {
  // Run validation automatically when component mounts / data changes
  createEffect(() => {
    const data = parsedData();
    const shape = effectiveShape();
    if (!data || !shape) return;

    // validateTraceData expects Float64Array | Float32Array
    // For integer typed arrays, we skip validation (they are valid but uncommon)
    const arr = data.data;
    if (arr instanceof Float64Array || arr instanceof Float32Array) {
      const result = validateTraceData(arr, shape);
      setValidationResult(result);
    } else {
      // For integer types, create a basic valid result
      const totalElements = arr.length;
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
          totalElements,
        },
      });
    }
  });

  const result = () => validationResult();

  return (
    <div class="card">
      <h3 class="card__title">Data Validation</h3>

      <Show when={result()}>
        {/* Errors */}
        <Show when={result()!.errors.length > 0}>
          <For each={result()!.errors}>
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

        {/* Warnings */}
        <Show when={result()!.warnings.length > 0}>
          <For each={result()!.warnings}>
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
          <Show when={result()!.isValid}>
            <p class="text-warning" style="margin-top: 8px;">
              Data loaded with {result()!.warnings.length} warning
              {result()!.warnings.length > 1 ? 's' : ''}.
            </p>
          </Show>
        </Show>

        {/* Success */}
        <Show when={result()!.isValid && result()!.warnings.length === 0}>
          <p class="text-success" style="font-weight: 600;">
            Data looks good!
          </p>
        </Show>

        {/* Stats summary */}
        <Show when={result()!.isValid}>
          <div class="stats-grid">
            <div class="stat-item">
              <span class="stat-item__label">Total Elements</span>
              <span class="stat-item__value">{result()!.stats.totalElements.toLocaleString()}</span>
            </div>
            <div class="stat-item">
              <span class="stat-item__label">Min</span>
              <span class="stat-item__value">{result()!.stats.min.toFixed(4)}</span>
            </div>
            <div class="stat-item">
              <span class="stat-item__label">Max</span>
              <span class="stat-item__value">{result()!.stats.max.toFixed(4)}</span>
            </div>
            <div class="stat-item">
              <span class="stat-item__label">Mean</span>
              <span class="stat-item__value">
                {Number.isFinite(result()!.stats.mean) ? result()!.stats.mean.toFixed(4) : 'N/A'}
              </span>
            </div>
            <div class="stat-item">
              <span class="stat-item__label">NaN Count</span>
              <span class="stat-item__value">{result()!.stats.nanCount.toLocaleString()}</span>
            </div>
            <div class="stat-item">
              <span class="stat-item__label">Inf Count</span>
              <span class="stat-item__value">{result()!.stats.infCount.toLocaleString()}</span>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}
