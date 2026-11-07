import { modelOwner, mount } from 'effectweb';
import { LinkPreview } from '../conversation/LinkPreview';
import { Effect } from 'effect';
import type { EngineSnapshot } from '../../telegram/types';
import { AuthOverlay } from '../app/AuthOverlay';
import { GifPicker } from '../composer/GifPicker';
import { MediaAttachment } from '../media/MediaAttachment';
import { renderView } from 'effectweb/testing';

/** Browser regression fixture for the actual authentication component and Effect command runtime. */
export function mountAuthCommandFixture(
  parent: HTMLElement,
  kind: 'success' | 'failure' | 'defect' | 'throw',
) {
  const snapshot: EngineSnapshot = {
    phase: 'unauthorized',
    sync: 'current',
    online: true,
    dialogs: [],
    drafts: {},
    draftDetails: {},
    pending: [],
    activities: [],
    authStep: 'phone',
    messages: [],
    loadingMessages: false,
    hasOlderMessages: false,
    loadingOlderMessages: false,
    pinnedMessages: [],
    historyGaps: [],
  };
  let attempts = 0;
  const action = () => {
    attempts++;
    parent.dataset.authAttempts = String(attempts);
    if (kind === 'throw') throw new Error('Authentication callback threw');
    return kind === 'success'
      ? Effect.void
      : kind === 'failure'
        ? Effect.fail(new Error('Authentication rejected'))
        : Effect.die(new Error('Authentication defect'));
  };
  const props = {
    open: true,
    snapshot,
    onRetry: action,
    onQr: action,
    onCancelQr: action,
    onPhone: action,
    onCode: action,
    onPassword: action,
  };
  const rendered = renderView(parent, AuthOverlay, props);
  return { attempts: () => attempts, dispose: rendered.dispose };
}

export function mountMediaCommandFixture(
  parent: HTMLElement,
  kind: 'failure' | 'defect' | 'throw',
) {
  let attempts = 0;
  const props = {
    media: { kind: 'photo' as const, name: 'audit.png', mimeType: 'image/png', size: 0 },
    load: () => {
      parent.dataset.mediaAttempts = String(++attempts);
      if (kind === 'throw') throw new Error('Media callback threw');
      return kind === 'failure'
        ? Effect.fail(new Error('Media rejected'))
        : Effect.die(new Error('Media defect'));
    },
  };
  const rendered = renderView(parent, MediaAttachment, props);
  return rendered.dispose;
}

export function mountGifRetryFixture(parent: HTMLElement) {
  let attempts = 0;
  const props = {
    gifs: [],
    loading: false,
    error: 'GIF index failed',
    query: '',
    enabled: true,
    load: () => Effect.succeed(''),
    cachedUrl: () => undefined,
    search: () => Effect.succeed([]),
    send: () => {},
    retry: () =>
      Effect.sync(() => {
        parent.dataset.gifAttempts = String(++attempts);
      }),
  };
  const rendered = renderView(parent, GifPicker, props);
  return rendered.dispose;
}

export function mountPreviewIdentityFixture(parent: HTMLElement) {
  let releases = 0;
  let starts = 0;
  const props = {
    preview: {
      url: 'https://example.com/first',
      title: 'First preview',
      media: { kind: 'video' as const, name: 'preview.mp4', mimeType: 'video/mp4', size: 1 },
    },
    loadMedia: () =>
      Effect.gen(function* () {
        starts++;
        return yield* Effect.never;
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
            releases++;
          }),
        ),
      ),
  };
  const owner = modelOwner(props);
  const unmount = mount(parent, LinkPreview, owner.source);
  return {
    starts: () => starts,
    releases: () => releases,
    rename: () => owner.patch({ preview: { ...owner.read().preview, title: 'Updated preview' } }),
    replace: () =>
      owner.patch({ preview: { ...owner.read().preview, url: 'https://example.com/second' } }),
    close: async () => {
      await Effect.runPromise(unmount.close().pipe(Effect.onExit(() => owner.close())));
    },
  };
}
