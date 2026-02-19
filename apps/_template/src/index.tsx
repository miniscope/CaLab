import { render } from 'solid-js/web';
import App from './App.tsx';
import '@catune/ui/styles/base.css';
import './styles/global.css';

render(() => <App />, document.getElementById('root')!);
