import { render } from 'solid-js/web';
import App from './App.tsx';
import { configureStorageKey, configureTutorialEngine } from '@calab/tutorials';
import '@calab/ui/styles/base.css';
import '@calab/ui/styles/tutorial.css';
import './styles/global.css';
import './styles/layout.css';
import './styles/tutorial.css';

configureStorageKey('catune-tutorial-progress-v2');
configureTutorialEngine({ popoverClass: 'catune-tutorial' });

render(() => <App />, document.getElementById('root')!);
