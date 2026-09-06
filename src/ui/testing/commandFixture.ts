import { Effect } from 'effect';
import type { EngineSnapshot } from '../../telegram/types';
import { AuthOverlay } from '../app/AuthOverlay';
import { GifPicker } from '../composer/GifPicker';
import { MediaAttachment } from '../media/MediaAttachment';
import { Scope } from 'effectweb/dom';

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
    onPhone: action,
    onCode: action,
    onPassword: action,
  };
  const scope = new Scope<typeof props, never>(props, () => {});
  AuthOverlay.build(scope, parent, null);
  return { attempts: () => attempts, dispose: () => scope.dispose() };
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
  const scope = new Scope<typeof props, never>(props, () => {});
  MediaAttachment.build(scope, parent, null);
  return () => scope.dispose();
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
  const scope = new Scope<typeof props, never>(props, () => {});
  GifPicker.build(scope, parent, null);
  return () => scope.dispose();
}
