import type { JSX } from 'solid-js';
import { dateRange, setDateRange } from '../lib/admin-store.ts';

export function DateRangeSelector(): JSX.Element {
  return (
    <div class="date-range">
      <input
        type="date"
        value={dateRange().start}
        onInput={(e) => setDateRange((prev) => ({ ...prev, start: e.currentTarget.value }))}
      />
      <span class="date-range__sep">to</span>
      <input
        type="date"
        value={dateRange().end}
        onInput={(e) => setDateRange((prev) => ({ ...prev, end: e.currentTarget.value }))}
      />
    </div>
  );
}
