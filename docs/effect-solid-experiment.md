# Effect resources with the Solid renderer

This branch tries the shared-model approach across TeleVecha. Solid still compiles JSX and updates the DOM. Effect 4 atoms represent snapshot fields, rendered entities, and UI resources. There is no new renderer or compiler here.

The baseline is `be38f92` on `main`. The experiment is on `experiment/effect-solid-ui`.

## Ownership

- The Telegram engine remains responsible for synchronization, durable Telegram/user data, the optimistic outbox, and coordinating tabs. HTML and CSS are not added to the offline cache.
- `src/ui/reactivity/model.ts` owns field atoms, structural sharing, resource definitions, invalidation, and cursor pagination. One app has one registry, disposed with the app.
- `src/ui/reactivity/solid.tsx` contains the subscription adapter. Components read accessors instead of maintaining copies of resource results and loading/error flags.
- Solid continues to own interaction state such as draft editing, open menus, selections, scroll position, and playback. Commands still run as Effects through the application runtime.

## Resource reads

The same consumer can read a synchronous value, a synchronous Effect, or an asynchronous Effect:

```tsx
const [profile, resource] = createUiResource(
  () => selectedPeerId(),
  (id) => source.getProfile(id),
  { namespace: 'profiles' },
);

// source.getProfile can later return a cached value or an Effect.
// Callers still use profile(), profile.loading, and profile.error.
// resource.state() exposes the underlying Effect AsyncResult.
```

An initial load has no available value. Refreshing the same key retains its previous success while `loading` is true. Changing keys immediately stops displaying the old key's result. A successful `undefined` value can be distinguished from initial state through `resource.state()`.

Unnamed resources own the current read and release it when the input changes or the consumer is disposed. Media views use this mode because MediaAssets already owns their caching and object URLs. Named resources share their values and in-flight work. Their idle lifetime is 30 seconds; this is a UI reuse policy, separate from durable engine caching. Object request arguments need an explicit key containing the inputs that identify the resource. Invalidation refreshes the relevant definitions. Account transitions replace resource definitions and interrupt old work. Effect loaders support interruption. Compatibility Promise loaders discard obsolete results; canceling their underlying work remains the producer's responsibility.

Pagination has the same key isolation. The resource retains successful pages after an error, retries the failed cursor, deduplicates items, and stops at the final page. Components own the user's query and selected scope, while the resource owns results and cursor progress.

## Granularity and limits

Snapshot fields are separate atoms. A draft update does not invalidate the messages field. Rendered chat and message records retain their identity, with an atom for each observed field. Optimistic messages retain the existing random-ID key when Telegram confirms them.

Presentation caches reuse unchanged message and dialog projections. The focused tests check one field update among 1,000 observed entities and verify that editing one message preserves the other 999 projections. Read receipts and reply-target edits still update the affected projections.

The app still traverses snapshot arrays to reconcile membership and ordering. Layout and filters can still scan their inputs. These tests do not establish a whole-app speedup, and structural sharing does not turn arbitrary root-array computations into granular dependencies. Removing those scans would require changes to the engine's publication model or a later compiler experiment.

## Tabs and drafts

Different chats can remain open in different tabs and share one Telegram connection. A follower can take over when the connection-owning tab closes.

The composer restores a persisted draft when entering a chat, then owns its editing state. It saves changes for offline recovery but does not copy subsequent snapshot drafts into an open composer. The previous draft-authority and cross-tab conflict bookkeeping has been removed. Opening the same chat twice is not prohibited; that does not require a separate restriction or coordination mechanism.

## Validation

Run `npm run test:all` for generated Telegram bindings, formatting, lint/type checks, unit tests, browser tests, and a production build. The focused reactivity tests are in `src/ui/reactivity/model.test.ts` and `src/ui/conversation/conversationPresentation.test.ts`. Existing browser tests cover DOM identity, offline restoration, optimistic sends, searches, media, authentication, and tab takeover.

Verified on 2026-09-05: the complete command passed, with 294 unit tests and 293 browser tests. Browser coverage took 7.5 minutes. The production build took 887 ms and retained the existing large-chunk warning.

| Production JavaScript, gzip | Baseline `be38f92` | Experiment |
| --------------------------- | -----------------: | ---------: |
| Main chunk                  |          172.53 KB |  177.62 KB |
| Telegram chunk              |          181.22 KB |  182.07 KB |

The combined increase is 5.94 KB gzip. No dependencies were added. This is a bundle-cost comparison, not a runtime benchmark.
