import type { TlObject } from '../sender';
import { downloadFile } from './download';
import type { DownloadMediaOptions, FileRpc } from './types';

const SIZE_ORDER = ['u', 'v', 'w', 'y', 'd', 'x', 'c', 'm', 'b', 'a', 's', 'f', 'i', 'j'];

function tagged(value: unknown): value is TlObject {
  return (
    typeof value === 'object' && value !== null && typeof (value as { _?: unknown })._ === 'string'
  );
}

function numberValue(value: unknown) {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : undefined;
}

function selectSize(sizes: unknown, requested?: string) {
  if (!Array.isArray(sizes)) return undefined;
  const usable = sizes.filter(tagged).filter((size) => typeof size.type === 'string');
  if (!requested) {
    return usable.reduce<TlObject | undefined>((largest, size) => {
      const width = numberValue(size.w) ?? numberValue(size.size) ?? 0;
      const largestWidth = largest
        ? (numberValue(largest.w) ?? numberValue(largest.size) ?? 0)
        : -1;
      return width > largestWidth ? size : largest;
    }, undefined);
  }
  const requestedRank = SIZE_ORDER.indexOf(requested);
  return usable
    .map((size) => ({ size, rank: SIZE_ORDER.indexOf(String(size.type)) }))
    .filter(({ rank }) => rank >= 0)
    .sort((left, right) => {
      const leftDistance =
        left.rank >= requestedRank ? left.rank - requestedRank : 1_000 - left.rank;
      const rightDistance =
        right.rank >= requestedRank ? right.rank - requestedRank : 1_000 - right.rank;
      return leftDistance - rightDistance;
    })[0]?.size;
}

function photoFileSize(size: TlObject) {
  if (Array.isArray(size.sizes)) {
    return Math.max(
      ...size.sizes.map(numberValue).filter((value): value is number => value !== undefined),
    );
  }
  return numberValue(size.size) ?? 512;
}

export async function downloadMedia(
  rpc: FileRpc,
  value: unknown,
  options: DownloadMediaOptions = {},
) {
  if (!tagged(value)) return undefined;
  let media = value;
  if (media._ === 'message' || media._ === 'messageService') {
    if (!tagged(media.media)) return undefined;
    media = media.media;
  }
  if (media._ === 'messageMediaWebPage' && tagged(media.webpage)) {
    const nested = media.webpage.document ?? media.webpage.photo;
    if (!tagged(nested)) return undefined;
    media = nested;
  }
  let photo = media;
  if (media._ === 'messageMediaPhoto' && tagged(media.photo)) photo = media.photo;
  if (photo._ === 'photo') {
    const selected = selectSize(
      options.sizeType === 'u' || options.sizeType === 'v'
        ? [...((photo.videoSizes as unknown[]) ?? []), ...((photo.sizes as unknown[]) ?? [])]
        : photo.sizes,
      options.sizeType,
    );
    if (!selected || selected._ === 'photoSizeEmpty') return undefined;
    if (
      (selected._ === 'photoCachedSize' || selected._ === 'photoStrippedSize') &&
      selected.bytes instanceof Uint8Array
    ) {
      return selected.bytes;
    }
    return downloadFile(
      rpc,
      {
        _: 'inputPhotoFileLocation',
        id: photo.id,
        accessHash: photo.accessHash,
        fileReference: photo.fileReference,
        thumbSize: selected.type,
      },
      {
        dcId: numberValue(photo.dcId) ?? 0,
        fileSize: photoFileSize(selected),
        ...(options.workers === undefined ? {} : { workers: options.workers }),
        ...(options.progressCallback ? { progressCallback: options.progressCallback } : {}),
      },
    );
  }

  let document = media;
  if (media._ === 'messageMediaDocument' && tagged(media.document)) document = media.document;
  if (document._ !== 'document') return undefined;
  const selected = options.sizeType
    ? selectSize(
        [...((document.thumbs as unknown[]) ?? []), ...((document.videoThumbs as unknown[]) ?? [])],
        options.sizeType,
      )
    : undefined;
  if (
    selected &&
    (selected._ === 'photoCachedSize' || selected._ === 'photoStrippedSize') &&
    selected.bytes instanceof Uint8Array
  ) {
    return selected.bytes;
  }
  const fileSize = selected ? numberValue(selected.size) : numberValue(document.size);
  return downloadFile(
    rpc,
    {
      _: 'inputDocumentFileLocation',
      id: document.id,
      accessHash: document.accessHash,
      fileReference: document.fileReference,
      thumbSize: selected?.type ?? '',
    },
    {
      dcId: numberValue(document.dcId) ?? 0,
      ...(fileSize === undefined ? {} : { fileSize }),
      ...(options.workers === undefined ? {} : { workers: options.workers }),
      ...(options.start === undefined ? {} : { start: options.start }),
      ...(options.end === undefined ? {} : { end: options.end }),
      ...(options.progressCallback ? { progressCallback: options.progressCallback } : {}),
    },
  );
}

function inputPeer(entity: TlObject): TlObject {
  if (entity._ === 'user') {
    if (entity.self) return { _: 'inputPeerSelf' };
    return { _: 'inputPeerUser', userId: entity.id, accessHash: entity.accessHash };
  }
  if (entity._ === 'channel' || entity._ === 'channelForbidden') {
    return { _: 'inputPeerChannel', channelId: entity.id, accessHash: entity.accessHash };
  }
  return { _: 'inputPeerChat', chatId: entity.id };
}

export function downloadProfilePhoto(rpc: FileRpc, entity: unknown, big = false) {
  if (!tagged(entity) || !tagged(entity.photo)) return Promise.resolve(undefined);
  const photo = entity.photo;
  if (photo._ !== 'userProfilePhoto' && photo._ !== 'chatPhoto') return Promise.resolve(undefined);
  return downloadFile(
    rpc,
    {
      _: 'inputPeerPhotoFileLocation',
      peer: inputPeer(entity),
      photoId: photo.photoId,
      ...(big ? { big: true } : {}),
    },
    { dcId: numberValue(photo.dcId) ?? 0 },
  );
}
