import type { Component } from 'solid-js';
import { Show, createSignal } from 'solid-js';
import { DashboardShell, VizLayout } from '@calab/ui';
import { Header } from './components/Header.tsx';
import { FileImport } from './components/FileImport.tsx';
import { RankingDashboard } from './components/RankingDashboard.tsx';
import type { CnmfData } from './types.ts';

const App: Component = () => {
  const [data, setData] = createSignal<CnmfData | null>(null);

  const handleClear = () => setData(null);

  return (
    <Show when={data()} fallback={<FileImport onImport={setData} />}>
      {(cnmf) => (
        <DashboardShell
          header={
            <Header
              fileName={cnmf().fileName}
              numCells={cnmf().numCells}
              numTimepoints={cnmf().numTimepoints}
              onChangeData={handleClear}
            />
          }
        >
          <VizLayout mode="scroll">
            <RankingDashboard data={cnmf()} />
          </VizLayout>
        </DashboardShell>
      )}
    </Show>
  );
};

export default App;
