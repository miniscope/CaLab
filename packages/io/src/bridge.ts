/**
 * Bridge utilities for communicating with a local Python calab server.
 *
 * When CaTune is opened with ?bridge=localhost:PORT, it fetches trace data
 * from the Python bridge server and sends exported parameters back.
 */

import { parseNpy } from './npy-parser.ts';
import { processNpyResult } from './array-utils.ts';
import type { NpyResult } from '@calab/core';

export interface BridgeMetadata {
  sampling_rate_hz: number;
  num_cells: number;
  num_timepoints: number;
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
