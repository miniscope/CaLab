import { render } from 'solid-js/web';
import App from './App.tsx';
import { initCommunityStore } from '@calab/community';
import '@calab/ui/styles/base.css';
import './styles/global.css';
import { initTheme } from './lib/theme.ts';

initTheme();

// Start the single shared auth subscription before the first render.
initCommunityStore();

render(() => <App />, document.getElementById('root')!);
