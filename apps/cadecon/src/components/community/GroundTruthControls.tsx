/** Ground truth reveal/toggle controls and export button for CaDecon. */

import { Show, createSignal, type JSX } from 'solid-js';
import {
  isDemo,
  groundTruthVisible,
  groundTruthLocked,
  revealGroundTruth,
  toggleGroundTruthVisibility,
  bridgeUrl,
  bridgeExportDone,
} from '../../lib/data-store.ts';
import { runState } from '../../lib/iteration-store.ts';
import { isBridgeAutorun, runBridgeExport } from '../../lib/bridge-effects.ts';

export function GroundTruthControls(): JSX.Element {
  function handleToggle(): void {
    if (!groundTruthLocked()) {
      revealGroundTruth();
    } else {
      toggleGroundTruthVisibility();
    }
  }

  return (
    <Show when={isDemo()}>
      <button class="btn-primary btn-small" onClick={handleToggle}>
        {groundTruthVisible() ? 'Hide Ground Truth' : 'Show Ground Truth'}
      </button>
    </Show>
  );
}

export function GroundTruthNotices(): JSX.Element {
  return (
    <Show when={isDemo()}>
      <Show when={!groundTruthLocked()}>
        <div class="submit-panel__gt-warning">
          Revealing ground truth will disable community submission
        </div>
      </Show>
      <Show when={groundTruthLocked()}>
        <div class="submit-panel__gt-locked-notice">
          Community submission disabled — ground truth was viewed. Reload demo data to re-enable.
        </div>
      </Show>
    </Show>
  );
}

export function ExportButton(): JSX.Element {
  const [exporting, setExporting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const isComplete = () => runState() === 'complete';
  const isBridge = () => !!bridgeUrl();
  const isDisabled = () => isBridgeAutorun() || !isComplete() || exporting() || bridgeExportDone();

  async function handleExport(): Promise<void> {
    const url = bridgeUrl();
    if (!url) return;

    setExporting(true);
    setError(null);
    try {
      await runBridgeExport(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  return (
    <Show when={!isDemo()}>
      <button
        class="btn-secondary btn-small"
        disabled={isDisabled()}
        title={
          isBridgeAutorun()
            ? 'Auto-export enabled'
            : bridgeExportDone()
              ? 'Exported'
              : !isComplete()
                ? 'Run solver first'
                : isBridge()
                  ? 'Export results to Python'
                  : 'Export coming soon'
        }
        onClick={handleExport}
      >
        {isBridgeAutorun()
          ? 'Auto-export enabled'
          : exporting()
            ? 'Exporting...'
            : bridgeExportDone()
              ? 'Exported'
              : isBridge()
                ? 'Export to Python'
                : 'Export Locally'}
      </button>
      <Show when={error()}>
        <span class="submit-panel__error">{error()}</span>
      </Show>
    </Show>
  );
}
