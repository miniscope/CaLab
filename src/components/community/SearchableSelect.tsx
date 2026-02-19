/**
 * Constrained searchable dropdown (combobox).
 * Only allows selection from the provided options list — no free-text.
 * Keyboard accessible: ArrowUp/Down, Enter to select, Escape to close.
 */

import { createSignal, createMemo, For, Show, onCleanup } from 'solid-js';
import '../../styles/community.css';

export interface SearchableSelectProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SearchableSelect(props: SearchableSelectProps) {
  const [query, setQuery] = createSignal('');
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(-1);
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLUListElement | undefined;

  const filtered = createMemo(() => {
    const q = query().toLowerCase();
    if (!q) return props.options;
    return props.options.filter((opt) => opt.toLowerCase().includes(q));
  });

  function selectOption(value: string) {
    props.onChange(value);
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
    inputRef?.blur();
  }

  function clear() {
    props.onChange('');
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleInput(e: InputEvent) {
    setQuery((e.target as HTMLInputElement).value);
    setOpen(true);
    setActiveIndex(-1);
  }

  function handleFocus() {
    if (!props.value) {
      setOpen(true);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const items = filtered();

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setOpen(true);
        setActiveIndex((i) => Math.min(i + 1, items.length - 1));
        scrollActiveIntoView();
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        scrollActiveIntoView();
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex() >= 0 && activeIndex() < items.length) {
          selectOption(items[activeIndex()]);
        } else if (items.length === 1) {
          selectOption(items[0]);
        }
        break;
      case 'Escape':
        setOpen(false);
        setQuery('');
        setActiveIndex(-1);
        break;
    }
  }

  function scrollActiveIntoView() {
    requestAnimationFrame(() => {
      const active = listRef?.querySelector('[data-active="true"]');
      active?.scrollIntoView({ block: 'nearest' });
    });
  }

  // Close dropdown when clicking outside
  function handleDocumentClick(e: MouseEvent) {
    const target = e.target as Node;
    if (!inputRef?.parentElement?.contains(target)) {
      setOpen(false);
      setQuery('');
      setActiveIndex(-1);
    }
  }
  document.addEventListener('mousedown', handleDocumentClick);
  onCleanup(() => document.removeEventListener('mousedown', handleDocumentClick));

  return (
    <div class="searchable-select" role="combobox" aria-expanded={open()} aria-haspopup="listbox">
      <Show
        when={!props.value}
        fallback={
          <div class="searchable-select__selected">
            <span class="searchable-select__value">{props.value}</span>
            <button
              type="button"
              class="searchable-select__clear"
              onClick={clear}
              aria-label="Clear selection"
            >
              &times;
            </button>
          </div>
        }
      >
        <input
          ref={inputRef}
          type="text"
          class="searchable-select__input"
          value={query()}
          onInput={handleInput}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          placeholder={props.placeholder}
          aria-autocomplete="list"
          autocomplete="off"
        />
      </Show>

      <Show when={open() && !props.value}>
        <ul ref={listRef} class="searchable-select__dropdown" role="listbox">
          <Show
            when={filtered().length > 0}
            fallback={<li class="searchable-select__no-results">No matches</li>}
          >
            <For each={filtered()}>
              {(option, i) => (
                <li
                  role="option"
                  class="searchable-select__option"
                  classList={{ 'searchable-select__option--active': i() === activeIndex() }}
                  data-active={i() === activeIndex()}
                  aria-selected={i() === activeIndex()}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectOption(option);
                  }}
                  onMouseEnter={() => setActiveIndex(i())}
                >
                  {option}
                </li>
              )}
            </For>
          </Show>
        </ul>
      </Show>
    </div>
  );
}
