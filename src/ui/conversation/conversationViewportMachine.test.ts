import { describe, expect, it } from 'vitest';

import {
  transitionConversationViewport,
  type ConversationViewportEvent,
  type ConversationViewportState,
} from './conversationViewportMachine';

const states: ConversationViewportState[] = ['present', 'history'].flatMap((mode) =>
  ['positioning', 'ready'].flatMap((phase) =>
    ['idle', 'loading'].map((pagination) => ({ mode, phase, pagination })),
  ),
) as ConversationViewportState[];

describe('conversation viewport machine', () => {
  it.each([
    'viewport-scrolled',
    'geometry-changed',
    'content-changed',
    'reading-anchor-requested',
  ] as const)('%s never changes the semantic scroll mode', (type) => {
    for (const state of states) {
      expect(transitionConversationViewport(state, { type }).state).toEqual(state);
    }
  });

  it.each(['jump-to-present', 'conversation-empty'] as const)(
    '%s always enters present mode and pins it',
    (type) => {
      for (const state of states) {
        const transition = transitionConversationViewport(state, { type });
        expect(transition.state).toEqual({ ...state, mode: 'present' });
        expect(transition.effects).toContain('pin-present');
      }
    },
  );

  it.each(['user-left-present', 'history-target-opened'] as const)(
    '%s always enters history mode with an anchor',
    (type) => {
      for (const state of states) {
        const transition = transitionConversationViewport(state, { type });
        expect(transition.state).toEqual({ ...state, mode: 'history' });
        expect(transition.effects).toContain('capture-reading-anchor');
      }
    },
  );

  it('requests one older page only from idle history at the top', () => {
    for (const state of states) {
      for (const canLoad of [false, true]) {
        const transition = transitionConversationViewport(state, {
          type: 'top-reached',
          canLoad,
        });
        const shouldLoad = state.mode === 'history' && state.pagination === 'idle' && canLoad;
        expect(transition.effects.includes('request-older')).toBe(shouldLoad);
        expect(transition.state.pagination).toBe(shouldLoad ? 'loading' : state.pagination);
      }
    }
  });

  it('cannot request another page until the current request settles', () => {
    let state: ConversationViewportState = {
      mode: 'history',
      phase: 'ready',
      pagination: 'idle',
    };
    const first = transitionConversationViewport(state, { type: 'top-reached', canLoad: true });
    state = first.state;
    expect(first.effects).toEqual(['request-older']);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const repeated = transitionConversationViewport(state, {
        type: 'top-reached',
        canLoad: true,
      });
      state = repeated.state;
      expect(repeated.effects).toEqual([]);
    }

    state = transitionConversationViewport(state, { type: 'older-load-settled' }).state;
    expect(
      transitionConversationViewport(state, { type: 'top-reached', canLoad: true }).effects,
    ).toEqual(['request-older']);
  });

  it('keeps present mode through every sequence of non-semantic events', () => {
    const events: ConversationViewportEvent[] = [
      { type: 'viewport-scrolled' },
      { type: 'geometry-changed' },
      { type: 'content-changed' },
      { type: 'reading-anchor-requested' },
      { type: 'viewport-ready' },
      { type: 'viewport-hidden' },
      { type: 'older-load-settled' },
      { type: 'top-reached', canLoad: true },
    ];
    for (const first of events) {
      for (const second of events) {
        for (const third of events) {
          let state: ConversationViewportState = {
            mode: 'present',
            phase: 'ready',
            pagination: 'idle',
          };
          state = transitionConversationViewport(state, first).state;
          state = transitionConversationViewport(state, second).state;
          state = transitionConversationViewport(state, third).state;
          expect(state.mode).toBe('present');
        }
      }
    }
  });

  it('resets every state to one positioning state and one positioned state', () => {
    for (const state of states) {
      expect(transitionConversationViewport(state, { type: 'peer-reset' }).state).toEqual({
        mode: 'present',
        phase: 'positioning',
        pagination: 'idle',
      });
      expect(transitionConversationViewport(state, { type: 'peer-positioned' })).toEqual({
        state: { mode: 'present', phase: 'ready', pagination: 'idle' },
        effects: ['pin-present'],
      });
    }
  });

  it('lifecycle and load completion change only their owned state axis', () => {
    const phaseEvents: Array<[ConversationViewportEvent, ConversationViewportState['phase']]> = [
      [{ type: 'viewport-ready' }, 'ready'],
      [{ type: 'viewport-hidden' }, 'positioning'],
    ];
    for (const state of states) {
      for (const [event, phase] of phaseEvents) {
        expect(transitionConversationViewport(state, event).state).toEqual({ ...state, phase });
      }
      expect(transitionConversationViewport(state, { type: 'older-load-settled' }).state).toEqual({
        ...state,
        pagination: 'idle',
      });
    }
  });
});
