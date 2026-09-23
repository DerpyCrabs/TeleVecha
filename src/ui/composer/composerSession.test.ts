import { Effect, Exit, FiberSet, Scope } from 'effect';
import { controlledEffect } from 'effectweb/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { initialEngineSnapshot } from '../../telegram/core/engineState';
import type { EffectConversation } from '../../telegram/core/conversation';
import { MessagingError } from '../../telegram/core/messagingError';
import type { TelegramDialog } from '../../telegram/types';
import { createComposerSession } from './composerSession';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function taskScope() {
  const scope = Scope.makeUnsafe();
  const tasks = Effect.runSync(FiberSet.make().pipe(Effect.provideService(Scope.Scope, scope)));
  const runTask = Effect.runSync(FiberSet.runtime(tasks)());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  cleanups.push(close);
  return { runTask, close, idle: () => Effect.runPromise(FiberSet.awaitEmpty(tasks)) };
}

it('publishes coherent composer states for chat changes, editing, restoration and reset', async () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const snapshot = {
    ...initialEngineSnapshot(),
    drafts: { second: 'second draft' },
    draftDetails: {
      second: {
        formats: [{ kind: 'bold', offset: 0, length: 6 }],
        reply: { messageId: 4, preview: 'reply' },
      },
    },
  } satisfies ReturnType<typeof initialEngineSnapshot>;
  const tasks = taskScope();
  const session = createComposerSession({
    conversation: () => undefined,
    snapshot: () => snapshot,
    activePeerId: () => 'second',
    activeDialog: () => undefined,
    canSend: () => false,
    canSendMedia: () => false,
    runTask: tasks.runTask,
    beforeUiChange: () => {},
    beforeSend: () => {},
    focus: () => {},
  });
  const changes = vi.fn();
  session.subscribe(changes);
  session.replaceDraft('first draft');
  changes.mockClear();
  session.switchPeer('first', 'second', true);
  expect(changes).toHaveBeenCalledTimes(1);
  expect(changes.mock.calls[0]![0]).toEqual({
    mentionMembers: [],
    draft: 'second draft',
    formats: snapshot.draftDetails.second.formats,
    reply: snapshot.draftDetails.second.reply,
    attachments: [],
    editing: undefined,
  });
  const message = {
    id: '5',
    author: 'Me',
    body: 'edit text',
    time: '',
    outgoing: true,
    status: 'sent' as const,
  };
  changes.mockClear();
  session.beginEdit(message);
  expect(changes).toHaveBeenCalledTimes(1);
  expect(session.model()).toMatchObject({
    draft: 'edit text',
    editing: message,
    reply: undefined,
    formats: [],
  });
  changes.mockClear();
  session.cancelEdit();
  expect(changes).toHaveBeenCalledTimes(1);
  expect(session.model()).toMatchObject({
    mentionMembers: [],
    draft: 'second draft',
    editing: undefined,
    formats: snapshot.draftDetails.second.formats,
    reply: snapshot.draftDetails.second.reply,
  });
  changes.mockClear();
  session.reset();
  expect(changes).toHaveBeenCalledTimes(1);
  expect(session.model()).toEqual({
    mentionMembers: [],
    draft: '',
    formats: [],
    attachments: [],
    reply: undefined,
    editing: undefined,
  });
  session.dispose();
  await Promise.resolve();
});

it.each(['restore', 'new-reply', 'failed'] as const)(
  'preserves reply draft context after an edit completes: %s',
  async (scenario) => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const reply = { messageId: 4, preview: 'reply', quoteText: 'quoted text' };
    const snapshot = {
      ...initialEngineSnapshot(),
      drafts: { alice: 'reply draft' },
      draftDetails: { alice: { formats: [], reply } },
    };
    let complete!: (success: boolean) => void;
    // This workflow only touches typing, draft persistence and message editing.
    const conversation = {
      peerId: 'alice',
      setTyping: () => Effect.void,
      setDraft: () => Effect.void,
      editMessage: () =>
        Effect.callback<void, MessagingError>((resume) => {
          complete = (success) =>
            resume(
              success
                ? Effect.void
                : Effect.fail(
                    new MessagingError({ message: 'offline', operation: 'edit-message' }),
                  ),
            );
        }),
    } as unknown as EffectConversation;
    const tasks = taskScope();
    const session = createComposerSession({
      conversation: () => conversation,
      snapshot: () => snapshot,
      activePeerId: () => 'alice',
      activeDialog: () => ({ peer: { id: 'alice', kind: 'user' } }) as TelegramDialog,
      canSend: () => true,
      canSendMedia: () => true,
      runTask: tasks.runTask,
      beforeUiChange: () => {},
      beforeSend: () => {},
      focus: () => {},
    });
    session.switchPeer('empty', 'alice', true);
    session.beginEdit({
      id: '5',
      author: 'Me',
      body: 'edit text',
      time: '',
      outgoing: true,
      status: 'sent',
    });
    session.send();
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    if (scenario === 'new-reply') session.forceReply(8, 'new reply');
    const changes = vi.fn();
    session.subscribe(changes);
    complete(scenario !== 'failed');
    await tasks.idle();
    if (scenario === 'new-reply') {
      expect(session.model()).toMatchObject({
        draft: '',
        reply: { messageId: 8, preview: 'new reply' },
        editing: undefined,
      });
      expect(changes).not.toHaveBeenCalled();
    } else if (scenario === 'failed') {
      expect(session.model()).toMatchObject({
        draft: 'edit text',
        reply: undefined,
        editing: { id: '5' },
      });
      session.cancelEdit();
      expect(session.model()).toMatchObject({ draft: 'reply draft', reply, editing: undefined });
    } else {
      expect(changes).toHaveBeenCalledTimes(1);
      expect(session.model()).toMatchObject({ draft: 'reply draft', reply, editing: undefined });
    }
    session.dispose();
    await Promise.resolve();
  },
);

