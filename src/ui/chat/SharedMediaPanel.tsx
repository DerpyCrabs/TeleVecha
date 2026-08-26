import ExternalLink from 'lucide-solid/icons/external-link';
import FileText from 'lucide-solid/icons/file-text';
import Link from 'lucide-solid/icons/link';
import X from 'lucide-solid/icons/x';
import { For, Show, createEffect, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';

import type { SharedMediaKind, TelegramMessage, TelegramSearchPage } from '../../telegram/types';
import { MediaAttachment } from '../media/MediaAttachment';
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

const labels: Record<SharedMediaKind, string> = { media: 'Media', files: 'Files', links: 'Links' };

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

  createEffect(() => {
    void props.initialKind;
    setItems([]);
    setHasMore(false);
    setNextOffset(undefined);
    void loadItems(false);
  });
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
          class="shared-panel"
          role="dialog"
          aria-modal="true"
          aria-label={`Shared ${props.initialKind}`}
        >
          <header>
            <strong>{labels[props.initialKind]}</strong>
            <button onClick={props.close} aria-label={`Close shared ${props.initialKind}`}>
              <X size={18} />
            </button>
          </header>
          <div class={`shared-items shared-${props.initialKind}`}>
            <Show when={!loading()} fallback={<p>Loading {props.initialKind}…</p>}>
              <For
                each={items()}
                fallback={
                  <Show when={error()} fallback={<p>{`No shared ${props.initialKind}`}</p>}>
                    <div class="panel-error" role="alert">
                      <p>{error()}</p>
                      <button onClick={() => void loadItems(false)}>Retry</button>
                    </div>
                  </Show>
                }
              >
                {(message) => (
                  <Show
                    when={props.initialKind === 'media'}
                    fallback={
                      <Show
                        when={props.initialKind === 'files'}
                        fallback={
                          <article class="shared-link-row">
                            <span class="shared-kind-icon">
                              <Link size={18} />
                            </span>
                            <div>
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
                              onClick={() => props.openMessage(message)}
                              aria-label="Go to linked message"
                            >
                              <ExternalLink size={16} />
                            </button>
                          </article>
                        }
                      >
                        <article class="shared-file-row">
                          <span class="shared-kind-icon">
                            <FileText size={20} />
                          </span>
                          <div>
                            <strong>{message.media?.name}</strong>
                            <small>
                              {[fileSize(message.media?.size), message.media?.mimeType]
                                .filter(Boolean)
                                .join(' · ')}
                            </small>
                            <time>{messageTime(message)}</time>
                          </div>
                          <button
                            onClick={() => props.openMessage(message)}
                            aria-label="Go to file message"
                          >
                            <ExternalLink size={16} />
                          </button>
                        </article>
                      </Show>
                    }
                  >
                    <article class="shared-media-tile">
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
                <div class="panel-error" role="alert">
                  <p>{error()}</p>
                  <button onClick={() => void loadItems(true)}>Retry loading more</button>
                </div>
              </Show>
              <Show when={hasMore() && !error()}>
                <button
                  class="panel-load-more"
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
