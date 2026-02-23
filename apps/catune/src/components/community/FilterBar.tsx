/**
 * Flat multi-filter bar for community browser.
 * Three dropdowns (indicator, species, brain region) with AND combination.
 * Includes clear button and filtered result count.
 */

import { Show } from 'solid-js';
import type { CatuneFilterState } from '../../lib/community/index.ts';
import '../../styles/community.css';

export interface FilterBarProps {
  filters: CatuneFilterState;
  onFilterChange: (filters: CatuneFilterState) => void;
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
  const hasActiveDataFilters = () =>
    props.filters.indicator !== null ||
    props.filters.species !== null ||
    props.filters.brainRegion !== null ||
    props.filters.demoPreset !== null;

  const hasActiveControls = () => hasActiveDataFilters() || !!props.highlightMine;

  function handleFilterChange(field: keyof CatuneFilterState, value: string): void {
    props.onFilterChange({
      ...props.filters,
      [field]: value === '' ? null : value,
    });
  }

  function handleClear(): void {
    props.onFilterChange({
      indicator: null,
      species: null,
      brainRegion: null,
      demoPreset: null,
    });
    if (props.highlightMine && props.onHighlightMineChange) {
      props.onHighlightMineChange();
    }
  }

  return (
    <div class="filter-bar">
      {props.showDemoPresetFilter && props.demoPresets ? (
        <select
          class="filter-bar__select"
          value={props.filters.demoPreset ?? ''}
          onChange={(e) => handleFilterChange('demoPreset', e.currentTarget.value)}
        >
          <option value="">All presets</option>
          {props.demoPresets.map((p) => (
            <option value={p.id}>{p.label}</option>
          ))}
        </select>
      ) : (
        <>
          <select
            class="filter-bar__select"
            value={props.filters.indicator ?? ''}
            onChange={(e) => handleFilterChange('indicator', e.currentTarget.value)}
          >
            <option value="">All indicators</option>
            {props.options.indicators.map((ind) => (
              <option value={ind}>{ind}</option>
            ))}
          </select>

          <select
            class="filter-bar__select"
            value={props.filters.species ?? ''}
            onChange={(e) => handleFilterChange('species', e.currentTarget.value)}
          >
            <option value="">All species</option>
            {props.options.species.map((sp) => (
              <option value={sp}>{sp}</option>
            ))}
          </select>

          <select
            class="filter-bar__select"
            value={props.filters.brainRegion ?? ''}
            onChange={(e) => handleFilterChange('brainRegion', e.currentTarget.value)}
          >
            <option value="">All brain regions</option>
            {props.options.brainRegions.map((br) => (
              <option value={br}>{br}</option>
            ))}
          </select>
        </>
      )}

      <Show when={props.canHighlight}>
        <button
          class={`filter-bar__highlight-btn ${props.highlightMine ? 'filter-bar__highlight-btn--active' : ''}`}
          onClick={props.onHighlightMineChange}
        >
          {props.highlightMine ? '●' : '○'} My submissions
        </button>
      </Show>

      {hasActiveControls() && (
        <button class="filter-bar__clear" onClick={handleClear}>
          Clear filters
        </button>
      )}

      <span class="filter-bar__count">
        {hasActiveDataFilters()
          ? `${props.filteredCount} of ${props.totalCount} submissions`
          : `${props.totalCount} submissions`}
      </span>
    </div>
  );
}
