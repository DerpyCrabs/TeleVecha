import { Deferred, Effect } from 'effect';
import type { MessagingErrorPayload } from '../core/messagingError';

export interface PendingRequest<Method> {
  readonly id: string;
  readonly method: Method;
  readonly args: unknown[];
  readonly createdAt: number;
  readonly result: Deferred.Deferred<unknown, Error>;
  sentTo?: string | undefined;
  sentAt?: number | undefined;
}

interface CompletedRequest {
  result?: unknown;
  error?: MessagingErrorPayload;
}

/** Owns follower requests and owner-side idempotency records. */
export function makeRequestJournal<Method>(completedCapacity: number) {
  const pending = new Map<string, PendingRequest<Method>>();
  const active = new Set<string>();
  const completed = new Map<string, CompletedRequest>();

  const rejectWhere = (predicate: (request: PendingRequest<Method>) => boolean, error: Error) => {
    const rejected: PendingRequest<Method>[] = [];
    for (const [id, request] of pending) {
      if (!predicate(request)) continue;
      pending.delete(id);
      rejected.push(request);
    }
    return Effect.forEach(rejected, ({ result }) => Deferred.fail(result, error), {
      discard: true,
    });
  };

  return {
    add(request: PendingRequest<Method>) {
      pending.set(request.id, request);
    },
    pending: (id: string) => pending.get(id),
    hasPending: (id: string) => pending.has(id),
    takePending(id: string) {
      const request = pending.get(id);
      if (request) pending.delete(id);
      return request;
    },
    pendingValues: () => pending.values(),
    pendingEntries: () => pending.entries(),
    pendingCount: () => pending.size,
    rejectPending: rejectWhere,
    rejectAll: (error: Error) => rejectWhere(() => true, error),
    completed: (id: string) => completed.get(id),
    begin(id: string) {
      if (active.has(id)) return false;
      active.add(id);
      return true;
    },
    finish: (id: string) => active.delete(id),
    remember(id: string, response: CompletedRequest) {
      completed.set(id, response);
      while (completed.size > completedCapacity) {
        const oldest = completed.keys().next().value;
        if (oldest === undefined) break;
        completed.delete(oldest);
      }
    },
    clearOwnerRecords() {
      active.clear();
      completed.clear();
    },
  };
}
