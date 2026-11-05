// Dataset-overview cards: presentational, app-agnostic (plain arrays and
// callbacks in, no app stores). Styles: `@calab/ui/dataset/dataset.css`.
export { OverviewCard, createElementSize, createBrush } from './OverviewCard.tsx';
export type { OverviewCardProps, BrushState } from './OverviewCard.tsx';
export { BrushHistogram } from './BrushHistogram.tsx';
export type { BrushHistogramProps, HistogramMarker } from './BrushHistogram.tsx';
export { SnrHistogramCard, snrDomain } from './SnrHistogramCard.tsx';
export type { SnrHistogramCardProps } from './SnrHistogramCard.tsx';
export { EventHeightCard } from './EventHeightCard.tsx';
export type { EventHeightCardProps, HeightCurve } from './EventHeightCard.tsx';
export { BaselineCard } from './BaselineCard.tsx';
export type { BaselineCardProps } from './BaselineCard.tsx';
export { QualityFlagList } from './QualityFlagList.tsx';
export type { QualityFlagListProps, FlagItem } from './QualityFlagList.tsx';
export { ScatterCard } from './ScatterCard.tsx';
export type { ScatterCardProps, ScatterCurve, PointStyle } from './ScatterCard.tsx';
export {
  makeScale,
  scaleTicks,
  formatTick,
  extent,
  binValues,
  idsInRange,
} from './chart-scales.ts';
export type { Scale, Bin } from './chart-scales.ts';
