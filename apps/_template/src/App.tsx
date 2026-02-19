import type { Component } from 'solid-js';
import { DashboardShell, CompactHeader } from '@calab/ui';

const App: Component = () => {
  return (
    <DashboardShell header={<CompactHeader title="__APP_DISPLAY_NAME__" />}>
      <p>Hello from __APP_DISPLAY_NAME__!</p>
    </DashboardShell>
  );
};

export default App;
