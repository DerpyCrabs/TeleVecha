import { domBinding } from 'effectweb';
import { Effect } from 'effect';
import type { EffectMessagingClient } from '../../telegram/core/client';
import type { TelegramResourceKind } from '../../telegram/types';
interface Input {
  api: Pick<EffectMessagingClient, 'subscribeResources'>;
  peerId: string;
  kind: TelegramResourceKind;
  online: boolean;
  reload: () => void;
}
function acquire(_root: HTMLElement, input: () => Input) {
  let disposed = false;
  let key = '';
  let unsubscribe: Effect.Effect<void> | undefined;
  const refresh = () => {
    if (!disposed && input().online) input().reload();
  };
  const update = () => {
    const next = `${input().peerId}:${input().kind}:${input().online}`;
    if (key !== next) {
      key = next;
      refresh();
    }
  };
  update();
  void Effect.runPromise(
    input().api.subscribeResources((event) => {
      if (event.peerId === input().peerId && event.kind === input().kind) refresh();
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
export const groupResourceSubscription = (input: Input) => domBinding(input, acquire);
