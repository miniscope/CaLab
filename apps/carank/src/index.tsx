import { render } from 'solid-js/web';
import App from './App.tsx';
import { configureStorageKey } from '@calab/tutorials';
import { initSession, registerSessionEndListeners } from '@calab/community';
import '@calab/ui/styles/base.css';
import '@calab/ui/styles/tutorial.css';
import './styles/global.css';

configureStorageKey('carank-tutorial-progress-v1');

render(() => <App />, document.getElementById('root')!);

void initSession('carank', import.meta.env.VITE_APP_VERSION || 'dev');
registerSessionEndListeners();
