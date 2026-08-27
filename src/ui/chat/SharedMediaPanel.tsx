import ExternalLink from 'lucide-solid/icons/external-link';
import FileText from 'lucide-solid/icons/file-text';
import Link from 'lucide-solid/icons/link';
import X from 'lucide-solid/icons/x';
import { For, Show, createSignal, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';

import type { SharedMediaKind, TelegramMessage, TelegramSearchPage } from '../../telegram/types';
import { MediaAttachment } from '../media/MediaAttachment';
import {
  panelClass,
  panelCloseButtonClass,
  panelErrorClass,
  panelHeaderClass,
  panelLoadMoreClass,
} from '../shared/panelStyles';
import { safeExternalUrl } from '../shared/safeUrl';
import { useModalDialog } from '../shared/useModalDialog';

interface SharedMediaPanelProps {
  initialKind: SharedMediaKind;
  loadItems: (
    kind: SharedMediaKind,
    offset?: TelegramSearchPage['nextOffset'],
  ) => Promise<TelegramSearchPage>;
  loadMedia: (message: TelegramMessage) => Promise<string>;
  cachedMedia: (message: TelegramMessage) => string | undefined;
  openMessage: (message: TelegramMessage) => void;
  close: () => void;
}

const labels: Record<SharedMediaKind, string> = {
  photos: 'Photos',
  videos: 'Videos',
  files: 'Files',
  audio: 'Audio files',
  links: 'Shared links',
  voice: 'Voice messages',
  gifs: 'GIFs',
};
const visualKinds = new Set<SharedMediaKind>(['photos', 'videos', 'gifs']);

function messageTime(message: TelegramMessage) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(message.date * 1000),
  );
}

