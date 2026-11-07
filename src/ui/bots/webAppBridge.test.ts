import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectWebApp, webAppFrameUrl, type WebAppBridgeInput } from './webAppBridge';
afterEach(() => vi.unstubAllGlobals());
describe('Mini App bridge', () => {
  it('accepts events only from the launched frame and exact origin, then detaches on close', () => {
    const host = new EventTarget();
    vi.stubGlobal('window', Object.assign(host, { location: { origin: 'https://client.test' } }));
    const contentWindow = { postMessage: vi.fn() };
    const receive = vi.fn();
    const binding = connectWebApp({ contentWindow } as unknown as HTMLIFrameElement, () => ({
      url: 'https://mini.test/app',
      outgoing: [],
      acknowledged: () => {},
      receive,
    }));
    const dispatch = (source: unknown, origin: string, data: unknown) =>
      host.dispatchEvent(Object.assign(new Event('message'), { source, origin, data }));
    dispatch({}, 'https://mini.test', '{"eventType":"web_app_close"}');
    dispatch(contentWindow, 'https://evil.test', '{"eventType":"web_app_close"}');
    dispatch(contentWindow, 'https://mini.test', '{');
    expect(receive).not.toHaveBeenCalled();
    dispatch(contentWindow, 'https://mini.test', '{"eventType":"web_app_ready"}');
    expect(receive).toHaveBeenCalledOnce();
    binding.dispose();
    dispatch(contentWindow, 'https://mini.test', '{"eventType":"web_app_close"}');
    expect(receive).toHaveBeenCalledOnce();
  });
  it('delivers every response in a render batch without duplicating acknowledged events', () => {
    const host = new EventTarget();
    vi.stubGlobal('window', Object.assign(host, { location: { origin: 'https://client.test' } }));
    const postMessage = vi.fn();
    const input: WebAppBridgeInput = {
      url: 'https://mini.test/app',
      outgoing: [
        { sequence: 1, event: { eventType: 'theme_changed' } },
        { sequence: 2, event: { eventType: 'viewport_changed' } },
      ],
      receive: () => {},
      acknowledged: vi.fn(),
    };
    const binding = connectWebApp(
      { contentWindow: { postMessage } } as unknown as HTMLIFrameElement,
      () => input,
    );
    binding.update();
    binding.update();
    expect(postMessage.mock.calls).toEqual([
      [JSON.stringify({ eventType: 'theme_changed' }), 'https://mini.test'],
      [JSON.stringify({ eventType: 'viewport_changed' }), 'https://mini.test'],
    ]);
    binding.dispose();
  });
  it('preserves Telegram authorization parameters while adding client capabilities', () => {
    const url = new URL(
      webAppFrameUrl('https://mini.test/#tgWebAppData=secret%26signature', { bg_color: '#ffffff' }),
    );
    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.get('tgWebAppData')).toBe('secret&signature');
    expect(params.get('tgWebAppPlatform')).toBe('web');
    expect(JSON.parse(params.get('tgWebAppThemeParams')!)).toEqual({ bg_color: '#ffffff' });
  });
});
