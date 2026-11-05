/**
 * Card (g): quality flags with counts. Clicking a row highlights its cells
 * (click again to clear); each row lists the first few cell ids, which pick
 * that cell.
 */

import { For, Show, type JSX } from 'solid-js';
import { OverviewCard } from './OverviewCard.tsx';

export interface FlagItem {
  key: string;
  label: string;
  description: string;
  ids: number[];
}

export interface QualityFlagListProps {
  items: () => FlagItem[];
  /** Key of the flag whose cells are highlighted. */
  activeKey?: () => string | null;
  onSelect?: (key: string | null, ids: number[]) => void;
  onPick?: (id: number) => void;
  totalCells?: () => number;
  /** Cells with at least one flag. */
  flaggedCells?: () => number;
  /** Extra help paragraph (thresholds etc.). */
  help?: JSX.Element;
}

const MAX_IDS = 6;

export function QualityFlagList(props: QualityFlagListProps): JSX.Element {
  return (
    <OverviewCard
      title="Quality flags"
      data-testid="overview-flags"
      help={props.help}
      footer={
        <Show when={props.totalCells}>
          <span>
            {props.flaggedCells?.() ?? 0} of {props.totalCells!()} cells flagged
          </span>
        </Show>
      }
    >
      <ul class="ov-flags">
        <For each={props.items()}>
          {(item) => {
            const active = () => props.activeKey?.() === item.key;
            return (
              <li
                class="ov-flags__row"
                classList={{
                  'ov-flags__row--active': active(),
                  'ov-flags__row--zero': item.ids.length === 0,
                }}
              >
                <button
                  type="button"
                  class="ov-flags__main"
                  title={item.description}
                  disabled={item.ids.length === 0}
                  aria-pressed={active()}
                  onClick={() => props.onSelect?.(active() ? null : item.key, item.ids)}
                >
                  <span class="ov-flags__count">{item.ids.length}</span>
                  <span class="ov-flags__label">{item.label}</span>
                </button>
                <span class="ov-flags__ids">
                  <For each={item.ids.slice(0, MAX_IDS)}>
                    {(id) => (
                      <button
                        type="button"
                        class="ov-flags__id"
                        title={`Inspect cell ${id}`}
                        onClick={() => props.onPick?.(id)}
                      >
                        {id}
                      </button>
                    )}
                  </For>
                  <Show when={item.ids.length > MAX_IDS}>
                    <span class="ov-flags__more">+{item.ids.length - MAX_IDS}</span>
                  </Show>
                </span>
              </li>
            );
          }}
        </For>
      </ul>
    </OverviewCard>
  );
}
