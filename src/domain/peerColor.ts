const TELEGRAM_PEER_COLORS = [
  '#d45246',
  '#f68136',
  '#6c61df',
  '#46ba43',
  '#5caffa',
  '#408acf',
  '#d95574',
] as const;

export function telegramPeerColor(peerId: string, colorId?: number) {
  const rawId = peerId.includes(':') ? peerId.slice(peerId.indexOf(':') + 1) : peerId;
  let numericId = 0;
  try {
    numericId = Number(BigInt(rawId) % BigInt(TELEGRAM_PEER_COLORS.length));
  } catch {
    for (const character of rawId) numericId += character.charCodeAt(0);
  }
  const index = colorId ?? Math.abs(numericId);
  return TELEGRAM_PEER_COLORS[index % TELEGRAM_PEER_COLORS.length]!;
}
