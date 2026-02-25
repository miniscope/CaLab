import { Show, type JSX } from 'solid-js';
import { CompactHeader, WorkerIndicator } from '@calab/ui';
import { resolveWorkerCount } from '@calab/compute';
import {
  rawFile,
  effectiveShape,
  samplingRate,
  durationSeconds,
  resetImport,
} from '../../lib/data-store.ts';
import { AuthMenuWrapper } from './AuthMenuWrapper.tsx';
import { formatDuration } from '@calab/core';

export function CaDeconHeader(): JSX.Element {
  const workerCount = resolveWorkerCount();
  const durationDisplay = () => formatDuration(durationSeconds());
  const version = () => `CaLab ${import.meta.env.VITE_APP_VERSION || 'dev'}`;

  return (
    <CompactHeader
      title="CaDecon"
      version={version()}
      info={
        <>
          <Show when={rawFile()}>
            {(file) => <span class="compact-header__file">{file().name}</span>}
          </Show>
          <Show when={effectiveShape()}>
            {(shape) => (
              <>
                <span class="compact-header__sep">&middot;</span>
                <span>{shape()[0]} cells</span>
                <span class="compact-header__sep">&middot;</span>
                <span>{shape()[1].toLocaleString()} tp</span>
              </>
            )}
          </Show>
          <Show when={samplingRate()}>
            <span class="compact-header__sep">&middot;</span>
            <span>{samplingRate()} Hz</span>
          </Show>
          <Show when={durationDisplay()}>
            <span class="compact-header__sep">&middot;</span>
            <span>{durationDisplay()}</span>
          </Show>
          <span class="compact-header__sep">&middot;</span>
          <WorkerIndicator count={workerCount} />
        </>
      }
      actions={
        <>
          <button class="btn-secondary btn-small" onClick={resetImport}>
            Change Data
          </button>
          <AuthMenuWrapper />
        </>
      }
    />
  );
}
