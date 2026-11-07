/** Mini Apps receive login data in the URL; only encrypted, credential-free URLs are valid. */
export function validWebAppUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
export function validWebAppData(data: string): boolean {
  const length = new TextEncoder().encode(data).length;
  return length > 0 && length <= 4096;
}
export function parseWebAppEvent(
  value: unknown,
): { eventType: string; eventData: Record<string, unknown> } | undefined {
  try {
    const decoded: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return undefined;
    const parsed = decoded as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.eventType !== 'string' ||
      !parsed.eventType.startsWith('web_app_')
    )
      return undefined;
    const data = parsed.eventData;
    if (data !== undefined && (data === null || typeof data !== 'object' || Array.isArray(data)))
      return undefined;
    return { eventType: parsed.eventType, eventData: (data ?? {}) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}
