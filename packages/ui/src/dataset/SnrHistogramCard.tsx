/**
 * Card (a): per-cell measured SNR on a log axis, bars coloured by their
 * quantile within the dataset (the same colours as the raster's SNR strip),
 * pure-noise band shaded, brushable.
 */

import { createMemo, Show, type JSX } from 'solid-js';
import { viridisCss } from '../chart/colormap.ts';
import { BrushHistogram, type HistogramMarker } from './BrushHistogram.tsx';
import { OverviewCard } from './OverviewCard.tsx';
import { formatTick } from './chart-scales.ts';

export interface SnrHistogramCardProps {
  /** SNR of every cell, indexed by cell id. */
  snr: () => readonly number[];
  /** ν per cell; pass only when the data were declared ΔF/F. */
  nu?: () => readonly (number | null)[] | null;
  /** Pure-noise SNR and the upper edge of its band. */
  noiseFloor: { value: number; hi: number };
  silentCount?: () => number;
  /** Event separation used by the silent test (s), for the help text. */
  eventSeparationS?: number;
  highlighted?: () => ReadonlySet<number> | null;
  selected?: () => number | null;
  onBrush?: (ids: number[] | null) => void;
}

/** Shared SNR axis domain (log): from just below the noise floor to above the max. */
export function snrDomain(values: readonly number[], floor: number): [number, number] {
  let hi = 0;
  for (const v of values) if (Number.isFinite(v) && v > hi) hi = v;
  return [Math.min(floor * 0.8, 2), Math.max(hi * 1.15, floor * 4)];
}

function medianFinite(values: readonly (number | null)[]): number {
  const v = values
    .filter((x): x is number => x != null && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function SnrHistogramCard(props: SnrHistogramCardProps): JSX.Element {
  const domain = createMemo(() => snrDomain(props.snr(), props.noiseFloor.value));
  const sorted = createMemo(() =>
    props
      .snr()
      .filter((v) => Number.isFinite(v))
      .slice()
      .sort((a, b) => a - b),
  );
  const median = createMemo(() => medianFinite(props.snr()));
  const nuMedian = createMemo(() => {
    const nu = props.nu?.();
    return nu ? medianFinite(nu) : NaN;
  });

  /** Bar colour = viridis at the fraction of cells below the bin centre. */
  const rankOf = (v: number) => {
    const s = sorted();
    if (s.length < 2) return 0.5;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo / s.length;
  };

  const markers = (): HistogramMarker[] => {
    const out: HistogramMarker[] = [];
    if (Number.isFinite(median())) out.push({ x: median(), label: 'median', dashed: true });
    const sel = props.selected?.();
    if (sel != null) {
      const v = props.snr()[sel];
      if (Number.isFinite(v)) out.push({ x: v, label: `#${sel}`, color: 'var(--error)' });
    }
    return out;
  };

  return (
    <OverviewCard
      title="SNR per cell"
      data-testid="overview-snr"
      help={
        <>
          <p>
            Measured SNR: mean of the top 1 % of samples above the median, over the
            MAD-of-differences noise σ. It reads the strongest transients, so it compares cells that
            share a burst-size distribution (one cell type, one dataset). It is not an absolute
            grade, so bars are coloured by their quantile within this dataset.
          </p>
          <p>
            Pure noise measures about {props.noiseFloor.value} (shaded band up to{' '}
            {props.noiseFloor.hi}). "Silent" cells have no event above the noise-derived floor
            {props.eventSeparationS != null
              ? ` (events at least ${props.eventSeparationS} s apart)`
              : ''}
            . Drag across the bars to highlight those cells in the raster.
          </p>
        </>
      }
      footer={
        <>
          <span>median {Number.isFinite(median()) ? median().toFixed(1) : '--'}</span>
          <span>N {props.snr().length}</span>
          <Show when={props.silentCount}>
            <span>silent {props.silentCount!()}</span>
          </Show>
          <Show when={Number.isFinite(nuMedian())}>
            <span>ν median {formatTick(nuMedian())}</span>
          </Show>
        </>
      }
    >
      <BrushHistogram
        values={props.snr}
        domain={domain()}
        log
        binCount={28}
        binColor={(bin) => viridisCss(rankOf(Math.sqrt(bin.x0 * bin.x1)))}
        shade={{ lo: 0, hi: props.noiseFloor.hi, label: '≈ noise' }}
        markers={markers}
        highlighted={props.highlighted}
        onBrush={props.onBrush}
        xLabel="measured SNR (log)"
        ariaLabel="SNR histogram"
      />
    </OverviewCard>
  );
}