function composerFixture() {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const tasks = taskScope();
  const snapshot = { ...initialEngineSnapshot(), online: true };
  let peerId = 'alice';
  const draft = vi.fn(
    (_peer: string, _value: string, _details?: Parameters<EffectConversation['setDraft']>[1]) =>
      Effect.void as Effect.Effect<void, MessagingError>,
  );
  const send = vi.fn(
    (_peer: string, _body: string) => Effect.void as Effect.Effect<void, MessagingError>,
  );
  const upload = vi.fn(
    (_attachments: Parameters<EffectConversation['sendAttachments']>[0]) =>
      Effect.void as Effect.Effect<void, MessagingError>,
  );
  const typing = vi.fn((_peer: string, _action?: string) => Effect.void);
  const conversation = (id: string) =>
    ({
      peerId: id,
      setDraft: (text, details) => draft(id, text, details),
      sendDraft: (text) => send(id, text),
      sendAttachments: (attachments) => upload(attachments),
      setTyping: (action) => Effect.suspend(() => typing(id, action)),
    }) satisfies Pick<
      EffectConversation,
      'peerId' | 'setDraft' | 'sendDraft' | 'sendAttachments' | 'setTyping'
    > as unknown as EffectConversation;
  const focus = vi.fn();
  const session = createComposerSession({
    conversation: () => conversation(peerId),
    snapshot: () => snapshot,
    activePeerId: () => peerId,
    activeDialog: () => ({ peer: { id: peerId, kind: 'user' } }) as TelegramDialog,
    canSend: () => true,
    canSendMedia: () => true,
    runTask: tasks.runTask,
    beforeUiChange: () => {},
    beforeSend: () => {},
    focus,
  });
  cleanups.push(session.dispose);
  return {
    session,
    tasks,
    draft,
    send,
    upload,
    typing,
    focus,
    switchTo: (next: string) => {
      const previous = peerId;
      peerId = next;
      session.switchPeer(previous, next, true);
    },
  };
}

const offline = () => new MessagingError({ message: 'offline', operation: 'send-draft' });

it('flushes the latest draft and waits for every accepted write before sending', async () => {
  const { session, tasks, draft, send } = composerFixture();
  const first = controlledEffect<void, MessagingError>();
  const latest = controlledEffect<void, MessagingError>();
  draft.mockReturnValueOnce(first.effect).mockReturnValueOnce(latest.effect);
  session.changeDraft('first');
  session.changeDraft('second');
  session.changeDraft('latest');
  session.send();
  expect(session.model().draft).toBe('');
  expect(draft.mock.calls.map((call) => call[1])).toEqual(['first', 'latest']);
  expect(first.canceled()).toBe(0);
  expect(send).not.toHaveBeenCalled();
  first.succeed(undefined);
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  latest.succeed(undefined);
  await tasks.idle();
  expect(send).toHaveBeenCalledExactlyOnceWith('alice', 'latest');
});

it('does not cancel a durable write when the next debounce starts', async () => {
  vi.useFakeTimers();
  const { session, tasks, draft } = composerFixture();
  const trailing = controlledEffect<void, MessagingError>();
  draft.mockReturnValueOnce(Effect.void).mockReturnValueOnce(trailing.effect);
  session.changeDraft('first');
  session.changeDraft('second');
  await vi.advanceTimersByTimeAsync(120);
  expect(trailing.pending()).toBe(1);
  session.changeDraft('third');
  expect(trailing.canceled()).toBe(0);
  trailing.succeed(undefined);
  await tasks.idle();
  expect(draft.mock.calls.map((call) => call[1])).toEqual(['first', 'second', 'third']);
});

