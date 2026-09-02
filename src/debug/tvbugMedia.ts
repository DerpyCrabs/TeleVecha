const MAX_PLACEHOLDER_BYTES = 16 * 1024 * 1024;

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
