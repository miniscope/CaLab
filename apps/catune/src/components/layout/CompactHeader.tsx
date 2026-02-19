import { Show, type Accessor } from 'solid-js';
import { CompactHeader } from '@calab/ui';
import {
  rawFile,
  effectiveShape,
  samplingRate,
  durationSeconds,
  resetImport,
} from '../../lib/data-store.ts';
import { clearMultiCellState } from '../../lib/multi-cell-store.ts';
import { TutorialLauncher } from '../tutorial/TutorialLauncher.tsx';
import { FeedbackMenu } from './FeedbackMenu.tsx';
import { formatDuration } from '@calab/core';

export interface CaTuneHeaderProps {
  tutorialOpen: Accessor<boolean>;
  onTutorialToggle: () => void;
  /** Whether the sidebar is currently open. */
  sidebarOpen?: boolean;
  /** Callback invoked when the user clicks the sidebar toggle. */
  onToggleSidebar?: () => void;
}

export function CaTuneHeader(props: CaTuneHeaderProps) {
  const handleChangeData = () => {
    clearMultiCellState();
    resetImport();
  };

  const durationDisplay = () => formatDuration(durationSeconds());

  const version = () => `CaLab ${import.meta.env.VITE_APP_VERSION || 'dev'}`;

  return (
    <CompactHeader
      title="CaTune"
      version={version()}
      data-tutorial="header-bar"
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
        </>
      }
      actions={
        <>
          <FeedbackMenu />
          <TutorialLauncher isOpen={props.tutorialOpen} onToggle={props.onTutorialToggle} />
          <button
            class={`btn-secondary btn-small${props.sidebarOpen ? ' btn-active' : ''}`}
            data-tutorial="sidebar-toggle"
            onClick={() => props.onToggleSidebar?.()}
          >
            Sidebar
          </button>
          <button class="btn-secondary btn-small" onClick={handleChangeData}>
            Change Data
          </button>
        </>
      }
    />
  );
}
