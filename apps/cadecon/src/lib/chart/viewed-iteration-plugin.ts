/** uPlot plugin that draws a solid orange vertical line at the viewed iteration. */

import type uPlot from 'uplot';
import { verticalMarkerPlugin } from './vertical-marker-plugin.ts';

export function viewedIterationPlugin(getViewedIteration: () => number | null): uPlot.Plugin {
  return verticalMarkerPlugin({
    getValue: getViewedIteration,
    label: (iter) => `Iter ${iter}`,
    strokeColor: '#ff9800',
    labelColor: '#e68900',
  });
}
