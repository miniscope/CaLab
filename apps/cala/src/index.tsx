import { render } from 'solid-js/web';
import { configureStorageKey } from '@calab/tutorials';
import { initCommunityStore, initSession } from '@calab/community';
import App from './App.tsx';
import '@calab/ui/styles/base.css';
import '@calab/ui/styles/app-global.css';
import './styles/global.css';

// Per-app localStorage key for tutorial progress. Bump the suffix when a
// tutorial change should reset everyone's progress.
configureStorageKey(`${__APP_ID__}-tutorial-progress-v1`);

// Start the single shared auth subscription before the first render.
initCommunityStore();

render(() => <App />, document.getElementById('root')!);

// Anonymous usage analytics; a no-op when Supabase is not configured.
void initSession(__APP_ID__, import.meta.env.VITE_APP_VERSION || 'dev');
