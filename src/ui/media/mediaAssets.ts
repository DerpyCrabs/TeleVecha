import type { MessagingEngine } from '../../telegram/core/engine';
import type {
  TelegramDialog,
  TelegramMessage,
  TelegramPeer,
  TelegramSticker,
} from '../../telegram/types';
import { cachedAssetUrl, loadAssetUrl, rememberAssetUrl } from './assetUrls';

export class MediaAssets {
  private readonly avatarLoads = new Map<string, Promise<string | undefined>>();
  private readonly customEmojiLoads = new Map<string, Promise<{ url: string; mimeType: string }>>();
  private readonly avatarUrls = new Set<string>();

  constructor(
    private readonly engine: MessagingEngine,
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
      this.avatarUrls.add(url);
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

  loadMedia(message: TelegramMessage) {
    return loadAssetUrl(this.engine.mediaAssetKey(message), () =>
      this.engine.downloadMedia(message),
    );
  }

  loadSticker(sticker: TelegramSticker) {
    return loadAssetUrl(`sticker:${sticker.id}`, () => this.engine.downloadSticker(sticker));
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
    for (const url of this.avatarUrls) URL.revokeObjectURL(url);
    this.avatarUrls.clear();
    this.avatarLoads.clear();
    this.customEmojiLoads.clear();
  }
}
