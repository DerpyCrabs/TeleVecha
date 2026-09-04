import type { TelegramHistoryGap, TelegramMessage } from '../types';

type HistoryMode = 'newest' | 'oldest' | 'anchor';
interface LoadedHistory {
  messages: TelegramMessage[];
  hasOlderMessages: boolean;
}
interface HistoryIssue {
  message: string;
  retryAt?: number | undefined;
  gap?: TelegramHistoryGap | undefined;
}

interface PeerHistoryState {
  loaded?: LoadedHistory | undefined;
  offset?: number | undefined;
  version: number;
  failure?: { attempts: number; retryAt: number } | undefined;
  issue?: HistoryIssue | undefined;
  gaps: TelegramHistoryGap[];
  mode?: HistoryMode | undefined;
  anchor?: number | undefined;
}

const MAX_LOADED_HISTORIES = 8;
const MAX_MESSAGES_PER_HISTORY = 500;
const MAX_VIEW_MESSAGES = 5_000;
const HISTORY_RETRY_BASE_MS = 1_000;
const HISTORY_RETRY_MAX_MS = 30_000;

const emptyState = (): PeerHistoryState => ({ version: 0, gaps: [] });
const sortMessages = <T extends TelegramMessage>(messages: T[]) =>
  [...messages].sort((left, right) => left.id - right.id);

