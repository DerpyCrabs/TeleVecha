import type { PendingSend } from './types';

/** Legacy sends retain their chronological slots. Within each peer, explicit
 * queue positions take precedence over a clock that may have moved backward. */
export function orderPending(sends: readonly PendingSend[]): PendingSend[] {
  const chronological = [...sends].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  const slots = new Map<string, number[]>();
  for (const [i, send] of chronological.entries()) {
    if (send.queueOrder === undefined) continue;
    const indices = slots.get(send.peer.id);
    if (indices) indices.push(i);
    else slots.set(send.peer.id, [i]);
  }
  for (const indices of slots.values()) {
    const ordered = indices
      .map((i) => chronological[i]!)
      .sort((a, b) => a.queueOrder! - b.queueOrder!);
    indices.forEach((slot, i) => {
      chronological[slot] = ordered[i]!;
    });
  }
  return chronological;
}
