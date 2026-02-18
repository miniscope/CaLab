/**
 * Flat multi-filter bar for community browser.
 * Three dropdowns (indicator, species, brain region) with AND combination.
 * Includes clear button and filtered result count.
 */

import type { FilterState } from '../../lib/community/types.ts';
import '../../styles/community.css';

export interface FilterBarProps {
  filters: FilterState;
  onFilterChange: (filters: FilterState) => void;
  options: {
    indicators: string[];
    species: string[];
    brainRegions: string[];
  };
  filteredCount: number;
  totalCount: number;
  demoPresets?: { id: string; label: string }[];
  showDemoPresetFilter?: boolean;
}

export function FilterBar(props: FilterBarProps) {
  const hasActiveFilters = () =>
    props.filters.indicator !== null ||
    props.filters.species !== null ||
    props.filters.brainRegion !== null ||
    props.filters.demoPreset !== null;

  function handleFilterChange(
    field: keyof FilterState,
    value: string,
  ): void {
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

      {hasActiveFilters() && (
        <button class="filter-bar__clear" onClick={handleClear}>
          Clear filters
        </button>
      )}

      <span class="filter-bar__count">
        {hasActiveFilters()
          ? `${props.filteredCount} of ${props.totalCount} submissions`
          : `${props.totalCount} submissions`}
      </span>
    </div>
  );
}
