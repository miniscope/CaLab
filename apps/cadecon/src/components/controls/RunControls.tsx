import type { JSX } from 'solid-js';

export function RunControls(): JSX.Element {
  return (
    <div class="param-panel">
      <div style="display: flex; gap: var(--space-sm); flex-wrap: wrap;">
        <button class="btn-primary" disabled title="Active in Phase 2">
          Start
        </button>
        <button class="btn-secondary" disabled title="Active in Phase 2">
          Pause
        </button>
        <button class="btn-secondary" disabled title="Active in Phase 2">
          Stop
        </button>
        <button class="btn-secondary" disabled title="Active in Phase 2">
          Reset
        </button>
      </div>
      <p class="text-secondary" style="font-size: 0.75rem; margin-top: var(--space-sm);">
        Deconvolution pipeline active in Phase 2.
      </p>
    </div>
  );
}
