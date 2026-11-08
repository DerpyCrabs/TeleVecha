import { WidgetHost } from '@telegram/widget-sandbox/host/widget-host';
import { ShadowDomRenderer } from '@telegram/widget-sandbox/host/shadow-renderer';
import { safeExternalUrl } from '../shared/safeUrl';
import type { TelegramWidget } from '../../telegram/types';

const id = location.hash.slice(1);
const status = document.getElementById('status')!;
const target = document.getElementById('widget')!;
if (!/^[a-f0-9-]{36}$/u.test(id) || !crossOriginIsolated) {
  status.textContent = 'This widget cannot be opened in this browser.';
} else {
  const channel = new BroadcastChannel(`widget:${id}`);
  let host: WidgetHost | undefined;
  let html = '';
  let requestId = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: { result?: string | null }) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const clean = () => {
    host?.destroy();
    host = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Widget closed.'));
    }
    pending.clear();
  };
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (!event.data || typeof event.data !== 'object') return;
    const data = event.data as Record<string, unknown>;
    if (data.type === 'answer' && typeof data.id === 'number') {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timer);
      if (data.failed) request.reject(new Error('Widget request failed.'));
      else request.resolve({ result: typeof data.result === 'string' ? data.result : null });
    } else if (data.type === 'close') {
      clean();
      channel.close();
      status.textContent = 'Widget closed.';
    } else if (data.type === 'content' && data.widget && typeof data.widget === 'object') {
      const widget = data.widget as TelegramWidget;
      if (typeof widget.html !== 'string' || widget.html.length > 1024 * 1024) return;
      const state = {
        ...(widget.chatData !== undefined ? { chatData: widget.chatData } : {}),
        ...(widget.publicData !== undefined ? { publicData: widget.publicData } : {}),
      };
      if (host && html === widget.html) {
        host.setData(state);
        return;
      }
      clean();
      target.replaceChildren();
      html = widget.html;
      try {
        host = new WidgetHost(target, html, {
          theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
          locale: navigator.language,
          rendererFactory: ShadowDomRenderer.factory,
          data: state,
          context: {
            isCopy: widget.isCopy,
            canQuery: widget.canQuery,
            backgroundQuery: widget.backgroundQuery,
          },
          onRequest: (request) =>
            new Promise((resolve, reject) => {
              if (request.wallet) {
                reject(new Error('Wallet requests are unavailable.'));
                return;
              }
              const current = ++requestId;
              const timer = setTimeout(() => {
                pending.delete(current);
                reject(new Error('TIMEOUT'));
              }, 15_000);
              pending.set(current, { resolve, reject, timer });
              channel.postMessage({ type: 'query', id: current, data: request.data });
            }),
          onResize: (height) => {
            target.style.height = `${Math.max(80, Math.min(4000, height))}px`;
          },
          onAction: (action) => {
            if (action.kind === 'openLink' || action.kind === 'openTelegramLink') {
              const url = safeExternalUrl(action.url);
              if (url) window.open(url, '_blank', 'noopener,noreferrer');
            }
          },
          onLog: (level, text) => {
            if (level === 'error') console.error('Widget:', text);
          },
          onDead: (reason) => {
            console.error('Widget stopped:', reason);
            status.textContent = 'Widget stopped.';
          },
        });
        status.textContent = '';
      } catch {
        status.textContent = 'Could not start this widget.';
      }
    }
  };
  document.addEventListener('visibilitychange', () => host?.setVisible(!document.hidden));
  window.addEventListener(
    'pagehide',
    () => {
      clean();
      channel.close();
    },
    { once: true },
  );
  channel.postMessage({ type: 'ready' });
}