it('does not let a trailing text write overwrite newer reply and format details', async () => {
  vi.useFakeTimers();
  const { session, draft } = composerFixture();
  session.changeDraft('first');
  session.changeDraft('latest');
  session.forceReply(7, 'reply');
  session.setFormats([{ kind: 'bold', offset: 0, length: 6 }]);
  await vi.advanceTimersByTimeAsync(200);
  expect(draft).toHaveBeenCalledTimes(3);
  expect(draft).toHaveBeenLastCalledWith('alice', 'latest', {
    reply: { messageId: 7, preview: 'reply' },
    formats: [{ kind: 'bold', offset: 0, length: 6 }],
  });
});

it('does not wait for another chat to persist its draft', async () => {
  const { session, tasks, draft, send, switchTo } = composerFixture();
  const aliceWrite = controlledEffect<void, MessagingError>();
  draft.mockReturnValueOnce(aliceWrite.effect);
  session.changeDraft('alice draft');
  switchTo('bob');
  session.changeDraft('bob draft');
  session.send();
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('bob', 'bob draft'));
  expect(aliceWrite.pending()).toBe(1);
  aliceWrite.succeed(undefined);
  await tasks.idle();
});

it.each([
  'untouched',
  'new-draft',
  'reply-cleared',
  'reset',
  'switch-chat',
  'switch-back',
] as const)(
  'recovers a failed send without overwriting newer composer state: %s',
  async (scenario) => {
    const { session, tasks, send, switchTo } = composerFixture();
    const request = controlledEffect<void, MessagingError>();
    send.mockReturnValue(request.effect);
    session.replaceDraft('captured text');
    session.forceReply(4, 'captured reply');
    session.send();
    expect(request.pending()).toBe(1);
    if (scenario === 'new-draft') session.changeDraft('new text');
    if (scenario === 'reply-cleared') {
      session.forceReply(8, 'new reply');
      session.clearReply();
    }
    if (scenario === 'reset') session.reset();
    if (scenario === 'switch-chat' || scenario === 'switch-back') switchTo('bob');
    if (scenario === 'switch-back') switchTo('alice');
    request.fail(offline());
    await tasks.idle();
    expect(session.model()).toMatchObject({
      draft:
        scenario === 'untouched' ? 'captured text' : scenario === 'new-draft' ? 'new text' : '',
      reply: scenario === 'untouched' ? { messageId: 4, preview: 'captured reply' } : undefined,
    });
  },
);

it('keeps an accepted send alive across chat switches and composer disposal', async () => {
  const { session, tasks, send, switchTo } = composerFixture();
  const request = controlledEffect<void, MessagingError>();
  send.mockReturnValue(request.effect);
  session.replaceDraft('accepted message');
  session.send();
  switchTo('bob');
  const changes = vi.fn();
  session.subscribe(changes);
  session.dispose();
  expect(request.pending()).toBe(1);
  expect(request.canceled()).toBe(0);
  request.fail(offline());
  await tasks.idle();
  expect(changes).not.toHaveBeenCalled();
});

it('focuses the composer when closing a menu removes the previously focused item', async () => {
  const { session, focus } = composerFixture();
  const menuItem = { isConnected: true };
  const body = { isConnected: true };
  const document = { activeElement: menuItem, body };
  vi.stubGlobal('document', document);

  session.focus();
  menuItem.isConnected = false;
  document.activeElement = body;
  await Promise.resolve();

  expect(focus).toHaveBeenCalledOnce();
});

it('keeps a later user focus choice after the originating menu item is removed', async () => {
  const { session, focus } = composerFixture();
  const menuItem = { isConnected: true };
  const document = { activeElement: menuItem, body: { isConnected: true } };
  vi.stubGlobal('document', document);

  session.focus();
  menuItem.isConnected = false;
  document.activeElement = { isConnected: true };
  await Promise.resolve();

  expect(focus).not.toHaveBeenCalled();
});

