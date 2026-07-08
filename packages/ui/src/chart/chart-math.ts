// Small chart math helpers shared across apps.

/**
 * Generate "nice" round tick values covering [min, max] with roughly
 * `targetCount` ticks, snapped to 1/2/5 × 10^k steps. Returns ascending values
 * within the range (inclusive of nice endpoints that fall inside it).
 */
export function niceTicks(min: number, max: number, targetCount = 5): number[] {
  if (!isFinite(min) || !isFinite(max) || max <= min || targetCount < 1) {
    return [min];
  }
  const rawStep = (max - min) / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let step: number;
  if (norm < 1.5) step = 1;
  else if (norm < 3) step = 2;
  else if (norm < 7) step = 5;
  else step = 10;
  step *= mag;

  const start = Math.ceil(min / step) * step;
  // Round each tick to the step's decimal precision so labels read cleanly
  // (avoids fp residue like 0.30000000000000004). Steps are 1/2/5 × 10^k.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const pow = Math.pow(10, decimals);
  const round = (x: number) => Math.round(x * pow) / pow;

  const count = Math.floor((max - start) / step + 1e-6);
  const ticks: number[] = [];
  for (let i = 0; i <= count && i < 1000; i++) {
    ticks.push(round(start + i * step));
  }
  return ticks;
}
