import { domBinding } from 'effectweb';
import { Effect } from 'effect';
import type { EffectMessagingClient } from '../../telegram/core/client';
interface Input {
  api: EffectMessagingClient;
  peerId: string;
  reload: () => void;
  deleted: (id: number) => void;
  online: boolean;
}
function setup(_root: HTMLElement, read: () => Input) {
  let disposed = false;
  let key = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanups: Effect.Effect<void>[] = [];
  const refresh = () => {
    if (!disposed && read().online) read().reload();
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  };
  const update = () => {
    const next = `${read().peerId}:${read().online}`;
    if (next !== key) {
      key = next;
      refresh();
    }
  };
  update();
  for (const subscribe of [
    read().api.subscribeResources((event) => {
      if (event.kind === 'forum-topics' && event.peerId === read().peerId) {
        if (event.queryId?.startsWith('deleted:')) read().deleted(Number(event.queryId.slice(8)));
        schedule();
      }
    }),
    read().api.subscribeConversationEvents((event) => {
      const peerId = event.type === 'message-upsert' ? event.message.peerId : event.peerId;
      if (peerId === read().peerId) schedule();
    }),
  ])
    void Effect.runPromise(subscribe)
      .then((cleanup) => {
        if (disposed) void Effect.runPromise(cleanup).catch(() => undefined);
        else cleanups.push(cleanup);
      })
      .catch(() => undefined);
  window.addEventListener('focus', refresh);
  return {
    update,
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      for (const cleanup of cleanups) void Effect.runPromise(cleanup).catch(() => undefined);
    },
  };
}
export const topicSubscription = (input: Input) => domBinding(input, setup);
