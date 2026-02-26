/** Stats grid comparing a subset's parameters to the merged median. */

import type { JSX } from 'solid-js';
import type { KernelSnapshot } from '../../lib/iteration-store.ts';

export interface SubsetStatsProps {
  subsetIdx: number;
  snapshot: KernelSnapshot;
  cellRange: [number, number];
  timeRange: [number, number];
}

function fmt(v: number, decimals = 2): string {
  return v.toFixed(decimals);
}

export function SubsetStats(props: SubsetStatsProps): JSX.Element {
  const sub = () => {
    if (props.subsetIdx >= props.snapshot.subsets.length) return null;
    return props.snapshot.subsets[props.subsetIdx];
  };

  return (
    <div class="subset-stats">
      <table class="subset-stats__table">
        <thead>
          <tr>
            <th />
            <th>Subset</th>
            <th>Merged</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>tau_r (ms)</td>
            <td>{sub() ? fmt(sub()!.tauRise * 1000, 1) : '--'}</td>
            <td>{fmt(props.snapshot.tauRise * 1000, 1)}</td>
          </tr>
          <tr>
            <td>tau_d (ms)</td>
            <td>{sub() ? fmt(sub()!.tauDecay * 1000, 1) : '--'}</td>
            <td>{fmt(props.snapshot.tauDecay * 1000, 1)}</td>
          </tr>
          <tr>
            <td>beta</td>
            <td>{sub() ? fmt(sub()!.beta, 3) : '--'}</td>
            <td>{fmt(props.snapshot.beta, 3)}</td>
          </tr>
          <tr>
            <td>residual</td>
            <td>{sub() ? fmt(sub()!.residual, 4) : '--'}</td>
            <td>{fmt(props.snapshot.residual, 4)}</td>
          </tr>
        </tbody>
      </table>
      <div class="subset-stats__ranges">
        <span>
          Cells: {props.cellRange[0]}–{props.cellRange[1]}
        </span>
        <span>
          Time: {props.timeRange[0]}–{props.timeRange[1]}
        </span>
      </div>
    </div>
  );
}
