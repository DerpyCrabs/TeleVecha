import { list as renderList } from 'effectweb';
import { commandSlot } from 'effectweb';
import { cachedLoad } from 'effectweb/load';
import { actionCommand, effectCommand } from 'effectweb/program';
import { Effect } from 'effect';
import type {
  SharedMediaKind,
  TelegramDialog,
  TelegramMessage,
  TelegramSearchPage,
  TelegramTransferProgress,
} from '../../telegram/types';
import ExternalLink from '@effectweb/lucide/icons/external-link';
import FileText from '@effectweb/lucide/icons/file-text';
import Link from '@effectweb/lucide/icons/link';
import X from '@effectweb/lucide/icons/x';
import type { MediaPreview } from '../media/MediaAttachment';
import { MediaAttachment } from '../media/MediaAttachment';
import { MediaViewer } from '../media/MediaViewer';
import { saveMediaUrl } from '../media/mediaActions';
import { mediaPresentation } from '../media/mediaPresentation';
import {
  available,
  collection,
  component,
  pages,
  Portal,
  resourceError,
  sequence,
  view,
  type PagesMessage,
  type PagesModel,
} from 'effectweb';
import type { UiLoad } from 'effectweb/cache';
import { loadEffect } from 'effectweb/cache';
import { modalMount } from '../shared/modalMount';
import {
  panelClass,
  panelCloseButtonClass,
  panelErrorClass,
  panelHeaderClass,
  panelLoadMoreClass,
} from '../shared/panelStyles';
import { safeExternalUrl } from '../shared/safeUrl';
import { messageCapabilities } from '../../telegram/core/chatPermissions';
const commandViewer = commandSlot('viewer');
const commandDownload = commandSlot('download');

