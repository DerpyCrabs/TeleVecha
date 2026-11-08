import { describe, expect, it } from 'vitest';

import { initialEngineSnapshot } from '../core/engineState';
import { applyConversationChange, makeClientRegistry } from './clientRegistry';

describe('clientRegistry', () => {
  it('keeps one coherent record for a tab', () => {
    const registry = makeClientRegistry();
    const snapshot = { ...initialEngineSnapshot(), activePeerId: 'peer-1' };

    registry.setSnapshot('tab-1', snapshot);
    registry.setVisibility('tab-1', { peerId: 'peer-1', visible: true, atBottom: true }, 100);

    expect(registry.snapshot('tab-1')).toBe(snapshot);
    expect(registry.visibilityReports('peer-1', 100)).toEqual([
      { peerId: 'peer-1', visible: true, atBottom: true },
    ]);
    expect(registry.staleClientIds(101, 'owner')).toEqual(['tab-1']);
  });

  it('removes projection, liveness, and visibility together', () => {
    const registry = makeClientRegistry();
    registry.setSnapshot('tab-1', initialEngineSnapshot());
    registry.setVisibility('tab-1', { peerId: 'peer-1', visible: true, atBottom: false }, 100);
    registry.queueState('tab-1');

    expect(registry.remove('tab-1')).toBe('peer-1');
    expect(registry.snapshot('tab-1')).toBeUndefined();
    expect(registry.visibilityReports('peer-1', 0)).toEqual([]);
    expect(registry.takeQueuedStateClients()).toEqual([]);
  });
});

const message = (id: number, text: string = `message ${id}`) => ({
  id,
  peerId: 'peer-1',
  senderId: 'self',
  text,
  date: id,
  outgoing: true,
});
const conversation = (...ids: number[]) => ({
  ...initialEngineSnapshot(),
  activePeerId: 'peer-1',
  messages: ids.map((id) => message(id)),
});

it('replays concurrent insertions, edits, deletions and pinned changes over a delayed view result', () => {
  const registry = makeClientRegistry();
  registry.setSnapshot('tab', conversation(1, 2));
  const request = registry.beginConversationLoad('tab', 'peer-1');
  const edited = message(1, 'edited');
  registry.recordConversationChange({ type: 'message-upsert', message: edited });
  registry.recordConversationChange({
    type: 'messages-delete',
    peerId: 'peer-1',
    messageIds: [2, 3],
  });
  registry.recordConversationChange({
    type: 'message-upsert',
    message: message(4),
    insertIfMissing: true,
  });
  registry.recordConversationChange({
    type: 'pinned-messages',
    peerId: 'peer-1',
    messages: [edited],
  });
  const result = request.complete(conversation(1, 2, 3));
  expect(result?.messages).toEqual([edited, message(4)]);
  expect(result?.pinnedMessages).toEqual([edited]);
  // A completed request releases its journal. Later events belong to the live projection.
  registry.recordConversationChange({ type: 'messages-delete', peerId: 'peer-1', messageIds: [1] });
  expect(request.complete(conversation(1))).toBeUndefined();
});

it('supersedes a delayed load for the same peer without letting stale cancellation clear its successor', () => {
  const registry = makeClientRegistry();
  registry.setSnapshot('tab', conversation(1));
  const old = registry.beginConversationLoad('tab', 'peer-1');
  const latest = registry.beginConversationLoad('tab', 'peer-1');
  old.cancel();
  registry.recordConversationChange({ type: 'message-upsert', message: message(2) });
  expect(old.current()).toBe(false);
  expect(old.complete(conversation(1))).toBeUndefined();
  expect(latest.complete(conversation(1))?.messages).toEqual([message(1), message(2)]);
});

it.each(['switch', 'remove', 'clear', 'cancel'] as const)(
  'discards a load after client %s',
  (operation) => {
    const registry = makeClientRegistry();
    registry.setSnapshot('tab', conversation(1));
    const request = registry.beginConversationLoad('tab', 'peer-1');
    if (operation === 'switch')
      registry.setSnapshot('tab', { ...conversation(), activePeerId: 'peer-2' });
    else if (operation === 'remove') registry.remove('tab');
    else if (operation === 'clear') registry.clear();
    else request.cancel();
    registry.recordConversationChange({ type: 'message-upsert', message: message(2) });
    expect(request.complete(conversation(1))).toBeUndefined();
  },
);

