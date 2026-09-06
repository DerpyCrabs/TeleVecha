import type { TelegramBotCommand, TelegramPeerSearchResult } from '../telegram/types';
import type { emojiEntries } from './composer/emojiData';
import { collection, type Rows } from 'effectweb';

import { ids, peers } from '../domain/collections';
export const idRows = <A extends { id: string | number }>(items: readonly A[]): Rows<A> =>
  ids.from(items) as unknown as Rows<A>;
export const peerRows = <A extends { peer: { id: string } }>(items: readonly A[]): Rows<A> =>
  peers.from(items) as unknown as Rows<A>;
export const remotePeerRows = collection<TelegramPeerSearchResult>((item) => item.peer.id).from;
export const commandRows = collection<TelegramBotCommand>(
  (item) => `${item.botUsername ?? ''}:${item.command}`,
).from;
export const emojiRows = collection<(typeof emojiEntries)[number]>((item) => item.value).from;
