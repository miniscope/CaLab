import type { JSX } from 'solid-js';
import { For } from 'solid-js';
import { activeView, setActiveView } from '../lib/admin-store.ts';
import type { AdminView } from '../lib/types.ts';

const TABS: { id: AdminView; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'usage', label: 'Usage' },
  { id: 'geography', label: 'Geography' },
  { id: 'submissions', label: 'Submissions' },
  { id: 'export', label: 'Export' },
];

export function NavBar(): JSX.Element {
  return (
    <nav class="admin-nav">
      <For each={TABS}>
        {(tab) => (
          <button
            class={`admin-nav__tab${activeView() === tab.id ? ' admin-nav__tab--active' : ''}`}
            onClick={() => setActiveView(tab.id)}
          >
            {tab.label}
          </button>
        )}
      </For>
    </nav>
  );
}
