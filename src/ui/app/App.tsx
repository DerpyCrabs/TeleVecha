import { Effect } from 'effect';
import { mount } from 'effectweb';
import type { AppEnvironment } from './appRuntime';
import { AppView } from './AppView';
import { createAppController } from './appController';

export const mountApp = Effect.fn('mountApp')(function* (
  root: Element,
  environment: AppEnvironment,
) {
  const source = yield* createAppController({ environment });
  yield* Effect.addFinalizer(() => Effect.sync(() => source.dispose()));
  return yield* mount(root, AppView, source);
});
