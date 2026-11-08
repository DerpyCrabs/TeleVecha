import { domBinding } from 'effectweb';
import { Effect } from 'effect';
import type { ChatFoldersApi } from '../../telegram/chatFolders';
interface Input {
  api: ChatFoldersApi;
  reload: () => void;
  enabled: boolean;
}
function acquireFolders(_root: HTMLElement, input: () => Input) {
  let disposed = false;
  let wasEnabled = false;
  let unsubscribe: Effect.Effect<void> | undefined;
  const refresh = () => {
    if (input().enabled && document.visibilityState === 'visible') input().reload();
  };
  const update = () => {
    const enabled = input().enabled;
    const changed = enabled && !wasEnabled;
    wasEnabled = enabled;
    if (changed) refresh();
  };
  update();
  void Effect.runPromise(
    input().api.subscribeResources((event) => {
      if (event.kind === 'chat-folders') refresh();
    }),
  )
    .then((cleanup) => {
      if (disposed) void Effect.runPromise(cleanup).catch(() => undefined);
      else unsubscribe = cleanup;
    })
    .catch(() => undefined);
  window.addEventListener('focus', refresh);
  return {
    update,
    dispose: () => {
      disposed = true;
      window.removeEventListener('focus', refresh);
      if (unsubscribe) void Effect.runPromise(unsubscribe).catch(() => undefined);
    },
  };
}
export const folderSubscription = (api: ChatFoldersApi, reload: () => void, enabled = true) =>
  domBinding({ api, reload, enabled }, acquireFolders);
