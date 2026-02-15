/**
 * Parameter export controls.
 * Triggers JSON download with current parameter values, AR2 coefficients,
 * and scientific formulation metadata.
 */

import { tauRise, tauDecay, lambda, filterEnabled } from '../../lib/viz-store';
import { samplingRate, rawFile, effectiveShape } from '../../lib/data-store';
import { buildExportData, downloadExport } from '../../lib/export';
import '../../styles/multi-trace.css';

export function ExportPanel() {
  const handleExport = () => {
    const fs = samplingRate() ?? 30;
    const shape = effectiveShape();
    const file = rawFile();

    const exportData = buildExportData(
      tauRise(),
      tauDecay(),
      lambda(),
      fs,
      filterEnabled(),
      {
        sourceFilename: file?.name,
        numCells: shape?.[0],
        numTimepoints: shape?.[1],
      },
    );

    downloadExport(exportData);
  };

  return (
    <div class="export-panel" data-tutorial="export-panel">
      <button class="btn-primary btn-small" onClick={handleExport}>
        Export Parameters
      </button>
      <span class="export-panel__summary">
        rise: {(tauRise() * 1000).toFixed(1)}ms, decay:{' '}
        {(tauDecay() * 1000).toFixed(1)}ms, lambda: {lambda().toExponential(2)}
      </span>
    </div>
  );
}
