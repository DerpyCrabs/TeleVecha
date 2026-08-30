# TeleVecha

A local-first Telegram web client built with SolidJS, Vite+, Tailwind CSS, and a project-owned browser MTProto implementation.

The current client handles production-account login and logout, complete main and archived dialog lists, Telegram-wide peer search, paginated history and message search, focus-aware read receipts, live updates, formatted text, replies, reactions, forwarding, pinning, bot controls, multi-file/photo uploads with progress, media albums, and Telegram sticker formats. IndexedDB stores a bounded disposable cache, local-only drafts, the Telegram session, and an account-bound durable send queue. Installed builds cache their application shell for offline startup and publish the total unread count through the browser application-badge API when it is available.

## Run it

TeleVecha requires Node.js 22.12 or newer.

```sh
npm install
npm run dev
```

Open the URL printed by Vite+. Multiple tabs share one elected Telegram sync owner. Each tab keeps independent navigation while commands, drafts, updates, and owner failover travel through a versioned browser channel. The Web Locks and Broadcast Channel APIs are required so TeleVecha can prevent competing update consumers from corrupting the shared cursor.

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
- If the connection drops after startup, cached chats remain readable and the UI offers an explicit reconnect. Sending stays disabled until Telegram is online.
- While the app remains open, failed reconnects retry with exponential backoff up to 30 seconds.
- Incoming messages are marked read only when their conversation is active, the window is focused and visible, no modal or mobile drawer obscures it, and the user is at the present edge.
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

## Replay a debug report

Open a `.tvbug` report without signing in or contacting Telegram:

```sh
npm run replay -- report.tvbug
npm run replay -- --headless --screenshot result.png report.tvbug
npm run replay -- --serve-only report.tvbug
```

The launcher opens Chromium when a display is available. Use `--headless` for an unattended run, `--screenshot result.png` to capture the final viewport, or `--serve-only` to print a local URL without opening a browser. It serves the app on port 4175 by default; set `TELEVECHA_REPLAY_PORT` if that port is busy. The replay browser can contact only that exact local Vite origin. Captured IANA timezones are reproduced; older offset-only reports fall back to the host timezone with a warning when the offset is not a whole hour.

A `.tvbug` file contains a sanitized starting state and an ordered transport timeline. Message text is replaced with generated text that keeps the original UTF-16 length, line breaks, and formatting offsets. Media payloads are omitted, but their kind, byte size, dimensions, duration, and MIME family remain so the app can reconstruct layout. Account identifiers are replaced with bundle-local aliases, timestamps move to a fixed epoch, and the file contains no Telegram session, authorization key, phone number, access hash, file reference, or cached media bytes.

The unit suite covers the messaging engine, IndexedDB migrations and bounds, tab election, and Telegram adapter mappings. The Playwright suite runs against a deterministic transport and a separate `televecha-e2e` database. It tests login and offline states, desktop and phone navigation, drafts, sends and failed-outbox recovery, focus-aware read receipts, uploads, lazy media caching, live edits and deletions, history/search/shared-media pagination, scroll anchoring and render bounds, modal focus, reload persistence, layout containment, independent two-tab conversations, synchronized drafts, and automatic owner failover. It never opens a production Telegram session.

## Current limits

Static WebP, video, and TGS/Lottie stickers render in chat; animated media plays only while hovered or focused. Voice notes and rectangular video messages play inline, grouped media albums render as grids, and Telegram service events appear in history. Attachments can be staged together, sent as compressed media or files, cropped and rotated before upload, and replaced while Telegram still permits editing. Bot commands, start/restart flows, reply keyboards, inline callbacks, links, and copy buttons are supported. Calls, stories, secret chats, threaded topics, and Telegram cloud drafts are outside the current scope.

TeleVecha generates tagged TypeScript objects and binary codec descriptors from a pinned Telegram TL schema. The generator exposes only the RPC methods the app calls, while the decoder retains the constructor coverage required for valid update envelopes. The protocol implementation uses functions, plain objects, and closure state.

## Module design

`src/telegram/core/engine.ts` is the application messaging module. UI code observes its snapshot and enters a selected chat through `openConversation`. The returned conversation binds the peer identity and owns chat-scoped commands, so callers do not repeat peer parameters or rely on an undocumented selection order.

The engine's external dependencies live at two seams:

- `TelegramTransport` has production, deterministic fixture, and test adapters. The production adapter hides the project-owned MTProto client and translates tagged TL records into TeleVecha's domain types.
- `CacheStore` has IndexedDB and in-memory test adapters. Atomic latest-state and outbox operations keep persistence rules out of callers.

Engine implementation details remain internal. `PendingSendQueue` owns durable per-peer ordering, `RetryScheduler` owns reconnect timing, and `ResourceCache` owns request coalescing, cached metadata, and stale-media versioning. UI workflow modules under `src/ui` own composer and expression state, bot and reply-keyboard behavior, contact details, conversation headers, responsive drawers, viewport layout, and global or chat-specific appearance. `App.tsx` composes those modules and renders the application shell. Tests should exercise the modules through their interfaces rather than their internal maps or timers.

Solid state follows ownership. Signals hold writable interaction state, memos and derived accessors calculate values, and resources own reactive async reads. Effects are reserved for browser side effects, subscriptions, cleanup, and explicit invalidation workflows; `on` names the intended dependency when the effect also reads incidental state.

## License

TeleVecha's project-owned code is available under the [MIT License](LICENSE).
Pinned TL schema inputs and third-party dependencies retain their own licenses.
