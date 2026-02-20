import type { Component } from 'solid-js';
import { Show, createSignal } from 'solid-js';
import { DashboardShell, VizLayout, TutorialPanel } from '@calab/ui';
import { startTutorial } from '@calab/tutorials';
import { Header } from './components/Header.tsx';
import { AuthCallback } from './components/AuthCallback.tsx';
import { FileImport } from './components/FileImport.tsx';
import { RankingDashboard } from './components/RankingDashboard.tsx';
import { tutorials } from './tutorials/index.ts';
import type { CnmfData } from './types.ts';

function isAuthCallback(): boolean {
  const hash = window.location.hash;
  return hash.includes('access_token=') || hash.includes('token_hash=');
}

const App: Component = () => {
  if (isAuthCallback()) {
    return <AuthCallback />;
  }

  const [data, setData] = createSignal<CnmfData | null>(null);
  const [tutorialOpen, setTutorialOpen] = createSignal(false);

  const handleClear = () => setData(null);

  return (
    <>
      <Show when={tutorialOpen()}>
        <TutorialPanel
          tutorials={tutorials}
          onStartTutorial={startTutorial}
          onClose={() => setTutorialOpen(false)}
        />
      </Show>

      <Show when={data()} fallback={<FileImport onImport={setData} />}>
        {(cnmf) => (
          <DashboardShell
            header={
              <Header
                fileName={cnmf().fileName}
                numCells={cnmf().numCells}
                numTimepoints={cnmf().numTimepoints}
                onChangeData={handleClear}
                tutorialOpen={tutorialOpen}
                onTutorialToggle={() => setTutorialOpen((prev) => !prev)}
              />
            }
          >
            <VizLayout mode="scroll">
              <RankingDashboard data={cnmf()} />
            </VizLayout>
          </DashboardShell>
        )}
      </Show>
    </>
  );
};

export default App;
