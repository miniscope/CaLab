import { render } from 'solid-js/web';
import App from './App.tsx';
import { configureStorageKey } from '@calab/tutorials';
import { initSession } from '@calab/community';
import { setupAnalyticsEffects } from './lib/analytics-integration.ts';
import '@calab/ui/styles/base.css';
import './styles/global.css';

configureStorageKey('cadecon-tutorial-progress-v1');

render(() => <App />, document.getElementById('root')!);

void initSession('cadecon', import.meta.env.VITE_APP_VERSION || 'dev');
setupAnalyticsEffects();
