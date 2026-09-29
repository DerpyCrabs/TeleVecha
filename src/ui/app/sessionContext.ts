import type { QueryCache } from 'effectweb';

/** What a session needs from the app: the shared query cache and a change notification. */
export interface SessionContext<R = never> {
  readonly cache: QueryCache<R>;
  readonly changed: () => void;
}
