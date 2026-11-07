import { parseWebAppEvent } from '../../domain/webApp';

export interface WebAppEvent {
  eventType: string;
  eventData?: unknown;
}
export interface WebAppBridgeInput {
  url: string;
  outgoing: readonly { sequence: number; event: WebAppEvent }[];
  acknowledged: (sequence: number) => void;
  receive: (event: { eventType: string; eventData: Record<string, unknown> }) => void;
}
export function connectWebApp(frame: HTMLIFrameElement, input: () => WebAppBridgeInput) {
  let previous = -1;
  const origin = new URL(input().url).origin;
  const expectedOrigin = origin === window.location.origin ? 'null' : origin;
  const receive = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== expectedOrigin) return;
    const parsed = parseWebAppEvent(event.data);
    if (parsed) input().receive(parsed);
  };
  const update = () => {
    const outgoing = input().outgoing;
    if (!outgoing.length) return;
    for (const entry of outgoing) {
      if (entry.sequence <= previous) continue;
      previous = entry.sequence;
      frame.contentWindow?.postMessage(
        JSON.stringify(entry.event),
        expectedOrigin === 'null' ? '*' : expectedOrigin,
      );
    }
    input().acknowledged(previous);
  };
  const viewport = () => input().receive({ eventType: 'web_app_request_viewport', eventData: {} });
  const theme = () => input().receive({ eventType: 'web_app_request_theme', eventData: {} });
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(viewport);
  resize?.observe(frame);
  const appearance =
    typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(theme);
  appearance?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme'],
  });
  window.addEventListener('message', receive);
  return {
    update,
    dispose: () => {
      window.removeEventListener('message', receive);
      resize?.disconnect();
      appearance?.disconnect();
    },
  };
}
export function miniAppTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  };
  return {
    bg_color: color('--panel', '#17212b'),
    secondary_bg_color: color('--surface', '#0e1621'),
    text_color: color('--ink', '#ffffff'),
    hint_color: color('--muted', '#708499'),
    link_color: color('--accent', '#6ab2f2'),
    button_color: color('--accent', '#5288c1'),
    button_text_color: '#ffffff',
  };
}
export function webAppFrameUrl(url: string, theme: Record<string, string>) {
  const parsed = new URL(url);
  const hash = new URLSearchParams(parsed.hash.slice(1));
  hash.set('tgWebAppVersion', '6.1');
  hash.set('tgWebAppPlatform', 'web');
  hash.set('tgWebAppThemeParams', JSON.stringify(theme));
  parsed.hash = hash.toString();
  return parsed.href;
}
