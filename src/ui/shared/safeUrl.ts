const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'tg:']);

export function safeExternalUrl(value: string | undefined) {
  if (!value) return undefined;
  if (!/^[a-z][a-z\d+.-]*:/iu.test(value)) return undefined;
  try {
    const base =
      typeof window === 'undefined' ? 'https://televecha.invalid/' : window.location.href;
    const url = new URL(value, base);
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
