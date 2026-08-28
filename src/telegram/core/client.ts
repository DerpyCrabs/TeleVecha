import type { MessagingEngine } from './engine';

/**
 * The messaging interface consumed by the UI. Local owners and remote followers
 * both satisfy this seam; callers do not need to know which adapter is active.
 */
export type MessagingClient = Pick<MessagingEngine, keyof MessagingEngine>;
