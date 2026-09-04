/**
 * Keeps the last committed value for each peer while an asynchronous producer
 * temporarily has no value to publish. This lets view state use stale-while-
 * revalidate semantics without confusing one peer's data with another's.
 */
export function retainPeerValue<Value>(
  previous: ReadonlyMap<string, Value>,
  peerId: string | undefined,
  value: Value | undefined,
): ReadonlyMap<string, Value> {
  if (peerId === undefined || value === undefined || Object.is(previous.get(peerId), value)) {
    return previous;
  }
  const next = new Map(previous);
  next.set(peerId, value);
  return next;
}
