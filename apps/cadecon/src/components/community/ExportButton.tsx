/** CaDecon results export: bridge export to Python, or a local .zip download. */

import { Show, createSignal, type JSX } from 'solid-js';
import {
  isDemo,
  bridgeUrl,
  bridgeExportDone,
  bridgeExportError,
  setBridgeExportError,
} from '../../lib/data-store.ts';
import { runState } from '../../lib/iteration-store.ts';
import { isBridgeAutorun, runBridgeExport } from '../../lib/bridge-effects.ts';
import { downloadResults } from '../../lib/results-export.ts';

export function ExportButton(): JSX.Element {
  const [exporting, setExporting] = createSignal(false);
  // Manual-export errors route through the shared bridgeExportError signal
  // so both manual- and autorun-path failures surface in the same place.
  const error = bridgeExportError;

  const isComplete = () => runState() === 'complete';
  const isBridge = () => !!bridgeUrl();
  // bridgeExportDone/autorun describe the bridge handshake only -- a local
  // download is repeatable, so it must not latch to a disabled "Exported".
  const isDisabled = () =>
    !isComplete() || exporting() || (isBridge() && (isBridgeAutorun() || bridgeExportDone()));

  async function handleExport(): Promise<void> {
    const url = bridgeUrl();

    setExporting(true);
    setBridgeExportError(null);
    try {
      if (url) await runBridgeExport(url);
      else downloadResults();
    } catch (e) {
      setBridgeExportError(e instanceof Error ? e.message : 'Export failed');
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
                  : 'Download results as a .zip (activity + results.json)'
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
                : 'Download Results'}
      </button>
      <Show when={error()}>
        <span class="submit-panel__error">{error()}</span>
      </Show>
    </Show>
  );
}
