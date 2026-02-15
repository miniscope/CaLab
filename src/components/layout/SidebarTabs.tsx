/**
 * Sidebar tab switcher: Community | Spectrum | Metrics
 * Preserves component state by rendering both, hiding the inactive one.
 */

import { createSignal, Show, type JSX } from 'solid-js';

export type SidebarTab = 'community' | 'spectrum' | 'metrics';

export interface SidebarTabsProps {
  communityContent?: JSX.Element;
  metricsContent: JSX.Element;
  spectrumContent?: JSX.Element;
}

export function SidebarTabs(props: SidebarTabsProps) {
  const [activeTab, setActiveTab] = createSignal<SidebarTab>('community');

  return (
    <div class="sidebar-tabs">
      <div class="sidebar-tabs__bar">
        <Show when={props.communityContent}>
          <button
            class={`sidebar-tabs__tab${activeTab() === 'community' ? ' sidebar-tabs__tab--active' : ''}`}
            onClick={() => setActiveTab('community')}
          >
            Community
          </button>
        </Show>
        <Show when={props.spectrumContent}>
          <button
            class={`sidebar-tabs__tab${activeTab() === 'spectrum' ? ' sidebar-tabs__tab--active' : ''}`}
            onClick={() => setActiveTab('spectrum')}
          >
            Spectrum
          </button>
        </Show>
        <button
          class={`sidebar-tabs__tab${activeTab() === 'metrics' ? ' sidebar-tabs__tab--active' : ''}`}
          onClick={() => setActiveTab('metrics')}
        >
          Metrics
        </button>
      </div>
      <div class="sidebar-tabs__content">
        <Show when={props.communityContent}>
          <div style={{ display: activeTab() === 'community' ? 'block' : 'none' }}>
            {props.communityContent}
          </div>
        </Show>
        <Show when={props.spectrumContent}>
          <div style={{ display: activeTab() === 'spectrum' ? 'block' : 'none' }}>
            {props.spectrumContent}
          </div>
        </Show>
        <div style={{ display: activeTab() === 'metrics' ? 'block' : 'none' }}>
          {props.metricsContent}
        </div>
      </div>
    </div>
  );
}