it('flushes drafts on disposal and cancels focus and inactivity callbacks', async () => {
  vi.useFakeTimers();
  const { session, tasks, draft, typing, focus } = composerFixture();
  const request = controlledEffect<void, MessagingError>();
  draft.mockReturnValue(request.effect);
  session.changeDraft('first');
  session.changeDraft('latest');
  session.focus();
  session.dispose();
  expect(request.pending()).toBe(2);
  expect(request.canceled()).toBe(0);
  expect(typing.mock.calls).toEqual([
    ['alice', 'typing'],
    ['alice', undefined],
  ]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(draft.mock.calls.map((call) => call[1])).toEqual(['first', 'latest']);
  expect(typing).toHaveBeenCalledTimes(2);
  expect(focus).not.toHaveBeenCalled();
  request.succeed(undefined);
  request.succeed(undefined);
  await tasks.idle();
});

it('replaces the typing inactivity timer as the user continues typing', async () => {
  vi.useFakeTimers();
  const { session, typing } = composerFixture();
  session.changeDraft('first');
  await vi.advanceTimersByTimeAsync(4_000);
  session.changeDraft('second');
  await vi.advanceTimersByTimeAsync(4_000);
  expect(typing.mock.calls).toEqual([['alice', 'typing']]);
  await vi.advanceTimersByTimeAsync(500);
  expect(typing.mock.calls).toEqual([
    ['alice', 'typing'],
    ['alice', undefined],
  ]);
});

it.each(['failure', 'shutdown'] as const)('settles uploads on %s', async (scenario) => {
  const { session, tasks, upload, typing } = composerFixture();
  const request = controlledEffect<void, MessagingError>();
  upload.mockReturnValue(request.effect);
  session.attach([new File(['photo'], 'photo.png', { type: 'image/png' })]);
  session.send();
  await vi.waitFor(() => expect(request.pending()).toBe(1));
  expect(typing).toHaveBeenCalledWith('alice', 'uploading');
  if (scenario === 'failure') {
    request.fail(offline());
    await tasks.idle();
    expect(session.model().attachments).toHaveLength(1);
    expect(typing).toHaveBeenLastCalledWith('alice', undefined);
  } else {
    session.dispose();
    await tasks.close();
    expect(request.canceled()).toBe(1);
  }
});

it('passes decoded image dimensions to the outbox and releases the bitmap', async () => {
  const { session, tasks, upload } = composerFixture();
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width: 600, height: 400, close }));
  vi.stubGlobal('window', { createImageBitmap: decode });
  vi.stubGlobal('createImageBitmap', decode);
  const file = new File(['photo'], 'photo.png', { type: 'image/png' });
  session.attach([file]);
  session.send();
  await tasks.idle();
  expect(upload).toHaveBeenCalledExactlyOnceWith([
    { file, sendAs: 'media', width: 600, height: 400 },
  ]);
  expect(close).toHaveBeenCalledOnce();
});

it('cancels before uploading if shutdown happens while reading image dimensions', async () => {
  const { session, tasks, upload } = composerFixture();
  let finish!: (value: { width: number; height: number; close(): void }) => void;
  const decode = () =>
    new Promise<{ width: number; height: number; close(): void }>((resolve) => {
      finish = resolve;
    });
  vi.stubGlobal('window', { createImageBitmap: decode });
  vi.stubGlobal('createImageBitmap', decode);
  session.attach([new File(['photo'], 'photo.png', { type: 'image/png' })]);
  session.send();
  session.dispose();
  await tasks.close();
  const close = vi.fn();
  finish({ width: 600, height: 400, close });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(upload).not.toHaveBeenCalled();
});

it('restores the draft when persistence fails before the send can be accepted', async () => {
  const { session, tasks, draft, send } = composerFixture();
  const write = controlledEffect<void, MessagingError>();
  draft.mockReturnValueOnce(write.effect);
  session.changeDraft('keep this');
  session.send();
  write.fail(offline());
  await tasks.idle();
  expect(send).not.toHaveBeenCalled();
  expect(session.model().draft).toBe('keep this');
  expect(draft).toHaveBeenLastCalledWith('alice', 'keep this', undefined);
});

it('finishes an accepted send after its draft write even when the composer has closed', async () => {
  const { session, tasks, draft, send } = composerFixture();
  const write = controlledEffect<void, MessagingError>();
  draft.mockReturnValueOnce(write.effect);
  session.changeDraft('accepted');
  session.send();
  session.dispose();
  expect(send).not.toHaveBeenCalled();
  expect(write.canceled()).toBe(0);
  write.succeed(undefined);
  await tasks.idle();
  expect(send).toHaveBeenCalledExactlyOnceWith('alice', 'accepted');
});

it('restores a failed upload without waiting for the typing cleanup request', async () => {
  const { session, tasks, upload, typing } = composerFixture();
  const request = controlledEffect<void, MessagingError>();
  const cleanup = controlledEffect<void>();
  upload.mockReturnValue(request.effect);
  typing.mockImplementation((_peer, action) =>
    action === undefined ? cleanup.effect : Effect.void,
  );
  session.attach([new File(['photo'], 'photo.png', { type: 'image/png' })]);
  session.send();
  await vi.waitFor(() => expect(request.pending()).toBe(1));
  request.fail(offline());
  await vi.waitFor(() => expect(session.model().attachments).toHaveLength(1));
  expect(cleanup.pending()).toBe(1);
  cleanup.succeed(undefined);
  await tasks.idle();
});
