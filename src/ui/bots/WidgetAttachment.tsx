import { domBinding, view } from 'effectweb';
import type { TelegramWidget } from '../../telegram/types';

interface WidgetProps {
  widget: TelegramWidget;
  query?: ((data: string) => Promise<string | undefined>) | undefined;
}
function bindWidget(button: HTMLButtonElement, read: () => WidgetProps) {
  let channel: BroadcastChannel | undefined;
  let inFlight = false;
  const update = () => channel?.postMessage({ type: 'content', widget: read().widget });
  const close = () => {
    channel?.postMessage({ type: 'close' });
    channel?.close();
    channel = undefined;
  };
  const open = () => {
    close();
    const id = crypto.randomUUID();
    const current = new BroadcastChannel(`widget:${id}`);
    channel = current;
    current.onmessage = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== 'object') return;
      const value = event.data as Record<string, unknown>;
      if (value.type === 'ready') update();
      if (value.type !== 'query' || typeof value.id !== 'number' || typeof value.data !== 'string')
        return;
      const query = read().query;
      if (
        inFlight ||
        !read().widget.canQuery ||
        !query ||
        new TextEncoder().encode(value.data).length > 64
      ) {
        current.postMessage({ type: 'answer', id: value.id, failed: true });
        return;
      }
      inFlight = true;
      void query(value.data)
        .then(
          (result) => {
            if (channel === current) current.postMessage({ type: 'answer', id: value.id, result });
          },
          () => {
            if (channel === current)
              current.postMessage({ type: 'answer', id: value.id, failed: true });
          },
        )
        .finally(() => {
          inFlight = false;
        });
    };
    const popup = window.open(`/widget.html#${id}`, '_blank', 'width=460,height=640');
    if (!popup) {
      close();
      button.textContent = 'Allow pop-ups to open this widget';
    }
  };
  button.addEventListener('click', open);
  return {
    update,
    dispose: () => {
      close();
      button.removeEventListener('click', open);
    },
  };
}
export const WidgetAttachment = view<WidgetProps, never>((props) => (
  <button
    type="button"
    class="message-widget"
    disabled={!props.widget.html}
    use={domBinding(props, bindWidget)}
  >
    {props.widget.html ? 'Open interactive widget' : 'Widget unavailable'}
  </button>
));
