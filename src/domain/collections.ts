import { collection } from 'effectweb';

export const ids = collection<{ id: string | number }>((item) => item.id);
export const peers = collection<{ peer: { id: string } }>((item) => item.peer.id);
// Telegram message numbers are unique within a peer, not across conversations.
export const messages = collection<{ peerId: string; id: string | number }>(
  (item) => `${item.peerId}:${item.id}`,
);
