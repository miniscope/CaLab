// Convergence indicator showing solver status as a colored dot + label.
// Displays idle/solving/converged/error states with appropriate visuals.
//
// Note: solverStatus is defined locally for now. Plan 03 (tuning orchestrator)
// will move these signals to viz-store when wiring the full reactive loop.

import { createSignal } from 'solid-js';

export type SolverStatusType = 'idle' | 'solving' | 'converged' | 'error';

const [solverStatus, setSolverStatus] =
  createSignal<SolverStatusType>('idle');

export { solverStatus, setSolverStatus };

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
    <div class={`convergence ${statusClass()}`}>
      <span class="convergence__dot" />
      <span class="convergence__text">{statusText()}</span>
    </div>
  );
}
