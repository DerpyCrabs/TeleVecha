import type { TelegramChatAppearance, TelegramBaseTheme } from '../telegram/types';
import type { AsyncResult } from 'effect/reactivity/AsyncResult';
import { available, resourceError } from 'effectweb';
import { Cause } from 'effect';

/** Export metadata only. Never put object URLs, image bytes, or DOM text here. */
export interface TvBugResourceState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  waiting: boolean;
  hasValue: boolean;
  error?: string | undefined;
  code?: string | undefined;
}

export function tvbugResourceState<A>(result: AsyncResult<A, unknown>): TvBugResourceState {
  const error = resourceError(result);
  const failure = result._tag === 'Failure' ? Cause.squash(result.cause) : undefined;
  const code =
    failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined;
  return {
    phase:
      result._tag === 'Failure'
        ? 'error'
        : result._tag === 'Success'
          ? 'ready'
          : result.waiting
            ? 'loading'
            : 'idle',
    waiting: result.waiting,
    hasValue: available(result) !== undefined,
    ...(error ? { error } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

export interface TvBugChatAppearanceState {
  peerId?: string | undefined;
  value?: TelegramChatAppearance | undefined;
  appearance: TvBugResourceState;
  wallpaper: TvBugResourceState & { byteSize?: number | undefined; mimeType?: string | undefined };
  pattern: 'none' | 'normal' | 'inverted';
  selectedBaseTheme?: TelegramBaseTheme | undefined;
  cache?:
    | {
        metadataPresent?: boolean | undefined;
        metadataAgeMs?: number | undefined;
        wallpaperPresent?: boolean | undefined;
        inspectionFailed?: boolean | undefined;
      }
    | undefined;
}

export interface TvBugRenderState {
  documentVisible: boolean;
  documentFocused: boolean;
  focusedControl: 'composer' | 'other' | 'none';
  viewport?:
    | {
        scrollTop: number;
        scrollHeight: number;
        clientHeight: number;
        clientWidth: number;
        firstVisibleMessageId?: number | undefined;
        lastVisibleMessageId?: number | undefined;
      }
    | undefined;
  wallpaper?:
    | {
        visible: boolean;
        width: number;
        height: number;
        backgroundApplied: boolean;
        maskApplied: boolean;
        opacity: number;
      }
    | undefined;
  media: Array<{
    messageId: number;
    kind: 'image' | 'video' | 'audio';
    source: 'none' | 'blob' | 'data' | 'external';
    width: number;
    height: number;
    complete?: boolean | undefined;
    naturalWidth?: number | undefined;
    naturalHeight?: number | undefined;
    readyState?: number | undefined;
    networkState?: number | undefined;
    errorCode?: number | undefined;
    paused?: boolean | undefined;
  }>;
  mediaTruncated: boolean;
}

/** Samples bounded, numeric rendering evidence; no DOM serialization or content selectors. */
export function captureTvBugRenderState(): TvBugRenderState | undefined {
  if (typeof document === 'undefined') return undefined;
  const scroller = document.querySelector<HTMLElement>('[data-testid="message-scroller"]');
  const bounds = scroller?.getBoundingClientRect();
  const visibleMessages = bounds
    ? Array.from(scroller!.querySelectorAll<HTMLElement>('article[data-message-id]')).filter(
        (element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        },
      )
    : [];
  const messageId = (element: HTMLElement | undefined) => {
    const value = element?.dataset.messageId;
    return value && /^\d+$/u.test(value) ? Number(value) : undefined;
  };
  const wallpaper = document.querySelector<HTMLElement>('.chat-wallpaper');
  const wallpaperBounds = wallpaper?.getBoundingClientRect();
  const wallpaperStyle = wallpaper && getComputedStyle(wallpaper);
  const patternStyle = wallpaper && getComputedStyle(wallpaper, '::before');
  const media: TvBugRenderState['media'] = [];
  let mediaCount = 0;
  for (const message of visibleMessages) {
    const id = messageId(message);
    if (id === undefined) continue;
    for (const element of message.querySelectorAll<HTMLImageElement | HTMLMediaElement>(
      'img, video, audio',
    )) {
      mediaCount++;
      if (media.length >= 100) continue;
      const rect = element.getBoundingClientRect();
      const source = element.getAttribute('src') ?? '';
      const entry = {
        messageId: id,
        source: (!source
          ? 'none'
          : source.startsWith('blob:')
            ? 'blob'
            : source.startsWith('data:')
              ? 'data'
              : 'external') as TvBugRenderState['media'][number]['source'],
        width: rect.width,
        height: rect.height,
      };
      media.push(
        element instanceof HTMLImageElement
          ? {
              ...entry,
              kind: 'image',
              complete: element.complete,
              naturalWidth: element.naturalWidth,
              naturalHeight: element.naturalHeight,
            }
          : {
              ...entry,
              kind: element.tagName === 'VIDEO' ? 'video' : 'audio',
              readyState: element.readyState,
              networkState: element.networkState,
              errorCode: element.error?.code,
              paused: element.paused,
            },
      );
    }
  }
  return {
    documentVisible: document.visibilityState === 'visible',
    documentFocused: document.hasFocus(),
    focusedControl: document.activeElement?.matches('textarea[aria-label="Message"]')
      ? 'composer'
      : !document.activeElement || document.activeElement === document.body
        ? 'none'
        : 'other',
    ...(scroller
      ? {
          viewport: {
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
            clientWidth: scroller.clientWidth,
            firstVisibleMessageId: messageId(visibleMessages[0]),
            lastVisibleMessageId: messageId(visibleMessages.at(-1)),
          },
        }
      : {}),
    ...(wallpaperBounds && wallpaperStyle && patternStyle
      ? {
          wallpaper: {
            visible:
              wallpaperStyle.display !== 'none' &&
              wallpaperStyle.visibility !== 'hidden' &&
              wallpaperBounds.width > 0 &&
              wallpaperBounds.height > 0,
            width: wallpaperBounds.width,
            height: wallpaperBounds.height,
            backgroundApplied: patternStyle.backgroundImage !== 'none',
            maskApplied: patternStyle.maskImage !== 'none',
            opacity: Number(patternStyle.opacity),
          },
        }
      : {}),
    media,
    mediaTruncated: mediaCount > media.length,
  };
}
