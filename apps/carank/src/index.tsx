import { render } from 'solid-js/web';
import App from './App.tsx';
import { configureStorageKey } from '@calab/tutorials';
import { initCommunityStore, initSession } from '@calab/community';
import '@calab/ui/styles/base.css';
import '@calab/ui/styles/tutorial.css';
import './styles/global.css';

configureStorageKey('carank-tutorial-progress-v1');

// Start the single shared auth subscription before the first render.
initCommunityStore();

render(() => <App />, document.getElementById('root')!);

void initSession(__APP_ID__, import.meta.env.VITE_APP_VERSION || 'dev');