export function createPeerHistories() {
  const peers = new Map<string, PeerHistoryState>();
  const get = (peerId: string) => peers.get(peerId) ?? emptyState();
  const update = (peerId: string, change: (state: PeerHistoryState) => PeerHistoryState) => {
    const next = change(get(peerId));
    peers.set(peerId, next);
    return next;
  };
  const dropRuntimeData = (peerId: string, keepVersion: number) => {
    peers.set(peerId, { version: keepVersion, gaps: [] });
  };

  const normalizeGaps = (gaps: TelegramHistoryGap[]) => {
    const unique = new Map<string, TelegramHistoryGap>();
    for (const gap of gaps) {
      if (gap.olderMaxMessageId + 1 >= gap.newerMinMessageId) continue;
      unique.set(`${gap.olderMaxMessageId}:${gap.newerMinMessageId}`, gap);
    }
    return [...unique.values()].sort(
      (left, right) => left.newerMinMessageId - right.newerMinMessageId,
    );
  };

  const finalizeBound = (
    peerId: string,
    source: TelegramMessage[],
    retained: TelegramMessage[],
  ) => {
    const retainedIds = new Set(retained.map(({ id }) => id));
    const retainedGaps = get(peerId).gaps.filter(
      (gap) => retainedIds.has(gap.olderMaxMessageId) && retainedIds.has(gap.newerMinMessageId),
    );
    let previousRetained: TelegramMessage | undefined;
    let droppedAfterPrevious = false;
    for (const message of source) {
      if (retainedIds.has(message.id)) {
        if (previousRetained && droppedAfterPrevious) {
          retainedGaps.push({
            olderMaxMessageId: previousRetained.id,
            newerMinMessageId: message.id,
          });
        }
        previousRetained = message;
        droppedAfterPrevious = false;
      } else if (previousRetained) {
        droppedAfterPrevious = true;
      }
    }
    const gaps = normalizeGaps(retainedGaps);
    const offset =
      source[0] && !retainedIds.has(source[0].id) && retained[0]
        ? retained[0].id
        : get(peerId).offset;
    update(peerId, (state) => ({ ...state, gaps, offset }));
    return retained;
  };

  const boundMessages = (
    peerId: string,
    messages: TelegramMessage[],
    mode: HistoryMode,
    limit = MAX_MESSAGES_PER_HISTORY,
  ) => {
    const unique = [...new Map(messages.map((message) => [message.id, message])).values()];
    const alreadySortedAndUnique =
      unique.length === messages.length &&
      messages.every(
        (message, index) => index === 0 || (messages[index - 1]?.id ?? 0) < message.id,
      );
    const sorted = alreadySortedAndUnique ? messages : sortMessages(unique);
    if (sorted.length <= limit) return sorted;
    if (mode === 'newest') return finalizeBound(peerId, sorted, sorted.slice(-limit));
    if (mode === 'oldest') {
      const olderCount = Math.floor(limit / 2);
      return finalizeBound(peerId, sorted, [
        ...sorted.slice(0, olderCount),
        ...sorted.slice(-(limit - olderCount)),
      ]);
    }

    const anchor = get(peerId).anchor;
    const anchorIndex = anchor === undefined ? -1 : sorted.findIndex(({ id }) => id === anchor);
    if (anchorIndex < 0) return finalizeBound(peerId, sorted, sorted.slice(-limit));
    const selected = new Map<number, TelegramMessage>();
    const anchorStart = Math.max(0, anchorIndex - 50);
    const anchorEnd = Math.min(sorted.length, anchorIndex + 51);
    for (const message of sorted.slice(anchorStart, anchorEnd)) selected.set(message.id, message);
    for (let index = sorted.length - 1; index >= 0 && selected.size < limit; index -= 1) {
      const message = sorted[index];
      if (message) selected.set(message.id, message);
    }
    return finalizeBound(peerId, sorted, sortMessages([...selected.values()]));
  };

  const evictInactive = () => {
    const loaded = [...peers].filter(([, state]) => state.loaded);
    while (loaded.length > MAX_LOADED_HISTORIES) {
      const [peerId, state] = loaded.shift()!;
      dropRuntimeData(peerId, state.version);
    }
  };
  const touch = (peerId: string) => {
    const state = peers.get(peerId);
    if (!state) return;
    peers.delete(peerId);
    peers.set(peerId, state);
  };
  const setGaps = (peerId: string, gaps: TelegramHistoryGap[]) => {
    const normalized = normalizeGaps(gaps);
    update(peerId, (state) => ({ ...state, gaps: normalized }));
    return normalized;
  };

  return {
    peerIds: () => [...peers.keys()],
    loaded: (peerId: string) => get(peerId).loaded,
    updateLoaded(peerId: string, change: (history: LoadedHistory) => LoadedHistory) {
      const loaded = get(peerId).loaded;
      if (!loaded) return;
      update(peerId, (state) => ({ ...state, loaded: change(loaded) }));
    },
    remember(peerId: string, history: LoadedHistory, mode?: HistoryMode) {
      const resolvedMode = mode ?? get(peerId).mode ?? 'newest';
      const loaded = {
        ...history,
        messages: boundMessages(peerId, history.messages, resolvedMode),
      };
      update(peerId, (state) => ({ ...state, loaded, mode: resolvedMode }));
      touch(peerId);
      evictInactive();
      return loaded;
    },
    touch,
    version: (peerId: string) => get(peerId).version,
    invalidate(peerId: string) {
      dropRuntimeData(peerId, get(peerId).version + 1);
    },
    offset: (peerId: string) => get(peerId).offset,
    setOffset(peerId: string, offset: number | undefined) {
      update(peerId, (state) => ({ ...state, offset }));
    },
    issue: (peerId: string) => get(peerId).issue,
    setIssue(peerId: string, issue: HistoryIssue | undefined) {
      update(peerId, (state) => ({ ...state, issue }));
    },
    failure: (peerId: string) => get(peerId).failure,
    recordFailure(peerId: string) {
      const attempts = (get(peerId).failure?.attempts ?? 0) + 1;
      const delay = Math.min(
        HISTORY_RETRY_MAX_MS,
        HISTORY_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
      );
      const failure = { attempts, retryAt: Date.now() + delay };
      update(peerId, (state) => ({ ...state, failure }));
      return failure;
    },
    clearFailure(peerId: string) {
      update(peerId, (state) => ({ ...state, failure: undefined, issue: undefined }));
    },
    gaps: (peerId: string) => get(peerId).gaps,
    setGaps,
    mode: (peerId: string) => get(peerId).mode,
    setMode(peerId: string, mode: HistoryMode | undefined) {
      update(peerId, (state) => ({ ...state, mode }));
    },
    anchor: (peerId: string) => get(peerId).anchor,
    setAnchor(peerId: string, anchor: number | undefined) {
      update(peerId, (state) => ({ ...state, anchor }));
    },
    boundMessages,
    boundViewMessages: (peerId: string, messages: TelegramMessage[], mode: HistoryMode) =>
      boundMessages(peerId, messages, mode, MAX_VIEW_MESSAGES),
    recordLoadedRange(peerId: string, previous: TelegramMessage[], fetched: TelegramMessage[]) {
      if (previous.length === 0 || fetched.length === 0) return;
      const rangeMinimum = Math.min(...fetched.map(({ id }) => id));
      const rangeMaximum = Math.max(...fetched.map(({ id }) => id));
      let gaps = get(peerId).gaps.flatMap((gap) => {
        if (rangeMaximum <= gap.olderMaxMessageId || rangeMinimum >= gap.newerMinMessageId) {
          return [gap];
        }
        const split: TelegramHistoryGap[] = [];
        if (rangeMinimum > gap.olderMaxMessageId) {
          split.push({ olderMaxMessageId: gap.olderMaxMessageId, newerMinMessageId: rangeMinimum });
        }
        if (rangeMaximum < gap.newerMinMessageId) {
          split.push({ olderMaxMessageId: rangeMaximum, newerMinMessageId: gap.newerMinMessageId });
        }
        return split;
      });
      const overlapsLoaded = previous.some(({ id }) => id >= rangeMinimum && id <= rangeMaximum);
      if (!overlapsLoaded) {
        const immediateOlder = previous
          .filter(({ id }) => id < rangeMinimum)
          .reduce<number | undefined>(
            (maximum, { id }) => (maximum === undefined ? id : Math.max(maximum, id)),
            undefined,
          );
        const immediateNewer = previous
          .filter(({ id }) => id > rangeMaximum)
          .reduce<number | undefined>(
            (minimum, { id }) => (minimum === undefined ? id : Math.min(minimum, id)),
            undefined,
          );
        const isAlreadySplit = gaps.some(
          (gap) => gap.olderMaxMessageId <= rangeMaximum && gap.newerMinMessageId >= rangeMinimum,
        );
        if (!isAlreadySplit && immediateNewer !== undefined) {
          gaps.push({ olderMaxMessageId: rangeMaximum, newerMinMessageId: immediateNewer });
        } else if (!isAlreadySplit && immediateOlder !== undefined) {
          gaps.push({ olderMaxMessageId: immediateOlder, newerMinMessageId: rangeMinimum });
        }
      }
      gaps = normalizeGaps(gaps);
      update(peerId, (state) => ({ ...state, gaps }));
    },
    findGap(peerId: string, requested: TelegramHistoryGap) {
      return get(peerId).gaps.find(
        (gap) =>
          gap.olderMaxMessageId === requested.olderMaxMessageId &&
          gap.newerMinMessageId === requested.newerMinMessageId,
      );
    },
    advanceGap(
      peerId: string,
      current: TelegramHistoryGap,
      fetched: TelegramMessage[],
      hasOlder: boolean,
    ) {
      const pageOldestId = fetched.reduce<number | undefined>(
        (minimum, { id }) => (minimum === undefined ? id : Math.min(minimum, id)),
        undefined,
      );
      const replacement =
        pageOldestId !== undefined && pageOldestId > current.olderMaxMessageId
          ? { ...current, newerMinMessageId: pageOldestId }
          : undefined;
      const next = get(peerId).gaps.flatMap((gap) => {
        if (
          gap.olderMaxMessageId !== current.olderMaxMessageId ||
          gap.newerMinMessageId !== current.newerMinMessageId
        ) {
          return [gap];
        }
        if (replacement) return [replacement];
        return pageOldestId === undefined && hasOlder ? [gap] : [];
      });
      return setGaps(peerId, next);
    },
    clear(options: { preserveVersions?: boolean } = {}) {
      if (!options.preserveVersions) {
        peers.clear();
        return;
      }
      for (const [peerId, state] of peers) dropRuntimeData(peerId, state.version);
    },
  };
}
