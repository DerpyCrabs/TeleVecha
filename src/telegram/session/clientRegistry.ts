import type { EngineSnapshot } from '../types';

interface VisibilityReport {
  readonly peerId: string;
  readonly visible: boolean;
  readonly atBottom: boolean;
}

interface ClientRecord {
  snapshot?: EngineSnapshot;
  seenAt?: number;
  visibility?: VisibilityReport;
  stateQueued?: boolean;
}

/** Keeps each tab's projection, liveness, and visibility as one owned record. */
export function makeClientRegistry() {
  const records = new Map<string, ClientRecord>();

  const record = (clientId: string) => records.get(clientId) ?? {};

  return {
    touch(clientId: string, seenAt = Date.now()) {
      records.set(clientId, { ...record(clientId), seenAt });
    },
    setSnapshot(clientId: string, snapshot: EngineSnapshot) {
      records.set(clientId, { ...record(clientId), snapshot });
    },
    hasSnapshot: (clientId: string) => records.get(clientId)?.snapshot !== undefined,
    snapshot: (clientId: string) => records.get(clientId)?.snapshot,
    *snapshots(): IterableIterator<[string, EngineSnapshot]> {
      for (const [clientId, value] of records) {
        if (value.snapshot) yield [clientId, value.snapshot];
      }
    },
    setVisibility(clientId: string, visibility: VisibilityReport, seenAt = Date.now()) {
      records.set(clientId, { ...record(clientId), seenAt, visibility });
    },
    visibilityReports(peerId: string, seenAfter: number) {
      const reports: VisibilityReport[] = [];
      for (const value of records.values()) {
        if ((value.seenAt ?? 0) >= seenAfter && value.visibility?.peerId === peerId) {
          reports.push(value.visibility);
        }
      }
      return reports;
    },
    visiblePeerIds() {
      return new Set(
        [...records.values()].flatMap(({ visibility }) => (visibility ? [visibility.peerId] : [])),
      );
    },
    queueState(clientId: string) {
      records.set(clientId, { ...record(clientId), stateQueued: true });
    },
    takeQueuedStateClients() {
      const queued: string[] = [];
      for (const [clientId, value] of records) {
        if (!value.stateQueued) continue;
        queued.push(clientId);
        records.set(clientId, { ...value, stateQueued: false });
      }
      return queued;
    },
    staleClientIds(seenBefore: number, preserveClientId: string) {
      return [...records.entries()]
        .filter(
          ([clientId, value]) => clientId !== preserveClientId && (value.seenAt ?? 0) < seenBefore,
        )
        .map(([clientId]) => clientId);
    },
    remove(clientId: string) {
      const peerId = records.get(clientId)?.visibility?.peerId;
      records.delete(clientId);
      return peerId;
    },
    clear: () => records.clear(),
  };
}
