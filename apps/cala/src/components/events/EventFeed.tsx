import { createMemo, For, Show, type JSX } from 'solid-js';
import { dashboard } from '../../lib/dashboard-store.ts';
import { pushUserMutation } from '../../lib/run-control.ts';
import { describeEvent, idForEvent } from './event-format.ts';

// Trailing window of events shown in the feed (design §12 scrolling
// log). Full history lives in the archive worker; this is just the
// visible tail.
const DEFAULT_EVENT_TAIL_LENGTH = 50;

export interface EventFeedProps {
  /** Override the visible tail length. Defaults to 50. */
  tailLength?: number;
}

export function EventFeed(props: EventFeedProps): JSX.Element {
  const tail = createMemo(() => {
    const events = dashboard.events;
    const limit = props.tailLength ?? DEFAULT_EVENT_TAIL_LENGTH;
    const start = Math.max(0, events.length - limit);
    // Clone then reverse so the store's original order isn't mutated.
    return events.slice(start).slice().reverse();
  });

  // Find the most recent birth so "Deprecate latest" has a target.
  const latestBirthId = createMemo<number | null>(() => {
    const events = dashboard.events;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.kind === 'birth') return e.id;
    }
    return null;
  });

  const deprecateLatest = (): void => {
    const id = latestBirthId();
    if (id === null) return;
    pushUserMutation({ kind: 'deprecate', id, reason: 'invalidApply' });
  };

  return (
    <div class="event-feed" role="log" aria-live="polite" aria-label="Pipeline event feed">
      <div class="event-feed__toolbar">
        <button
          type="button"
          class="event-feed__action"
          onClick={deprecateLatest}
          disabled={latestBirthId() === null}
          title="Deprecate the most recently born neuron"
        >
          Deprecate latest
        </button>
      </div>
      <div class="event-feed__heading">Events (newest first)</div>
      <Show when={tail().length > 0} fallback={<div class="event-feed__empty">No events yet.</div>}>
        <ul class="event-feed__list">
          <For each={tail()}>
            {(e) => (
              <li class={`event-feed__item event-feed__item--${e.kind}`}>
                <span class="event-feed__t">t={e.t}</span>
                <span class="event-feed__kind">{e.kind}</span>
                <span class="event-feed__id">{idForEvent(e)}</span>
                <span class="event-feed__detail">{describeEvent(e)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
