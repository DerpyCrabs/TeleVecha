import { domBinding } from 'effectweb';
import { Effect } from 'effect';
import type { EffectMessagingClient } from '../../telegram/core/client';
import type { TelegramConversationEvent } from '../../telegram/types';
interface Input {
  api: EffectMessagingClient;
  enabled: boolean;
  online: boolean;
  canLoad: boolean;
  start: () => void;
  more: () => void;
  event: (event: TelegramConversationEvent) => void;
}
function acquire(element: HTMLElement, read: () => Input) {
  let disposed = false;
  let near = false;
  let key = '';
  let cleanup: Effect.Effect<void> | undefined;
  const load = () => {
    if (!disposed && near && read().enabled && read().canLoad) read().more();
  };
  const observer = new IntersectionObserver(
    (entries) => {
      near = Boolean(entries[0]?.isIntersecting);
      load();
    },
    { root: element.closest('[data-testid="message-scroller"]'), rootMargin: '120px 0px 0px' },
  );
  observer.observe(element);
  const update = () => {
    const next = `${read().enabled}:${read().online}`;
    if (next !== key) {
      key = next;
      if (read().enabled) read().start();
    }
    load();
  };
  void Effect.runPromise(
    read().api.subscribeConversationEvents((event) => {
      if (!disposed) read().event(event);
    }),
  )
    .then((release) => {
      if (disposed) void Effect.runPromise(release).catch(() => undefined);
      else cleanup = release;
    })
    .catch(() => undefined);
  update();
  return {
    update,
    dispose: () => {
      disposed = true;
      observer.disconnect();
      if (cleanup) void Effect.runPromise(cleanup).catch(() => undefined);
    },
  };
}
export const earlierHistoryBinding = (input: Input) => domBinding(input, acquire);
