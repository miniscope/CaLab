/**
 * Bridge utilities for communicating with a local Python calab server.
 *
 * When CaTune is opened with ?bridge=localhost:PORT, it fetches trace data
 * from the Python bridge server and sends exported parameters back.
 */

import { parseNpy } from './npy-parser.ts';
import { writeNpy } from './npy-writer.ts';
import { processNpyResult } from './array-utils.ts';
import type { NpyResult } from '@calab/core';

export interface BridgeMetadata {
  sampling_rate_hz: number;
  num_cells: number;
  num_timepoints: number;
}

/** Configuration from Python's DeconConfig, sent via GET /api/v1/config. */
export interface BridgeConfig {
  autorun: boolean;
  upsample_target?: number;
  hp_filter_enabled?: boolean;
  lp_filter_enabled?: boolean;
  max_iterations?: number;
  convergence_tol?: number;
  num_subsets?: number;
  target_coverage?: number;
  aspect_ratio?: number;
  seed?: number;
}

/** All known keys of BridgeConfig (for cross-language schema tests). */
export const BRIDGE_CONFIG_KEYS: readonly string[] = [
  'autorun',
  'upsample_target',
  'hp_filter_enabled',
  'lp_filter_enabled',
  'max_iterations',
  'convergence_tol',
  'num_subsets',
  'target_coverage',
  'aspect_ratio',
  'seed',
];

/** Progress update POSTed by the browser to the bridge server. */
export interface BridgeProgress {
  iteration: number;
  max_iterations: number;
  phase: string;
  phase_progress: number;
  tau_rise: number | null;
  tau_decay: number | null;
  status: string;
}

/**
 * Read the `?bridge=` URL parameter to get the bridge server base URL.
 * Returns null if not present.
 */
export function getBridgeUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const bridge = params.get('bridge');
  if (!bridge) return null;

  // Ensure it has a protocol prefix
  if (bridge.startsWith('http://') || bridge.startsWith('https://')) {
    return bridge;
  }
  return `http://${bridge}`;
}

/**
 * Fetch trace data and metadata from the bridge server.
 * Returns the parsed NpyResult and metadata.
 */
export async function fetchBridgeData(
  bridgeUrl: string,
): Promise<{ traces: NpyResult; metadata: BridgeMetadata }> {
  // Fetch traces as .npy binary
  const tracesResp = await fetch(`${bridgeUrl}/api/v1/traces`);
  if (!tracesResp.ok) {
    throw new Error(`Bridge: failed to fetch traces (${tracesResp.status})`);
  }
  const tracesBuffer = await tracesResp.arrayBuffer();
  const rawResult = parseNpy(tracesBuffer);
  const traces = processNpyResult(rawResult);

  // Fetch metadata JSON
  const metaResp = await fetch(`${bridgeUrl}/api/v1/metadata`);
  if (!metaResp.ok) {
    throw new Error(`Bridge: failed to fetch metadata (${metaResp.status})`);
  }
  const metadata: BridgeMetadata = await metaResp.json();

  return { traces, metadata };
}

/**
 * POST exported parameters back to the bridge server.
 * This signals to the Python `calab.tune()` call that the user has finished tuning.
 */
export async function postParamsToBridge(bridgeUrl: string, exportData: unknown): Promise<void> {
  stopBridgeHeartbeat();
  const resp = await fetch(`${bridgeUrl}/api/v1/params`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(exportData),
  });
  if (!resp.ok) {
    throw new Error(`Bridge: failed to post params (${resp.status})`);
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** Begin sending periodic heartbeat POSTs to the bridge server. */
export function startBridgeHeartbeat(bridgeUrl: string, intervalMs = 3000): void {
  stopBridgeHeartbeat();
  heartbeatTimer = setInterval(() => {
    fetch(`${bridgeUrl}/api/v1/heartbeat`, { method: 'POST' }).catch(() => {
      stopBridgeHeartbeat();
    });
  }, intervalMs);
}

/** Stop the heartbeat interval if one is running. */
export function stopBridgeHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * POST the activity matrix as .npy binary to the bridge server.
 * Used by CaDecon to send the large activity array before the JSON results.
 */
export async function postActivityToBridge(
  bridgeUrl: string,
  activity: Float32Array,
  shape: [number, number],
): Promise<void> {
  const npyBuffer = writeNpy(activity, shape);
  const resp = await fetch(`${bridgeUrl}/api/v1/results/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: npyBuffer,
  });
  if (!resp.ok) {
    throw new Error(`Bridge: failed to post activity (${resp.status})`);
  }
}

/**
 * POST the results JSON (scalars + metadata) to the bridge server.
 * This acts as the "done" signal for the two-POST CaDecon export.
 */
export async function postResultsToBridge(
  bridgeUrl: string,
  results: Record<string, unknown>,
): Promise<void> {
  const resp = await fetch(`${bridgeUrl}/api/v1/results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results),
  });
  if (!resp.ok) {
    throw new Error(`Bridge: failed to post results (${resp.status})`);
  }
}

/**
 * Export CaDecon results to the bridge server.
 * Sequences: activity POST first (large binary), then results POST (small JSON, triggers done).
 * Stops the heartbeat after both succeed.
 */
export async function exportCaDeconToBridge(
  bridgeUrl: string,
  activity: Float32Array,
  shape: [number, number],
  results: Record<string, unknown>,
): Promise<void> {
  await postActivityToBridge(bridgeUrl, activity, shape);
  await postResultsToBridge(bridgeUrl, results);
  stopBridgeHeartbeat();
}

/**
 * Fetch configuration from the Python bridge server.
 * Returns the parsed BridgeConfig (autorun + optional algorithm overrides).
 */
export async function fetchBridgeConfig(bridgeUrl: string): Promise<BridgeConfig> {
  const resp = await fetch(`${bridgeUrl}/api/v1/config`);
  if (!resp.ok) {
    throw new Error(`Bridge: failed to fetch config (${resp.status})`);
  }
  return resp.json() as Promise<BridgeConfig>;
}

/**
 * POST a progress update to the bridge server (fire-and-forget).
 * Errors are silently swallowed — progress is informational, not critical.
 */
export function postProgressToBridge(bridgeUrl: string, progress: BridgeProgress): void {
  fetch(`${bridgeUrl}/api/v1/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(progress),
  }).catch(() => {});
}
