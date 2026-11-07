export interface ConversationViewportState {
  mode: 'present' | 'history';
  phase: 'positioning' | 'ready';
  pagination: 'idle' | 'loading';
}

export type ConversationViewportEvent =
  | { type: 'peer-reset' }
  | { type: 'peer-positioned' }
  | { type: 'viewport-ready' }
  | { type: 'viewport-hidden' }
  | { type: 'user-left-present' }
  | { type: 'present-visible' }
  | { type: 'jump-to-present' }
  | { type: 'history-target-opened' }
  | { type: 'conversation-empty' }
  | { type: 'reading-anchor-requested' }
  | { type: 'viewport-scrolled' }
  | { type: 'geometry-changed' }
  | { type: 'content-changed' }
  | { type: 'top-reached'; canLoad: boolean }
  | { type: 'older-load-settled' };

export type ConversationViewportEffect =
  | 'pin-present'
  | 'capture-reading-anchor'
  | 'preserve-reading-anchor'
  | 'request-older';

export interface ConversationViewportTransition {
  state: ConversationViewportState;
  effects: ConversationViewportEffect[];
}

export const initialConversationViewportState: ConversationViewportState = {
  mode: 'present',
  phase: 'ready',
  pagination: 'idle',
};

/** The complete state transition table for conversation scrolling and pagination. */
export function transitionConversationViewport(
  state: ConversationViewportState,
  event: ConversationViewportEvent,
): ConversationViewportTransition {
  switch (event.type) {
    case 'peer-reset':
      return { state: { mode: 'present', phase: 'positioning', pagination: 'idle' }, effects: [] };
    case 'peer-positioned':
      return {
        state: { mode: 'present', phase: 'ready', pagination: 'idle' },
        effects: ['pin-present'],
      };
    case 'viewport-ready':
      return { state: { ...state, phase: 'ready' }, effects: [] };
    case 'viewport-hidden':
      return { state: { ...state, phase: 'positioning' }, effects: [] };
    case 'user-left-present':
    case 'history-target-opened':
      return { state: { ...state, mode: 'history' }, effects: ['capture-reading-anchor'] };
    case 'present-visible':
      return { state: { ...state, mode: 'present' }, effects: [] };
    case 'jump-to-present':
    case 'conversation-empty':
      return { state: { ...state, mode: 'present' }, effects: ['pin-present'] };
    case 'viewport-scrolled':
      return { state, effects: ['capture-reading-anchor'] };
    case 'reading-anchor-requested':
      return { state, effects: state.mode === 'history' ? ['capture-reading-anchor'] : [] };
    case 'geometry-changed':
    case 'content-changed':
      return {
        state,
        effects: [state.mode === 'present' ? 'pin-present' : 'preserve-reading-anchor'],
      };
    case 'top-reached':
      if (state.mode !== 'history' || state.pagination !== 'idle' || !event.canLoad) {
        return { state, effects: [] };
      }
      return { state: { ...state, pagination: 'loading' }, effects: ['request-older'] };
    case 'older-load-settled':
      return { state: { ...state, pagination: 'idle' }, effects: [] };
  }
}
