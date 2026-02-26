/** uPlot plugin that draws a vertical dashed line at the convergence iteration. */

import type uPlot from 'uplot';
import { verticalMarkerPlugin } from './vertical-marker-plugin.ts';

export function convergenceMarkerPlugin(getConvergedAt: () => number | null): uPlot.Plugin {
  return verticalMarkerPlugin({
    getValue: getConvergedAt,
    label: () => 'Converged',
    strokeColor: '#4caf50',
    labelColor: '#388e3c',
    dash: [4, 3],
  });
}
