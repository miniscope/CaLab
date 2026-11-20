import { createSignal, Show, type JSX } from 'solid-js';
import {
  analyticsEnabled,
  getTesterTag,
  setAnalyticsEnabled,
  updateTesterTag,
  TESTER_TAG_MAX,
} from '@calab/community';

/** The privacy notice with the opt-out switch and the optional tester tag (docs/analytics.md). */
export function AnalyticsNotice(): JSX.Element {
  const [on, setOn] = createSignal(analyticsEnabled());
  const [tag, setTag] = createSignal(getTesterTag());
  return (
    <section class="cala-analytics" data-testid="analytics-notice" aria-label="Usage statistics">
      <p class="cala-analytics__text">
        Cala sends anonymous usage statistics (features used, run size and speed, errors, basic
        hardware) with a random ID stored in this browser. Recordings and file names never leave it.
        Your IP address is sent once to a geolocation service to find your country and region; CaLab
        does not store it.
      </p>
      <label
        class="cala-check"
        title="Usage statistics are also off when your browser sends Do Not Track"
      >
        <input
          type="checkbox"
          data-testid="analytics-toggle"
          checked={on()}
          onChange={(e) => setOn(setAnalyticsEnabled(e.currentTarget.checked))}
        />{' '}
        Share anonymous usage statistics
      </label>
      <Show when={on()}>
        <label class="cala-analytics__tag">
          Name for your runs (optional, helps us debug them)
          <input
            type="text"
            data-testid="tester-tag"
            maxLength={TESTER_TAG_MAX}
            value={tag()}
            placeholder="No tag"
            onChange={(e) => {
              const stored = updateTesterTag(e.currentTarget.value);
              setTag(stored);
              e.currentTarget.value = stored;
            }}
          />
        </label>
        <p class="cala-analytics__hint">
          Sent with your usage statistics. Clear it to stop. Up to {TESTER_TAG_MAX} letters, digits
          or . _ @ -
        </p>
      </Show>
    </section>
  );
}