interface SharedMediaPanelProps {
  initialKind: SharedMediaKind;
  peerId: string;
  loadItems: (
    kind: SharedMediaKind,
    offset?: TelegramSearchPage['nextOffset'],
  ) => UiLoad<TelegramSearchPage>;
  loadMedia: (
    message: TelegramMessage,
    progress?: TelegramTransferProgress,
  ) => Effect.Effect<string, unknown>;
  loadMediaPreview: (message: TelegramMessage) => Effect.Effect<string, unknown>;
  cachedMedia: (message: TelegramMessage) => string | undefined;
  cachedMediaPreview: (message: TelegramMessage) => string | undefined;
  openMessage: (message: TelegramMessage) => void;
  forwardMessage?: ((message: TelegramMessage) => void) | undefined;
  dialogs: readonly TelegramDialog[];
  deleteMessage?: ((message: TelegramMessage) => void) | undefined;
  close: () => void;
}
interface SharedMediaContentProps extends SharedMediaPanelProps {
  items: TelegramMessage[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string;
  loadPage: (append: boolean) => void;
}
const telegramMessageRows = collection<TelegramMessage>(
  (message) => `${message.peerId}:${message.id}`,
).from;
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
type SharedMediaContentModel = {
  props: SharedMediaContentProps;
  viewer: { index: number; preview: MediaPreview; loading: boolean } | undefined;
};
type SharedMediaContentMessage =
  | { type: 'Navigate'; index: number }
  | { type: 'Download'; message: TelegramMessage }
  | { type: 'OpenFile'; message: TelegramMessage; origin: DOMRect }
  | {
      type: 'Viewer';
      value: { index: number; preview: MediaPreview; loading: boolean } | undefined;
    };
const SharedMediaContent = component<
  SharedMediaContentProps,
  SharedMediaContentModel,
  SharedMediaContentMessage
>({
  init: (props) => ({ props, viewer: undefined }),
  identity: (props) => JSON.stringify([props.peerId, props.initialKind]),
  update: (model, message) => {
    switch (message.type) {
      case 'Navigate': {
        const selected = model.props.items.filter(
          (item) => item.media && mediaPresentation(item.media).preview === 'image',
        )[message.index];
        if (!model.viewer || model.viewer.loading || !selected?.media) return { model };
        const current = model.viewer,
          media = selected.media;
        return {
          model: { ...model, viewer: { ...current, loading: true } },
          commands: [
            effectCommand(
              commandViewer,
              () =>
                cachedLoad(
                  () => model.props.cachedMedia(selected),
                  () => model.props.loadMedia(selected),
                ),
              {
                policy: 'replace',
                onSuccess: (url): SharedMediaContentMessage => ({
                  type: 'Viewer',
                  value: {
                    index: message.index,
                    loading: false,
                    preview: { kind: 'image', name: media.name, url },
                  },
                }),
                onFailure: (): SharedMediaContentMessage => ({ type: 'Viewer', value: current }),
              },
            ),
          ],
        };
      }
      case 'Download': {
        const item = message.message;
        if (!item.media || item.protected) return { model };
        const name = item.media.name;
        return {
          model,
          commands: [
            actionCommand(
              commandDownload,
              () =>
                cachedLoad(
                  () => model.props.cachedMedia(item),
                  () => model.props.loadMedia(item),
                ).pipe(Effect.tap((url) => Effect.sync(() => saveMediaUrl(url, name)))),
              'replace',
            ),
          ],
        };
      }
      case 'OpenFile': {
        const item = message.message;
        if (!item.media || mediaPresentation(item.media).preview !== 'image') return { model };
        const name = item.media.name,
          index = model.props.items
            .filter((item) => item.media && mediaPresentation(item.media).preview === 'image')
            .findIndex((candidate) => candidate.id === item.id);
        return {
          model,
          commands: [
            effectCommand(
              commandViewer,
              () =>
                cachedLoad(
                  () => model.props.cachedMedia(item),
                  () => model.props.loadMedia(item),
                ),
              {
                policy: 'replace',
                onSuccess: (url): SharedMediaContentMessage => ({
                  type: 'Viewer',
                  value: {
                    index: Math.max(0, index),
                    loading: false,
                    preview: { kind: 'image', name, url, origin: message.origin },
                  },
                }),
                onFailure: (): SharedMediaContentMessage => ({
                  type: 'Viewer',
                  value: model.viewer,
                }),
              },
            ),
          ],
        };
      }
      case 'Viewer':
        return {
          cancel: message.value ? [] : [commandViewer],
          model: { ...model, viewer: message.value },
        };
    }
  },
  view: view((model, send) => {
    const props = model.props;
    const capabilities = (message: TelegramMessage) => {
      const dialog = props.dialogs.find((dialog) => dialog.peer.id === message.peerId);
      return dialog ? messageCapabilities(dialog, message) : undefined;
    };
    const items = () => props.items;
    const loading = () => props.loading;
    const loadingMore = () => props.loadingMore;
    const hasMore = () => props.hasMore;
    const error = () => props.error;
    const loadItems = (append: boolean) => props.loadPage(append);
    const links = (text: string) => [...text.matchAll(/https?:\/\/[^\s]+/gu)].map(([url]) => url);
    const previewableItems = () =>
      items().filter(
        (message) => message.media && mediaPresentation(message.media).preview === 'image',
      );
    const openPreview = (message: TelegramMessage, preview: MediaPreview) => {
      if (preview.kind !== 'image') return false;
      const index = previewableItems().findIndex(({ id }) => id === message.id);
      send({ type: 'Viewer', value: { index: Math.max(0, index), preview, loading: false } });
      return true;
    };
    const navigatePreview = (index: number) => send({ type: 'Navigate', index });
    const downloadMessage = (message: TelegramMessage) => send({ type: 'Download', message });
    const openFilePreview = (message: TelegramMessage, origin: HTMLElement) =>
      send({ type: 'OpenFile', message, origin: origin.getBoundingClientRect() });
    return (
      <Portal>
        <div
          use={modalMount(props.close)}
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
              {!loading() ? (
                <>
                  {items()!.length ? (
                    renderList(telegramMessageRows(items()), (message) =>
                      visualKinds.has(props.initialKind) ? (
                        <article class="shared-media-tile relative min-h-36 overflow-hidden rounded-[0.65rem] bg-[#0e1115] [&_.media-attachment]:m-0 [&_.media-attachment]:h-full [&_.media-attachment]:min-h-36 [&_.media-attachment]:w-full [&_.media-attachment]:rounded-[inherit] [&_.media-visual]:h-full [&_.media-visual]:min-h-36 [&_.media-visual]:max-h-52 [&_.media-visual]:w-full [&_.media-visual]:rounded-[inherit] [&_.media-visual]:object-cover [&_img]:h-full [&_img]:min-h-36 [&_img]:max-h-52 [&_img]:w-full [&_img]:rounded-[inherit] [&_img]:object-cover [&_video]:h-full [&_video]:min-h-36 [&_video]:max-h-52 [&_video]:w-full [&_video]:rounded-[inherit] [&_video]:object-cover">
                          {message.media
                            ? ((media) => (
                                <MediaAttachment
                                  media={media}
                                  load={(progress) => props.loadMedia(message, progress)}
                                  loadPreview={() => props.loadMediaPreview(message)}
                                  cachedUrl={() => props.cachedMedia(message)}
                                  cachedPreviewUrl={() => props.cachedMediaPreview(message)}
                                  compact
                                  protected={message.protected}
                                  onOpenPreview={(preview) => openPreview(message, preview)}
                                />
                              ))(message.media!)
                            : null}
                          <button
                            class="absolute right-[0.35rem] bottom-[0.35rem] flex items-center gap-[0.3rem] rounded-[0.35rem] border-0 bg-black/70 px-[0.4rem] py-1 text-[0.64rem] text-white"
                            onClick={() => props.openMessage(message)}
                            aria-label={`Go to media message ${message.media?.name ?? ''} from ${messageTime(message)}`}
                          >
                            <time>{messageTime(message)}</time>
                            <ExternalLink size={14} />
                          </button>
                        </article>
                      ) : props.initialKind === 'links' ? (
                        <article class="shared-link-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-[0.35rem] py-3">
                          <span class="shared-kind-icon grid size-10 place-items-center rounded-[0.55rem] bg-white/[0.055] text-muted">
                            <Link size={18} />
                          </span>
                          <div class="grid min-w-0 gap-[0.18rem] [&_a]:truncate [&_a]:text-blue-300 [&_time]:text-[0.68rem] [&_time]:text-muted">
                            {renderList(sequence(links(message.text)), (url) => {
                              const href = safeExternalUrl(url);
                              return href ? (
                                <a href={href} target="_blank" rel="noopener noreferrer">
                                  {url}
                                </a>
                              ) : (
                                <span>{url}</span>
                              );
                            })}
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
                      ) : (
                        <article class="shared-file-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-[0.35rem] py-3">
                          <span class="shared-kind-icon grid size-10 place-items-center rounded-[0.55rem] bg-white/[0.055] text-muted">
                            <FileText size={20} />
                          </span>
                          <button
                            class="grid min-w-0 gap-[0.18rem] border-0 bg-transparent text-left [&_small]:text-[0.68rem] [&_small]:text-muted [&_time]:text-[0.68rem] [&_time]:text-muted"
                            disabled={
                              !message.media || mediaPresentation(message.media).preview !== 'image'
                            }
                            onClick={(event) => openFilePreview(message, event.currentTarget)}
                            aria-label={
                              message.media && mediaPresentation(message.media).preview === 'image'
                                ? `Open ${message.media.name} fullscreen preview`
                                : undefined
                            }
                          >
                            <strong>{message.media?.name}</strong>
                            <small>
                              {[fileSize(message.media?.size), message.media?.mimeType]
                                .filter(Boolean)
                                .join(' · ')}
                            </small>
                            <time>{messageTime(message)}</time>
                          </button>
                          <div class="flex items-center gap-1">
                            {!message.protected ? (
                              <button
                                class="grid size-8 place-items-center rounded-full border-0 bg-transparent text-muted"
                                onClick={() => downloadMessage(message)}
                                aria-label={`Download ${message.media?.name ?? 'file'}`}
                              >
                                <FileText size={16} />
                              </button>
                            ) : null}
                            <button
                              class="grid size-8 place-items-center rounded-full border-0 bg-transparent text-muted"
                              onClick={() => props.openMessage(message)}
                              aria-label="Go to file message"
                            >
                              <ExternalLink size={16} />
                            </button>
                          </div>
                        </article>
                      ),
                    )
                  ) : error() ? (
                    <div class={`panel-error ${panelErrorClass}`} role="alert">
                      <p>{error()}</p>
                      <button onClick={() => loadItems(false)}>Retry</button>
                    </div>
                  ) : (
                    <p class="text-[0.78rem] text-muted">{`No shared ${props.initialKind}`}</p>
                  )}
                  {items().length > 0 && error() ? (
                    <div class={`panel-error ${panelErrorClass}`} role="alert">
                      <p>{error()}</p>
                      <button onClick={() => loadItems(true)}>Retry loading more</button>
                    </div>
                  ) : null}
                  {hasMore() && !error() ? (
                    <button
                      class={`panel-load-more ${panelLoadMoreClass}`}
                      disabled={loadingMore()}
                      onClick={() => loadItems(true)}
                    >
                      {loadingMore() ? 'Loading more…' : 'Load more'}
                    </button>
                  ) : null}
                </>
              ) : (
                <p class="text-[0.78rem] text-muted">Loading {props.initialKind}…</p>
              )}
            </div>
            {model.viewer
              ? ((current) => {
                  const message = () => previewableItems()[current.index]!;
                  return (
                    <MediaViewer
                      kind={current.preview.kind}
                      name={current.preview.name}
                      url={current.preview.url}
                      origin={current.preview.origin}
                      author={message().senderName || message().senderId}
                      time={messageTime(message())}
                      caption={message().text}
                      protected={message().protected}
                      position={current.index + 1}
                      count={previewableItems().length}
                      loading={current.loading}
                      previous={
                        current.index > 0 ? () => navigatePreview(current.index - 1) : undefined
                      }
                      next={
                        current.index < previewableItems().length - 1
                          ? () => navigatePreview(current.index + 1)
                          : undefined
                      }
                      download={
                        message().protected
                          ? undefined
                          : () => saveMediaUrl(current.preview.url, current.preview.name)
                      }
                      forward={
                        message().protected ||
                        !props.forwardMessage ||
                        !capabilities(message())?.canForward
                          ? undefined
                          : () => {
                              const target = message();
                              send({ type: 'Viewer', value: undefined });
                              props.forwardMessage?.(target);
                            }
                      }
                      delete={
                        props.deleteMessage && capabilities(message())?.canDelete
                          ? () => {
                              const target = message();
                              send({ type: 'Viewer', value: undefined });
                              props.deleteMessage?.(target);
                            }
                          : undefined
                      }
                      goToMessage={() => {
                        const target = message();
                        send({ type: 'Viewer', value: undefined });
                        props.openMessage(target);
                      }}
                      close={() => send({ type: 'Viewer', value: undefined })}
                    />
                  );
                })(model.viewer!)
              : null}
          </section>
        </div>
      </Portal>
    );
  }),
});
const pagination = pages<SharedMediaPanelProps, TelegramMessage, TelegramSearchPage['nextOffset']>({
  key: (props) => `${props.peerId}:${props.initialKind}`,
  itemKey: (message) => `${message.peerId}:${message.id}`,
  load: (props, cursor) =>
    loadEffect(() => props.loadItems(props.initialKind, cursor)).pipe(
      Effect.map((page) => ({
        items: page.messages,
        next: page.hasMore ? page.nextOffset : undefined,
      })),
    ),
});
export const SharedMediaPanel = component({
  ...pagination,
  view: view<
    PagesModel<SharedMediaPanelProps, TelegramMessage, TelegramSearchPage['nextOffset']>,
    PagesMessage<TelegramMessage, TelegramSearchPage['nextOffset']>
  >((model, send) => {
    const props = model.props;
    const page = available(model.result);
    return (
      <SharedMediaContent
        initialKind={props.initialKind}
        peerId={props.peerId}
        loadItems={props.loadItems}
        loadMedia={props.loadMedia}
        loadMediaPreview={props.loadMediaPreview}
        cachedMedia={props.cachedMedia}
        cachedMediaPreview={props.cachedMediaPreview}
        openMessage={props.openMessage}
        forwardMessage={props.forwardMessage}
        dialogs={props.dialogs}
        deleteMessage={props.deleteMessage}
        close={props.close}
        items={page?.items ?? []}
        loading={model.result.waiting && !page}
        loadingMore={model.result.waiting && Boolean(page)}
        hasMore={page?.next !== undefined}
        error={resourceError(model.result)}
        loadPage={(append) => send({ type: append ? 'More' : 'Refresh' })}
      />
    );
  }),
});
