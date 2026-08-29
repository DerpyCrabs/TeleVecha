import { concatBytes, hexToBytes } from '../bytes';
import type { TlObject } from '../sender';
import { downloadFile } from './download';
import type { DownloadMediaOptions, FileRpc } from './types';

const SIZE_ORDER = ['u', 'v', 'w', 'y', 'd', 'x', 'c', 'm', 'b', 'a', 's', 'f', 'i', 'j'];
const STRIPPED_JPEG_HEADER = hexToBytes(
  'ffd8ffe000104a46494600010100000100010000ffdb004300281c1e231e19282321232d2b28303c64413c37373c7b585d4964918099968f808c8aa0b4e6c3a0aadaad8a8cc8ffcbdaeef5ffffff9bc1fffffffaffe6fdfff8ffdb0043012b2d2d3c353c76414176f8a58ca5f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8ffc00011080000000003012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f00',
);
const JPEG_END = new Uint8Array([0xff, 0xd9]);
const JPEG_HEIGHT_LOW_BYTE = 164;
const JPEG_WIDTH_LOW_BYTE = 166;

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
      return width >= largestWidth ? size : largest;
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
    const sizes = size.sizes
      .map(numberValue)
      .filter((value): value is number => value !== undefined);
    return sizes.length ? Math.max(...sizes) : 512;
  }
  return numberValue(size.size) ?? 512;
}

function isDownloadableSize(size: TlObject | undefined): size is TlObject {
  return Boolean(
    size &&
    size._ !== 'photoSizeEmpty' &&
    size._ !== 'videoSizeEmojiMarkup' &&
    size._ !== 'videoSizeStickerMarkup',
  );
}

function strippedPhotoToJpeg(bytes: Uint8Array) {
  if (bytes.length < 3 || bytes[0] !== 1) return bytes;
  const header = new Uint8Array(STRIPPED_JPEG_HEADER);
  header[JPEG_HEIGHT_LOW_BYTE] = bytes[1]!;
  header[JPEG_WIDTH_LOW_BYTE] = bytes[2]!;
  return concatBytes(header, bytes.subarray(3), JPEG_END);
}

function inlinePhotoBytes(size: TlObject) {
  if (!(size.bytes instanceof Uint8Array)) return undefined;
  return size._ === 'photoStrippedSize' ? strippedPhotoToJpeg(size.bytes) : size.bytes;
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
    if (!isDownloadableSize(selected)) return undefined;
    if (
      (selected._ === 'photoCachedSize' || selected._ === 'photoStrippedSize') &&
      selected.bytes instanceof Uint8Array
    ) {
      return inlinePhotoBytes(selected);
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
  let selected = options.sizeType
    ? selectSize(
        [...((document.thumbs as unknown[]) ?? []), ...((document.videoThumbs as unknown[]) ?? [])],
        options.sizeType,
      )
    : undefined;
  if (!isDownloadableSize(selected)) selected = undefined;
  if (!selected && options.sizeType && String(document.mimeType).startsWith('video/')) {
    return undefined;
  }
  if (
    selected &&
    (selected._ === 'photoCachedSize' || selected._ === 'photoStrippedSize') &&
    selected.bytes instanceof Uint8Array
  ) {
    return inlinePhotoBytes(selected);
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
