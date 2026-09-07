const MAX_PLACEHOLDER_BYTES = 16 * 1024 * 1024;

/** A visible, transparent pattern for exercising wallpaper masking without original artwork. */
export function createTvBugWallpaperPlaceholder(): Blob {
  return new Blob(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><g fill="none" stroke="white" stroke-width="3"><circle cx="64" cy="64" r="28"/><circle cx="320" cy="320" r="36"/><path d="M180 40l40 40-40 40-40-40zM400 150q60 50 0 100q-60-50 0-100M40 320l90 90m0-90l-90 90M230 440h70"/></g></svg>',
    ],
    { type: 'image/svg+xml' },
  );
}

export interface TvBugPlaceholderOptions {
  byteSize: number;
  mimeType?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

/** Builds a bounded local stand-in so snapshot rendering never downloads captured media. */
export function createTvBugPlaceholder(options: TvBugPlaceholderOptions): Blob {
  const byteSize = nonNegativeInteger(options.byteSize);
  const materializedSize = Math.min(byteSize, MAX_PLACEHOLDER_BYTES);
  const width = nonNegativeInteger(options.width);
  const height = nonNegativeInteger(options.height);
  if (width > 0 && height > 0) {
    const prefix = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
    const suffix = '</svg>';
    if (materializedSize >= prefix.length + suffix.length) {
      const padding = materializedSize - prefix.length - suffix.length;
      return new Blob([prefix, ...repeatedBlobParts(padding, true), suffix], {
        type: 'image/svg+xml',
      });
    }
  }
  return new Blob(repeatedBlobParts(materializedSize, false), {
    type: safeMimeType(options.mimeType),
  });
}

function repeatedBlobParts(byteLength: number, whitespace: boolean): Blob[] {
  if (byteLength === 0) return [];
  const chunkSize = Math.min(byteLength, 1024 * 1024);
  const chunk = new Blob([whitespace ? ' '.repeat(chunkSize) : new ArrayBuffer(chunkSize)]);
  const fullChunks = Math.floor(byteLength / chunkSize);
  const remainder = byteLength % chunkSize;
  const parts = Array.from({ length: fullChunks }, () => chunk);
  if (remainder > 0) {
    parts.push(new Blob([whitespace ? ' '.repeat(remainder) : new ArrayBuffer(remainder)]));
  }
  return parts;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function safeMimeType(value: unknown) {
  return typeof value === 'string' &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(value)
    ? value
    : 'application/octet-stream';
}
