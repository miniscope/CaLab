/**
 * CaDecon FilterBar — wraps the shared FilterBar with CaDecon's filter state type.
 */

import { FilterBar as SharedFilterBar } from '@calab/ui';
import type { CadeconFilterState } from '../../lib/community/index.ts';

export interface FilterBarProps {
  filters: CadeconFilterState;
  onFilterChange: (filters: CadeconFilterState) => void;
  options: {
    indicators: string[];
    species: string[];
    brainRegions: string[];
  };
  filteredCount: number;
  totalCount: number;
  demoPresets?: { id: string; label: string }[];
  showDemoPresetFilter?: boolean;
  highlightMine?: boolean;
  onHighlightMineChange?: () => void;
  canHighlight?: boolean;
}

export function FilterBar(props: FilterBarProps) {
  return (
    <SharedFilterBar
      filters={props.filters}
      onFilterChange={props.onFilterChange}
      options={props.options}
      filteredCount={props.filteredCount}
      totalCount={props.totalCount}
      extraFilters={
        props.demoPresets
          ? [{ id: 'demoPreset', label: 'All presets', options: props.demoPresets }]
          : undefined
      }
      showExtraFiltersOnly={props.showDemoPresetFilter}
      highlightMine={props.highlightMine}
      onHighlightMineChange={props.onHighlightMineChange}
      canHighlight={props.canHighlight}
    />
  );
}
