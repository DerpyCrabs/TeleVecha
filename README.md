# TeleVecha

A local-first Telegram web client built with SolidJS, Vite+, Tailwind CSS, and a project-owned browser MTProto implementation.

The current client handles production-account login and logout, complete main and archived dialog lists, Telegram-wide peer search, paginated history and message search, focus-aware read receipts, live updates, formatted text, replies, reactions, forwarding, pinning, bot controls, multi-file/photo uploads with progress, media albums, and Telegram sticker formats. IndexedDB stores a bounded disposable cache, local-only drafts, the Telegram session, and an account-bound durable send queue. Offline caching covers Telegram and user data, including drafts and queued sends. HTML, CSS, and other application assets are not cached by a service worker. The client publishes the total unread count through the browser application-badge API when it is available.

## Run it

TeleVecha requires Node.js 22.12 or newer.

```sh
npm install
npm run dev
```

Open the URL printed by Vite+. Multiple tabs share one elected Telegram sync owner. Each tab keeps independent navigation while commands, updates, and owner failover travel through a versioned browser channel. Drafts are restored when entering a chat and saved for offline recovery; typing is not mirrored into another open composer. The Web Locks and Broadcast Channel APIs are required so TeleVecha can prevent competing update consumers from corrupting the shared cursor.

The owner has no selected conversation. It owns only account-scoped transport, persistence, synchronization, and durable delivery. A tab binds commands to a peer immediately and owns its own conversation projection. Lost cross-tab responses are retried with the same request ID, so the owner can return its recorded result without executing the command again; an unconfirmed command fails explicitly instead of waiting forever.

## Register a Telegram application

Telegram's separate test-account system is not needed. Use your normal account against the production network.

