// Public integration surface of the pinned upstream widget-sandbox v0.6.0.
// Its source package ships TypeScript with a less strict compiler configuration.
declare module '@telegram/widget-sandbox/vite' {
  import type { Plugin } from 'vite';
  export function widgetSandbox(): Plugin;
}
declare module '@telegram/widget-sandbox/host/shadow-renderer' {
  export const ShadowDomRenderer: { factory: unknown };
}
declare module '@telegram/widget-sandbox/host/widget-host' {
  export class WidgetHost {
    constructor(
      element: HTMLElement,
      html: string,
      options: {
        theme: 'light' | 'dark';
        locale?: string;
        rendererFactory?: unknown;
        data?: { chatData?: string; publicData?: string };
        context?: {
          isCopy?: boolean;
          canQuery?: boolean;
          backgroundQuery?: boolean;
          chatType?: 'private' | 'group' | 'supergroup' | 'channel';
        };
        onRequest?: (request: {
          data: string;
          wallet?: boolean;
        }) => Promise<{ result?: string | null }>;
        onResize?: (height: number) => void;
        onAction?: (action: { kind: string; url?: string }) => void;
        onLog?: (level: string, text: string) => void;
        onDead?: (reason: string) => void;
      },
    );
    setVisible(visible: boolean): void;
    setData(data: { chatData?: string; publicData?: string }): void;
    destroy(): void;
  }
}
