/**
 * Sidebar tab switcher: Community | Spectrum | Metrics
 * Preserves component state by rendering all tabs, hiding inactive ones via display:none.
 */

import { createSignal, For, type JSX } from 'solid-js';

export type SidebarTab = 'community' | 'spectrum' | 'metrics';

export interface SidebarTabsProps {
  communityContent?: JSX.Element;
  metricsContent: JSX.Element;
  spectrumContent?: JSX.Element;
}

export function SidebarTabs(props: SidebarTabsProps) {
  const tabs = (): { id: SidebarTab; label: string; content: JSX.Element }[] => {
    const list: { id: SidebarTab; label: string; content: JSX.Element }[] = [];
    if (props.communityContent) list.push({ id: 'community', label: 'Community', content: props.communityContent });
    if (props.spectrumContent) list.push({ id: 'spectrum', label: 'Spectrum', content: props.spectrumContent });
    list.push({ id: 'metrics', label: 'Metrics', content: props.metricsContent });
    return list;
  };

  const defaultTab: SidebarTab = props.communityContent ? 'community' : props.spectrumContent ? 'spectrum' : 'metrics';
  const [activeTab, setActiveTab] = createSignal<SidebarTab>(defaultTab);

  return (
    <div class="sidebar-tabs">
      <div class="sidebar-tabs__bar">
        <For each={tabs()}>
          {(tab) => (
            <button
              class={`sidebar-tabs__tab${activeTab() === tab.id ? ' sidebar-tabs__tab--active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          )}
        </For>
      </div>
      <div class="sidebar-tabs__content">
        <For each={tabs()}>
          {(tab) => (
            <div style={{ display: activeTab() === tab.id ? 'block' : 'none' }}>
              {tab.content}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
