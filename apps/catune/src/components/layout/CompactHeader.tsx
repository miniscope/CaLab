import { Show, type Accessor } from 'solid-js';
import {
  rawFile,
  effectiveShape,
  samplingRate,
  durationSeconds,
  resetImport,
} from '../../lib/data-store.ts';
import { clearMultiCellState } from '../../lib/multi-cell-store.ts';
import { supabaseEnabled } from '../../lib/community/index.ts';
import { sidebarOpen, setSidebarOpen } from './DashboardShell.tsx';
import { TutorialLauncher } from '../tutorial/TutorialLauncher.tsx';
import { FeedbackMenu } from './FeedbackMenu.tsx';
import { formatDuration } from '@catune/core';
import '../../styles/compact-header.css';

export interface CompactHeaderProps {
  tutorialOpen: Accessor<boolean>;
  onTutorialToggle: () => void;
}

export function CompactHeader(props: CompactHeaderProps) {
  const handleChangeData = () => {
    clearMultiCellState();
    resetImport();
  };

  const durationDisplay = () => formatDuration(durationSeconds());

  return (
    <header class="compact-header" data-tutorial="header-bar">
      <div class="compact-header__brand">
        <span class="compact-header__title">CaTune</span>
        <span class="compact-header__version">{import.meta.env.VITE_APP_VERSION || 'dev'}</span>
      </div>

      <div class="compact-header__info">
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
      </div>

      <div class="compact-header__actions">
        <FeedbackMenu />
        <TutorialLauncher isOpen={props.tutorialOpen} onToggle={props.onTutorialToggle} />
        <button
          class={`btn-secondary btn-small${sidebarOpen() ? ' btn-active' : ''}`}
          data-tutorial="sidebar-toggle"
          onClick={() => setSidebarOpen((prev) => !prev)}
        >
          Sidebar
        </button>
        <button class="btn-secondary btn-small" onClick={handleChangeData}>
          Change Data
        </button>
      </div>
    </header>
  );
}
