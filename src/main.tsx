import { render } from 'solid-js/web';

import { App } from './ui/App';
import './styles.css';
import './bot.css';

const root = document.querySelector<HTMLDivElement>('#root');

if (!root) {
  throw new Error('TeleVecha could not find its root element.');
}

render(() => <App />, root);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
    console.warn('TeleVecha could not register its offline application shell.', error);
  });
}
