/**
 * Bridge effects for CaDecon: config application, progress reporting, and auto-export.
 *
 * - initBridgeConfig(): fetches config from Python, applies to stores, optionally auto-starts
 * - setupBridgeEffects(): registers reactive effects for progress posting and auto-export
 * - isBridgeAutorun(): whether the current session is in autorun mode
 */

import { createEffect, on, createSignal } from 'solid-js';
import { fetchBridgeConfig, postProgressToBridge, exportCaDeconToBridge } from '@calab/io';
import type { BridgeConfig } from '@calab/io';
import {
  setUpsampleTarget,
  setHpFilterEnabled,
  setLpFilterEnabled,
  setMaxIterations,
  setConvergenceTol,
} from './algorithm-store.ts';
import { setNumSubsets, setTargetCoverage, setAspectRatio, setSeed } from './subset-store.ts';
import {
  runState,
  currentIteration,
  progress,
  runPhase,
  currentTauRise,
  currentTauDecay,
} from './iteration-store.ts';
import { maxIterations } from './algorithm-store.ts';
import { bridgeUrl, setBridgeExportDone, bridgeExportDone } from './data-store.ts';
import { startRun } from './iteration-manager.ts';
import { buildCaDeconActivityMatrix, buildCaDeconResultsPayload } from './export-utils.ts';

const [bridgeAutorun, setBridgeAutorun] = createSignal(false);

/** Whether the current session is bridge+autorun (for UI gating). */
export function isBridgeAutorun(): boolean {
  return bridgeAutorun();
}

/** Apply config values from BridgeConfig to the appropriate store signals. */
function applyConfig(config: BridgeConfig): void {
  if (config.upsample_target != null) setUpsampleTarget(config.upsample_target);
  if (config.hp_filter_enabled != null) setHpFilterEnabled(config.hp_filter_enabled);
  if (config.lp_filter_enabled != null) setLpFilterEnabled(config.lp_filter_enabled);
  if (config.max_iterations != null) setMaxIterations(config.max_iterations);
  if (config.convergence_tol != null) setConvergenceTol(config.convergence_tol);
  if (config.num_subsets != null) setNumSubsets(config.num_subsets);
  if (config.target_coverage != null) setTargetCoverage(config.target_coverage);
  if (config.aspect_ratio != null) setAspectRatio(config.aspect_ratio);
  if (config.seed != null) setSeed(config.seed);
}

/**
 * Fetch config from the bridge server, apply it, and optionally start the solver.
 * Must be called after loadFromBridge() has resolved.
 */
export async function initBridgeConfig(url: string): Promise<void> {
  try {
    const config = await fetchBridgeConfig(url);
    applyConfig(config);
    if (config.autorun) {
      setBridgeAutorun(true);
      void startRun();
    }
  } catch {
    // Config endpoint is optional — absence means use defaults
  }
}

/**
 * Build and export CaDecon results to the bridge server.
 * Shared by both auto-export (effect) and manual export (ExportButton).
 */
export async function runBridgeExport(url: string): Promise<void> {
  const { data, shape } = buildCaDeconActivityMatrix();
  const results = buildCaDeconResultsPayload();
  await exportCaDeconToBridge(url, data, shape, results);
  setBridgeExportDone(true);
}

/**
 * Register SolidJS effects for:
 * 1. Progress reporting — throttled POST to bridge every 500ms
 * 2. Auto-export — on run completion in autorun mode
 *
 * Call once during App initialization (outside any Show boundary).
 */
export function setupBridgeEffects(): void {
  // --- Progress effect ---
  let lastProgressTime = 0;

  createEffect(
    on(
      [runState, currentIteration, progress, runPhase, currentTauRise, currentTauDecay],
      ([state, iter, prog, phase, tauR, tauD]) => {
        const url = bridgeUrl();
        if (!url) return;

        const now = Date.now();
        const isTransition = state === 'complete' || state === 'paused';

        // Throttle to 500ms unless it's a state transition
        if (!isTransition && now - lastProgressTime < 500) return;
        lastProgressTime = now;

        postProgressToBridge(url, {
          iteration: iter,
          max_iterations: maxIterations(),
          phase: phase,
          phase_progress: prog,
          tau_rise: tauR,
          tau_decay: tauD,
          status: state,
        });
      },
    ),
  );

  // --- Auto-export effect ---
  createEffect(
    on(runState, (state) => {
      if (state !== 'complete') return;
      if (!bridgeAutorun()) return;
      if (bridgeExportDone()) return;

      const url = bridgeUrl();
      if (!url) return;

      void runBridgeExport(url).catch((err) => console.error('Auto-export failed:', err));
    }),
  );
}