it('keeps journals independent per client and ignores events for other peers', () => {
  const registry = makeClientRegistry();
  registry.setSnapshot('first', conversation(1));
  registry.setSnapshot('second', { ...conversation(), activePeerId: 'peer-2' });
  const first = registry.beginConversationLoad('first', 'peer-1');
  const second = registry.beginConversationLoad('second', 'peer-2');
  registry.recordConversationChange({ type: 'messages-delete', messageIds: [1] });
  registry.recordConversationChange({ type: 'message-upsert', message: message(2) });
  expect(first.complete(conversation(1))?.messages).toEqual([message(2)]);
  expect(second.complete({ ...conversation(1), activePeerId: 'peer-2' })?.messages).toEqual([]);
});

it('inserts a message that arrives after a newer one, but not into a history gap', () => {
  const late = { type: 'message-upsert', message: message(2) } as const;
  expect(applyConversationChange(conversation(1, 3), late).messages).toEqual([
    message(1),
    message(2),
    message(3),
  ]);
  const gapped = {
    ...conversation(1, 3),
    historyGaps: [{ olderMaxMessageId: 1, newerMinMessageId: 3 }],
  };
  expect(applyConversationChange(gapped, late).messages).toEqual([message(1), message(3)]);
  // An edit to a message older than everything loaded stays outside the view.
  const old = { type: 'message-upsert', message: message(1) } as const;
  expect(applyConversationChange(conversation(2, 3), old).messages).toEqual([
    message(2),
    message(3),
  ]);
});

it('keeps live messages and delayed loads scoped to the selected forum topic', () => {
  const view = { ...conversation(), activeTopicId: 10 };
  const sibling = { ...message(101), topicId: 20 };
  const own = { ...message(102), topicId: 10 };
  expect(applyConversationChange(view, { type: 'message-upsert', message: sibling })).toBe(view);
  expect(applyConversationChange(view, { type: 'message-upsert', message: own }).messages).toEqual([
    own,
  ]);
  const registry = makeClientRegistry();
  registry.setSnapshot('tab', view);
  const oldLoad = registry.beginConversationLoad('tab', 'peer-1');
  registry.setSnapshot('tab', { ...view, activeTopicId: 20 });
  const newLoad = registry.beginConversationLoad('tab', 'peer-1');
  registry.recordConversationChange({ type: 'message-upsert', message: own });
  registry.recordConversationChange({ type: 'message-upsert', message: sibling });
  expect(oldLoad.complete(view)).toBeUndefined();
  expect(newLoad.complete({ ...view, activeTopicId: 20 })?.messages).toEqual([sibling]);
});

it('isolates saved sources during live updates and superseded history requests', () => {
  const first = { id: 'c:10', kind: 'channel' as const };
  const second = { id: 'c:20', kind: 'channel' as const };
  const view = { ...conversation(), activeSavedPeer: first };
  const own = { ...message(101), savedPeerId: first.id };
  const other = { ...message(102), savedPeerId: second.id };
  expect(applyConversationChange(view, { type: 'message-upsert', message: other })).toBe(view);
  expect(applyConversationChange(view, { type: 'message-upsert', message: own }).messages).toEqual([
    own,
  ]);
  expect(
    applyConversationChange(view, {
      type: 'pinned-messages',
      peerId: 'peer-1',
      messages: [own, other],
    }).pinnedMessages,
  ).toEqual([own]);
  const registry = makeClientRegistry();
  registry.setSnapshot('tab', view);
  const old = registry.beginConversationLoad('tab', 'peer-1');
  const nextView = { ...view, activeSavedPeer: second };
  registry.setSnapshot('tab', nextView);
  const next = registry.beginConversationLoad('tab', 'peer-1');
  registry.recordConversationChange({ type: 'message-upsert', message: own });
  registry.recordConversationChange({ type: 'message-upsert', message: other });
  expect(old.complete(view)).toBeUndefined();
  expect(next.complete(nextView)?.messages).toEqual([other]);
});