function fileSize(size?: number) {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

export function SharedMediaPanel(props: SharedMediaPanelProps) {
  const [items, setItems] = createSignal<TelegramMessage[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [hasMore, setHasMore] = createSignal(false);
  const [nextOffset, setNextOffset] = createSignal<TelegramSearchPage['nextOffset']>();
  const [error, setError] = createSignal('');
  let overlay: HTMLDivElement | undefined;
  let loadVersion = 0;
  useModalDialog(() => overlay, props.close);

  const loadItems = async (append: boolean) => {
    const version = ++loadVersion;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError('');
    try {
      const page = await props.loadItems(props.initialKind, append ? nextOffset() : undefined);
      if (version !== loadVersion) return;
      setItems((current) => {
        if (!append) return page.messages;
        const known = new Set(current.map(({ peerId, id }) => `${peerId}:${id}`));
        return [
          ...current,
          ...page.messages.filter(({ peerId, id }) => !known.has(`${peerId}:${id}`)),
        ];
      });
      setNextOffset(page.nextOffset);
      setHasMore(page.hasMore && Boolean(page.nextOffset));
    } catch (cause) {
      if (version === loadVersion) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === loadVersion) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  onMount(() => void loadItems(false));
  const links = (text: string) => [...text.matchAll(/https?:\/\/[^\s]+/gu)].map(([url]) => url);

  return (
    <Portal>
      <div
        ref={(element) => (overlay = element)}
        class="panel-overlay"
        role="presentation"
        tabIndex={-1}
        onPointerDown={(event) => event.target === event.currentTarget && props.close()}
      >
        <section
          class={`shared-panel ${panelClass}`}
          role="dialog"
          aria-modal="true"
          aria-label={`Shared ${props.initialKind}`}
        >
          <header class={panelHeaderClass}>
            <strong>{labels[props.initialKind]}</strong>
            <button
              class={panelCloseButtonClass}
              onClick={props.close}
              aria-label={`Close shared ${props.initialKind}`}
            >
              <X size={18} />
            </button>
          </header>
          <div
            class="shared-items min-h-40 overflow-y-auto px-[0.8rem] pt-[0.4rem] pb-[0.8rem]"
            classList={{
              'shared-media grid grid-cols-3 gap-2': visualKinds.has(props.initialKind),
              [`shared-${props.initialKind}`]: !visualKinds.has(props.initialKind),
            }}
          >
            <Show
              when={!loading()}
              fallback={<p class="text-[0.78rem] text-muted">Loading {props.initialKind}…</p>}
            >
              <For
                each={items()}
                fallback={
                  <Show
                    when={error()}
                    fallback={
                      <p class="text-[0.78rem] text-muted">{`No shared ${props.initialKind}`}</p>
                    }
                  >
                    <div class={`panel-error ${panelErrorClass}`} role="alert">
                      <p>{error()}</p>
                      <button onClick={() => void loadItems(false)}>Retry</button>
                    </div>
                  </Show>
                }
              >
                {(message) => (
                  <Show
                    when={visualKinds.has(props.initialKind)}
                    fallback={
                      <Show
                        when={props.initialKind === 'links'}
                        fallback={
                          <article class="shared-file-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-[0.35rem] py-3">
                            <span class="shared-kind-icon grid size-10 place-items-center rounded-[0.55rem] bg-white/[0.055] text-muted">
                              <FileText size={20} />
                            </span>
                            <div class="grid min-w-0 gap-[0.18rem] [&_small]:text-[0.68rem] [&_small]:text-muted [&_time]:text-[0.68rem] [&_time]:text-muted">
                              <strong>{message.media?.name}</strong>
                              <small>
                                {[fileSize(message.media?.size), message.media?.mimeType]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </small>
                              <time>{messageTime(message)}</time>
                            </div>
                            <button
                              class="grid size-8 place-items-center rounded-full border-0 bg-transparent text-muted"
                              onClick={() => props.openMessage(message)}
                              aria-label="Go to file message"
                            >
                              <ExternalLink size={16} />
                            </button>
                          </article>
                        }
                      >
                        <article class="shared-link-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-[0.35rem] py-3">
                          <span class="shared-kind-icon grid size-10 place-items-center rounded-[0.55rem] bg-white/[0.055] text-muted">
                            <Link size={18} />
                          </span>
                          <div class="grid min-w-0 gap-[0.18rem] [&_a]:truncate [&_a]:text-blue-300 [&_time]:text-[0.68rem] [&_time]:text-muted">
                            <For each={links(message.text)}>
                              {(url) => {
                                const href = safeExternalUrl(url);
                                return href ? (
                                  <a href={href} target="_blank" rel="noopener noreferrer">
                                    {url}
                                  </a>
                                ) : (
                                  <span>{url}</span>
                                );
                              }}
                            </For>
                            <time>{messageTime(message)}</time>
                          </div>
                          <button
                            class="grid size-8 place-items-center rounded-full border-0 bg-transparent text-muted"
                            onClick={() => props.openMessage(message)}
                            aria-label="Go to linked message"
                          >
                            <ExternalLink size={16} />
                          </button>
                        </article>
                      </Show>
                    }
                  >
                    <article class="shared-media-tile relative min-h-36 overflow-hidden rounded-[0.65rem] bg-[#0e1115] [&_.media-attachment]:m-0 [&_.media-attachment]:h-full [&_.media-attachment]:min-h-36 [&_.media-attachment]:w-full [&_.media-attachment]:rounded-[inherit] [&_.media-visual]:h-full [&_.media-visual]:min-h-36 [&_.media-visual]:max-h-52 [&_.media-visual]:w-full [&_.media-visual]:rounded-[inherit] [&_.media-visual]:object-cover [&_img]:h-full [&_img]:min-h-36 [&_img]:max-h-52 [&_img]:w-full [&_img]:rounded-[inherit] [&_img]:object-cover [&_video]:h-full [&_video]:min-h-36 [&_video]:max-h-52 [&_video]:w-full [&_video]:rounded-[inherit] [&_video]:object-cover">
                      <Show when={message.media}>
                        {(media) => (
                          <MediaAttachment
                            media={media()}
                            load={() => props.loadMedia(message)}
                            cachedUrl={() => props.cachedMedia(message)}
                            compact
                          />
                        )}
                      </Show>
                      <button
                        class="absolute right-[0.35rem] bottom-[0.35rem] flex items-center gap-[0.3rem] rounded-[0.35rem] border-0 bg-black/70 px-[0.4rem] py-1 text-[0.64rem] text-white"
                        onClick={() => props.openMessage(message)}
                        aria-label={`Go to media message ${message.media?.name ?? ''} from ${messageTime(message)}`}
                      >
                        <time>{messageTime(message)}</time>
                        <ExternalLink size={14} />
                      </button>
                    </article>
                  </Show>
                )}
              </For>
              <Show when={items().length > 0 && error()}>
                <div class={`panel-error ${panelErrorClass}`} role="alert">
                  <p>{error()}</p>
                  <button onClick={() => void loadItems(true)}>Retry loading more</button>
                </div>
              </Show>
              <Show when={hasMore() && !error()}>
                <button
                  class={`panel-load-more ${panelLoadMoreClass}`}
                  disabled={loadingMore()}
                  onClick={() => void loadItems(true)}
                >
                  {loadingMore() ? 'Loading more…' : 'Load more'}
                </button>
              </Show>
            </Show>
          </div>
        </section>
      </div>
    </Portal>
  );
}
