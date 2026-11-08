import { Decompress, strFromU8 } from 'fflate';

export function decodeWidgetPayload(payload: Uint8Array): string {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const decoder = new Decompress((chunk) => {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Widget payload is too large.');
    chunks.push(chunk);
  });
  decoder.push(payload, true);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return strFromU8(bytes);
}
