// Convergence indicator showing solver status as a colored dot + label.
// Displays idle/solving/converged/error states with appropriate visuals.
// Solver status signal is centralized in viz-store.

import { solverStatus } from '../../lib/viz-store.ts';
import type { SolverStatus } from '../../lib/solver-types.ts';

export function ConvergenceIndicator() {
  const statusClass = () => {
    switch (solverStatus()) {
      case 'solving':
        return 'convergence--solving';
      case 'converged':
        return 'convergence--converged';
      case 'error':
        return 'convergence--error';
      default:
        return 'convergence--idle';
    }
  };

  const statusText = () => {
    switch (solverStatus()) {
      case 'solving':
        return 'Solving...';
      case 'converged':
        return 'Converged';
      case 'error':
        return 'Error';
      default:
        return 'Ready';
    }
  };

  return (
    <div class={`convergence ${statusClass()}`} data-tutorial="convergence-indicator">
      <span class="convergence__dot" />
      <span class="convergence__text">{statusText()}</span>
    </div>
  );
}
