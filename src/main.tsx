import { render } from 'solid-js/web';

import { App } from './ui/app/App';
import { defaultAppEnvironment } from './ui/app/appRuntime';
import { applyThemePreferences, readThemePreferences } from './ui/theme/themePreferences';
import './styles.css';
import './ui/app/app-shell.css';
import './ui/conversation/conversation.css';
import './ui/composer/attachments.css';
import './ui/shared/styles/overlays.css';
import './ui/composer/composer.css';
import './ui/app/panels.css';
import './ui/app/chrome.css';
import './ui/app/responsive.css';
import './ui/bots/bot.css';

const root = document.querySelector<HTMLDivElement>('#root');

applyThemePreferences(readThemePreferences());

if (!root) {
  throw new Error('TeleVecha could not find its root element.');
}

const environment = defaultAppEnvironment();
render(() => <App environment={environment} />, root);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
    console.warn('TeleVecha could not register its offline application shell.', error);
  });
}
