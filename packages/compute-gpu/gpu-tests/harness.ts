import type { Page } from '@playwright/test';

export interface PerCell {
  maxAbs: number;
  relL2: number;
  wasmIters: number;
  gpuIters: number;
  wasmConverged: boolean;
  gpuConverged: boolean;
}

export interface CaseResult {
  name: string;
  nCells: number;
  T: number;
  perCell: PerCell[];
  worstRelL2: number;
  worstMaxAbs: number;
  worstIterRelDiff: number;
}

export interface HarnessResult {
  adapter: string;
  equivalence?: CaseResult[];
  bench?: unknown[];
  benchTable?: string;
  grouping?: unknown;
  full?: unknown;
  warm?: unknown;
}

/** Open the harness in `mode`, wait for it to finish, return its result. */
export async function runHarness(
  page: Page,
  mode: 'equiv' | 'bench' | 'groups' | 'full' | 'warm',
): Promise<HarnessResult> {
  page.on('console', (msg) => {
    const text = msg.text();
    if (!text.startsWith('GPU-SPIKE-RESULT {')) console.log(text);
  });
  await page.goto(`/?mode=${mode}`);
  await page.waitForFunction(
    () => window.__gpuSpike && window.__gpuSpike.status !== 'running',
    null,
    {
      timeout: 19 * 60_000,
      polling: 1000,
    },
  );
  const state = await page.evaluate(() => window.__gpuSpike!);
  if (state.status !== 'done') throw new Error(`harness failed: ${state.error}`);
  return state.result as HarnessResult;
}
