import { Effect } from 'effect';
import { mountView } from 'effectweb';
import type { AppEnvironment } from './appRuntime';
import { AppView } from './AppView';
import { createAppController } from './appController';

export function mountApp(root: Element, environment: AppEnvironment) {
  const source = createAppController({ environment });
  try {
    const unmount = mountView(root, AppView, source);
    return () => unmount.close().pipe(Effect.ensuring(Effect.sync(() => source.dispose())));
  } catch (error) {
    source.dispose();
    throw error;
  }
}
