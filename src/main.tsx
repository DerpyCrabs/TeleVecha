import { BrowserRuntime } from '@effect/platform-browser';
import { Effect } from 'effect';

import { mountApp } from './ui/app/App';
import { applyTvBugUiState, injectedTvBugBundle } from './debug/tvbugRuntime';
import { appRuntimeLayer, makeDefaultAppEnvironment } from './ui/app/appRuntime';
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

const main = Effect.scoped(
  Effect.gen(function* () {
    const root = document.querySelector<HTMLDivElement>('#root');
    if (!root) return yield* Effect.die(new Error('TeleVecha could not find its root element.'));
    yield* Effect.sync(() => {
      const tvbugBundle = injectedTvBugBundle();
      if (tvbugBundle) applyTvBugUiState(tvbugBundle.snapshot);
      applyThemePreferences(readThemePreferences());
    });
    const environment = yield* makeDefaultAppEnvironment();
    const dispose = yield* Effect.sync(() => mountApp(root, environment));
    yield* Effect.addFinalizer(dispose);
    return yield* Effect.never;
  }),
).pipe(Effect.provide(appRuntimeLayer));

BrowserRuntime.runMain(main);
