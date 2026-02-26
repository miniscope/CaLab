/**
 * Flat multi-filter bar for community browser.
 * Base filters (indicator, species, brain region) with AND combination.
 * Supports extra app-specific filters via the extraFilters prop.
 * Includes clear button and filtered result count.
 */

import { Show } from 'solid-js';
import type { BaseFilterState } from '@calab/community';
import './styles/community.css';

export interface ExtraFilter {
  id: string;
  label: string;
  options: { id: string; label: string }[];
}

export interface FilterBarProps<F extends BaseFilterState = BaseFilterState> {
  filters: F;
  onFilterChange: (filters: F) => void;
  options: {
    indicators: string[];
    species: string[];
    brainRegions: string[];
  };
  filteredCount: number;
  totalCount: number;
  extraFilters?: ExtraFilter[];
  /** When true, show extra filters instead of base filters (e.g. demo preset mode). */
  showExtraFiltersOnly?: boolean;
  highlightMine?: boolean;
  onHighlightMineChange?: () => void;
  canHighlight?: boolean;
}

export function FilterBar<F extends BaseFilterState>(props: FilterBarProps<F>) {
  const hasActiveDataFilters = () =>
    props.filters.indicator !== null ||
    props.filters.species !== null ||
    props.filters.brainRegion !== null ||
    (props.extraFilters ?? []).some(
      (ef) => (props.filters as Record<string, unknown>)[ef.id] !== null,
    );

  const hasActiveControls = () => hasActiveDataFilters() || !!props.highlightMine;

  function handleFilterChange(field: string, value: string): void {
    props.onFilterChange({
      ...props.filters,
      [field]: value === '' ? null : value,
    });
  }

  function handleClear(): void {
    const cleared: Record<string, null> = {
      indicator: null,
      species: null,
      brainRegion: null,
    };
    for (const ef of props.extraFilters ?? []) {
      cleared[ef.id] = null;
    }
    props.onFilterChange({ ...props.filters, ...cleared } as F);
    if (props.highlightMine && props.onHighlightMineChange) {
      props.onHighlightMineChange();
    }
  }

  return (
    <div class="filter-bar">
      {props.showExtraFiltersOnly && props.extraFilters ? (
        <>
          {props.extraFilters.map((ef) => (
            <select
              class="filter-bar__select"
              value={((props.filters as Record<string, unknown>)[ef.id] as string) ?? ''}
              onChange={(e) => handleFilterChange(ef.id, e.currentTarget.value)}
            >
              <option value="">{ef.label}</option>
              {ef.options.map((opt) => (
                <option value={opt.id}>{opt.label}</option>
              ))}
            </select>
          ))}
        </>
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

          {/* Render extra filters alongside base filters when not in extra-only mode */}
          {(props.extraFilters ?? []).map((ef) => (
            <select
              class="filter-bar__select"
              value={((props.filters as Record<string, unknown>)[ef.id] as string) ?? ''}
              onChange={(e) => handleFilterChange(ef.id, e.currentTarget.value)}
            >
              <option value="">{ef.label}</option>
              {ef.options.map((opt) => (
                <option value={opt.id}>{opt.label}</option>
              ))}
            </select>
          ))}
        </>
      )}

      <Show when={props.canHighlight}>
        <button
          class={`filter-bar__highlight-btn ${props.highlightMine ? 'filter-bar__highlight-btn--active' : ''}`}
          onClick={props.onHighlightMineChange}
        >
          {props.highlightMine ? '\u25CF' : '\u25CB'} My submissions
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
