import { render } from 'solid-js/web';
import App from './App.tsx';
import '@catune/ui/styles/tokens.css';
import '@catune/ui/styles/reset.css';
import '@catune/ui/styles/buttons.css';
import '@catune/ui/styles/components.css';
import '@catune/ui/styles/animations.css';
import '@catune/ui/styles/layout.css';
import './styles/global.css';

render(() => <App />, document.getElementById('root')!);
