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
        Cala sends anonymous usage statistics (which features are used, run size, speed, memory and
        errors) and a coarse hardware snapshot (operating system family, CPU core count, memory
        class, GPU type and limits, browser version, display scale) with a random identifier stored
        in this browser. Recordings, file names and personal data never leave your browser; only
        country and region are kept, and no IP address is stored.
      </p>
      <label class="cala-check">
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
          Tag my runs with a name (optional, helps the developers debug your runs)
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
          A tag is sent with the usage statistics and linked to your runs. Clear it to stop sending
          it. Letters, digits, space and . _ @ - only, up to {TESTER_TAG_MAX} characters.
        </p>
      </Show>
    </section>
  );
}
