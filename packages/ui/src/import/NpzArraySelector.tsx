// Shown when a .npz / .mat holds several arrays that could be the traces.

import { For, Show, createMemo, type JSX } from 'solid-js';
import { traceCandidates } from '@calab/io';
import type { ImportStore } from '@calab/io';

export interface NpzArraySelectorProps {
  store: ImportStore;
}

export function NpzArraySelector(props: NpzArraySelectorProps): JSX.Element {
  const twoDArrays = createMemo(() => {
    const npz = props.store.npzArrays();
    if (!npz) return [];
    return traceCandidates(npz).map((name) => ({
      name,
      shape: npz.arrays[name].shape,
      dtype: npz.arrays[name].dtype,
    }));
  });

  return (
    <Show when={twoDArrays().length > 0}>
      <div class="card">
        <h3 class="card__title">Select Array</h3>
        <p class="text-secondary">
          This file contains {twoDArrays().length} arrays that could hold 2D trace data. Select the
          one containing your calcium traces:
        </p>
        <div class="npz-array-list">
          <For each={twoDArrays()}>
            {(arr) => (
              <button class="npz-array-item" onClick={() => props.store.selectNpzArray(arr.name)}>
                <span class="npz-array-item__name">{arr.name}</span>
                <span class="npz-array-item__meta">
                  {arr.shape[0]} x {arr.shape[1]} &middot; {arr.dtype}
                </span>
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
