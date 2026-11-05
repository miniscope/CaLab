/**
 * CaTune SidebarTabs — wraps the shared SidebarTabs component.
 * Dataset comes first and is the default; the active tab is owned by the app
 * (createDashboardSidebar) so it can open the sidebar on Dataset when a new
 * dataset's overview is ready. The module-level activeSidebarTab mirrors it so
 * DatasetPanel can skip its table computation while hidden.
 */

import { createEffect, createSignal, type JSX } from 'solid-js';
import { SidebarTabs as SharedSidebarTabs } from '@calab/community-ui';
import type { SidebarTabConfig } from '@calab/community-ui';
import { trackEvent } from '@calab/community';

export type SidebarTab = 'dataset' | 'spectrum' | 'community';

// Module-level signal so DatasetPanel can skip computation when not visible.
const [activeSidebarTab, setActiveSidebarTab] = createSignal<SidebarTab>('dataset');
export { activeSidebarTab, setActiveSidebarTab };

export interface SidebarTabsProps {
  communityContent?: JSX.Element | (() => JSX.Element);
  datasetContent: JSX.Element;
  spectrumContent?: JSX.Element;
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
}

export function SidebarTabs(props: SidebarTabsProps) {
  const tabs = (): SidebarTabConfig[] => {
    const list: SidebarTabConfig[] = [
      { id: 'dataset', label: 'Dataset', content: props.datasetContent },
    ];
    if (props.spectrumContent)
      list.push({ id: 'spectrum', label: 'Spectrum', content: props.spectrumContent });
    if (props.communityContent)
      list.push({
        id: 'community',
        label: 'Community',
        content: props.communityContent,
        onActivate: () => void trackEvent('community_browser_opened'),
      });
    return list;
  };

  createEffect(() => setActiveSidebarTab(props.activeTab));

  return (
    <SharedSidebarTabs
      tabs={tabs()}
      activeTab={props.activeTab}
      onTabChange={(id) => props.onTabChange(id as SidebarTab)}
    />
  );
}
