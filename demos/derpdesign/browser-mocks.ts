/** Fixture-only, per-pane ownership model for engines without Web Locks.
 * This intentionally supports only TeleVecha's nonblocking exclusive lease.
 * It is not a cross-tab Web Locks polyfill and must never ship in the app.
 */
export function installFixtureLocks() {
  if (navigator.locks) return;
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      async request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>) {
        if (
          options.mode !== 'exclusive' ||
          options.ifAvailable !== true ||
          options.steal ||
          options.signal
        )
          throw Error('The demo lock mock supports only nonblocking exclusive fixture leases');
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          return await callback({ name, mode: 'exclusive' });
        } finally {
          held.delete(name);
        }
      },
      async query() {
        return { held: [...held].map((name) => ({ name, mode: 'exclusive' })), pending: [] };
      },
    },
  });
}