1. Sign in at [my.telegram.org](https://my.telegram.org).
2. Open **API development tools**.
3. Create an application. Telegram requires a title and short name. The platform choice does not change TeleVecha's browser transport.
4. Copy the numeric `api_id` and the `api_hash` into `.env`:

   ```dotenv
   VITE_TELEGRAM_API_ID=123456
   VITE_TELEGRAM_API_HASH=your_api_hash
   ```

   Restart the dev server after changing the file. Vite reads these values at startup.

5. Enter your phone in international format. Telegram normally delivers the login code to an existing Telegram session.

The browser stores the MTProto authorization session locally. The application credentials only come from the Vite environment. TeleVecha never asks the user to enter them. Do not run the app on a shared browser profile.

## Sync behavior

TeleVecha does not replay every update since the last time it ran.

- On first login, it records Telegram's current update cursor and fetches current dialog heads.
- On later starts, it atomically reconciles a bounded global difference of at most 100 PTS events and reconciles channels with their own PTS cursors.
- If Telegram reports a larger gap, TeleVecha starts a new cache epoch, records the current cursor, and fetches current dialogs plus the newest page when you open a chat. Channel gaps invalidate only that channel's cached history.
- If the connection drops after startup, cached chats remain readable and new messages enter the durable outbox immediately for delivery after reconnect.
- While the app remains open, failed reconnects retry with exponential backoff up to 30 seconds.
- Incoming messages are marked read only when their conversation is active, the window is focused and visible, no modal or mobile drawer obscures it, and the user is at the present edge.
- Confirmed dialog and message mutations update the local projection immediately. Their Telegram update envelopes remain ordered behind any active synchronization, so a long catch-up cannot make a successful interaction appear ignored.
- Drafts never use Telegram cloud drafts.
- Every outgoing item enters IndexedDB before network delivery. Retries reuse the same Telegram `random_id`; failed entries can be retried or cancelled and are never delivered under a different account.

## Commands

```sh
npm run check
npm run check:telegram-tl
npm run check:telegram-tl-sources
npm test
npm run test:coverage
npm run test:e2e
npm run test:all
npm run build
```

Playwright uses port 4174 by default. Set `TELEVECHA_E2E_PORT` when that port is already in use.

## Inspect a debug report

Open a `.tvbug` snapshot without signing in or contacting Telegram:

```sh
npm run tvbug -- report.tvbug
npm run tvbug -- --headless --screenshot result.png report.tvbug
npm run tvbug -- --serve report.tvbug
```

The inspector opens Chromium when a display is available. Use `--headless` for an unattended run, `--screenshot result.png` to capture the snapshot, or `--serve` to print a local URL without opening a browser. It serves the app on port 4175 by default; set `TELEVECHA_TVBUG_PORT` if that port is busy. The browser can contact only that exact local Vite origin. Captured IANA timezones are applied; offset-only reports fall back to the host timezone with a warning when the offset is not a whole hour.

A `.tvbug` file is a ZIP containing `manifest.json`, `snapshot.v2.json`, and `trace.v2.ndjson`. The snapshot captures the current runtime flags and errors, up to 250 dialogs, the latest 500 messages from the active conversation, up to 100 pending sends, the active draft, UI settings, and a fresh cache cursor. The trace keeps only the latest 300 UI and diagnostic events. Telegram transport calls are not included.

Message text is replaced with generated text that keeps the original UTF-16 length, line breaks, and formatting offsets. Media payloads are omitted, but their kind, byte size, dimensions, duration, and MIME family remain so the app can reconstruct layout. Account identifiers are replaced with bundle-local aliases, timestamps move to a fixed epoch, and the file contains no Telegram session, authorization key, phone number, access hash, file reference, or cached media bytes. If the viewer cannot open a report, use any ZIP reader to inspect its files directly.

The unit suite covers the messaging engine, IndexedDB migrations and bounds, tab election, and Telegram adapter mappings. The Playwright suite runs against a deterministic transport and a separate `televecha-e2e` database. It tests login and offline states, desktop and phone navigation, drafts, sends and failed-outbox recovery, focus-aware read receipts, uploads, lazy media caching, live edits and deletions, history/search/shared-media pagination, scroll anchoring and render bounds, modal focus, reload persistence, layout containment, independent two-tab conversations and drafts, and automatic owner failover. It never opens a production Telegram session.

## Current limits

Static WebP, video, and TGS/Lottie stickers render in chat; animated media plays only while hovered or focused. Voice notes and rectangular video messages play inline, grouped media albums render as grids, and Telegram service events appear in history. Attachments can be staged together, sent as compressed media or files, cropped and rotated before upload, and replaced while Telegram still permits editing. Bot commands, start/restart flows, reply keyboards, inline callbacks, links, and copy buttons are supported. Calls, stories, secret chats, threaded topics, and Telegram cloud drafts are outside the current scope.

TeleVecha generates tagged TypeScript objects and binary codec descriptors from a pinned Telegram TL schema. The generator exposes only the RPC methods the app calls, while the decoder retains the constructor coverage required for valid update envelopes. The protocol implementation uses functions, plain objects, and closure state.

## Module design

This branch experiments with Effect atoms and a shared Solid adapter across the app. See [the experiment notes](docs/effect-solid-experiment.md) for ownership rules, resource reads, validation, and the work that still requires array scans.

`src/telegram/core/engine.ts` composes the account runtime. It does not persist a selected conversation; `TabCoordinator` combines the account snapshot with a separate conversation projection for each tab, and the tab URL owns navigation persistence. UI code enters a selected chat through `openConversation`, which returns a handle that binds peer identity once. Drafts, sends, and explicit-peer mutations remain addressed to that peer even when history is loading or another tab changes its view. Only pagination and message-jump operations require that tab's projection to remain selected.

The engine's external dependencies live at two seams:

- `TelegramTransport` has production, deterministic fixture, and test adapters. The production adapter hides the project-owned MTProto client and translates tagged TL records into TeleVecha's domain types.
- `CacheStore` has IndexedDB and in-memory test adapters. Atomic latest-state and outbox operations keep persistence rules out of callers.

Engine implementation details remain internal. Effect Layers and scopes own runtime state and finalizers; `Deferred` separates local-command readiness from account readiness; `FiberSet`, `FiberMap`, `RcMap`, `Semaphore`, and `Schedule` own supervised work, keyed delays, serialization, and retry. IndexedDB write transactions use `acquireUseRelease`, deadlines, and abort cleanup. Effect Schema validates cached metadata, stored sessions, errors, and the multi-tab protocol envelope at their boundaries.

Start and retry join one connection operation. Stop interrupts that operation, closes the session's single update subscription, and drains accepted mutations before resetting state. `EngineTasks.runNetwork` follows caller cancellation. `runSession` and serialized writes finish accepted work even if the initiating UI request goes away; speculative reads should not acquire that lifetime. Metadata generations reject stale results without pretending to own their fibers. The coordinator owns the browser lease and declares each remote command's readiness, concurrency, and coalescing policy in one typed table.

Snapshot streams retain the newest complete value. Delta streams apply backpressure. The socket reader must remain available to dispatch RPC replies, so its bounded event backlog instead emits a session-gap event when it drops updates, preserving connection state for recovery. Do not add silently sliding buffers to update or invalidation streams.

Functional modules own peer histories, message revisions, dialog reconciliation, persisted peer metadata, coalesced read work, resource requests, version tokens, durable per-peer outbox ordering, tab presence, and request replay without exposing their mutable storage. They stay as plain functions where an Effect service would add ceremony without improving lifetime or failure semantics. In particular, Effect `LayerMap` is reserved for keyed scoped resources and Effect `Cache` for stable lookup functions with TTL or capacity; the app's race-versioned, caller-supplied loaders need different semantics and remain small dedicated modules.

UI workflow modules under `src/ui` own composer and expression state, bot and reply-keyboard behavior, contact details, conversation headers, responsive drawers, viewport layout, and global or chat-specific appearance. `App.tsx` composes those modules and renders the application shell. Solid signals hold immediate interaction state; the Effect runtime does not sit in the keystroke or render path. Tests exercise module interfaces and persistence seams rather than private engine maps or timers.

Solid state follows ownership. Signals hold writable interaction state, memos and derived accessors calculate values, and resources own reactive async reads. Effects are reserved for browser side effects, subscriptions, cleanup, and explicit invalidation workflows; `on` names the intended dependency when the effect also reads incidental state.

## License

TeleVecha's project-owned code is available under the [MIT License](LICENSE).
Pinned TL schema inputs and third-party dependencies retain their own licenses.
