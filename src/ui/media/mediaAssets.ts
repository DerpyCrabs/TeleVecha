import type { MessagingClient } from '../../telegram/core/client';
import type {
  TelegramDialog,
  TelegramMessage,
  TelegramPeer,
  TelegramSticker,
} from '../../telegram/types';
import { cachedAssetUrl, clearAssetUrls, loadAssetUrl, rememberAssetUrl } from './assetUrls';

const MAX_AVATAR_URLS = 256;

export interface MediaAsset {
  readonly revision: string;
  cached(): string | undefined;
  load(): Promise<string>;
}

type MediaSource = Pick<
  MessagingClient,
  | 'loadCachedAvatar'
  | 'downloadAvatar'
  | 'mediaAssetKey'
  | 'downloadMedia'
  | 'downloadSticker'
  | 'downloadCustomEmoji'
>;

export class MediaAssets {
  private readonly avatarLoads = new Map<string, Promise<string | undefined>>();
  private readonly customEmojiLoads = new Map<string, Promise<{ url: string; mimeType: string }>>();
  private readonly avatarUrls = new Map<string, string>();

  constructor(
    private readonly engine: MediaSource,
    private readonly dialogs: () => TelegramDialog[],
  ) {}

  loadPeerAvatar(
    peer: TelegramPeer,
    hasAvatar: boolean,
    avatarId: string | undefined,
    cachedOnly = false,
  ) {
    if (!hasAvatar) return Promise.resolve(undefined);
    const key = `${peer.id}:${avatarId ?? 'unknown'}`;
    const current = this.avatarLoads.get(key);
    if (current) return current;
    const blob = cachedOnly
      ? this.engine.loadCachedAvatar(peer, avatarId)
      : this.engine.downloadAvatar(peer, avatarId);
    const loading = blob.then((value) => {
      if (!value) return undefined;
      const url = URL.createObjectURL(value);
      this.avatarUrls.set(key, url);
      while (this.avatarUrls.size > MAX_AVATAR_URLS) {
        const oldest = this.avatarUrls.entries().next().value as [string, string] | undefined;
        if (!oldest) break;
        this.avatarUrls.delete(oldest[0]);
        this.avatarLoads.delete(oldest[0]);
        URL.revokeObjectURL(oldest[1]);
      }
      return url;
    });
    this.avatarLoads.set(key, loading);
    void loading.then(
      (url) => {
        if (!url) this.avatarLoads.delete(key);
      },
      () => this.avatarLoads.delete(key),
    );
    return loading;
  }

  loadAvatar(peerId: string, cachedOnly = false) {
    const dialog = this.dialogs().find(({ peer }) => peer.id === peerId);
    return dialog
      ? this.loadPeerAvatar(dialog.peer, dialog.hasAvatar, dialog.avatarId, cachedOnly)
      : Promise.resolve(undefined);
  }

  avatarIdentity(peerId: string) {
    const dialog = this.dialogs().find(({ peer }) => peer.id === peerId);
    return `${peerId}:${dialog?.avatarId ?? 'none'}`;
  }

  private asset(revision: string, load: () => Promise<Blob>): MediaAsset {
    return {
      revision,
      cached: () => cachedAssetUrl(revision),
      load: () => loadAssetUrl(revision, load),
    };
  }

  message(message: TelegramMessage) {
    return this.asset(this.engine.mediaAssetKey(message), () => this.engine.downloadMedia(message));
  }

  pending(peerId: string, messageId: string, blob: Blob) {
    const revision = `pending-media:${peerId}:${messageId}`;
    return this.asset(revision, () => Promise.resolve(blob));
  }

  sticker(sticker: TelegramSticker) {
    return this.asset(`sticker:${sticker.id}`, () => this.engine.downloadSticker(sticker));
  }

  loadMedia(message: TelegramMessage) {
    return this.message(message).load();
  }

  loadSticker(sticker: TelegramSticker) {
    return this.sticker(sticker).load();
  }

  loadCustomEmoji(documentId: string) {
    const assetKey = `custom-emoji:${documentId}`;
    const current = this.customEmojiLoads.get(documentId);
    if (current && cachedAssetUrl(assetKey)) return current;
    if (current) this.customEmojiLoads.delete(documentId);
    const loading = this.engine.downloadCustomEmoji(documentId).then((blob) => ({
      url: rememberAssetUrl(assetKey, blob),
      mimeType: blob.type,
    }));
    this.customEmojiLoads.set(documentId, loading);
    void loading.catch(() => this.customEmojiLoads.delete(documentId));
    return loading;
  }

  dispose() {
    for (const url of this.avatarUrls.values()) URL.revokeObjectURL(url);
    this.avatarUrls.clear();
    this.avatarLoads.clear();
    this.customEmojiLoads.clear();
    clearAssetUrls();
  }
}
