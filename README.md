# TeleVecha

A local-first Telegram web client built with SolidJS, Vite+, Tailwind CSS, and the MTProto code vendored from Telegram Web A.

The current client handles production-account login and logout, complete main and archived dialog lists, Telegram-wide peer search, paginated history and message search, focus-aware read receipts, live updates, formatted text, replies, reactions, forwarding, pinning, bot controls, multi-file/photo uploads with progress, media albums, and Telegram sticker formats. IndexedDB stores a bounded disposable cache, local-only drafts, the Telegram session, and an account-bound durable send queue. Installed builds cache their application shell for offline startup and publish the total unread count through the browser application-badge API when it is available.

## Run it

TeleVecha requires Node.js 22.12 or newer.

```sh
npm install
npm run dev
```

Open the URL printed by Vite+. TeleVecha blocks a second active tab because two independent update consumers sharing one browser cache can corrupt the local cursor.

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
npm test
npm run test:coverage
npm run test:e2e
npm run test:all
npm run build
```

Playwright uses port 4174 by default. Set `TELEVECHA_E2E_PORT` when that port is already in use.

The unit suite covers the messaging engine, IndexedDB migrations and bounds, tab lease, and Telegram adapter mappings. The Playwright suite runs against a deterministic transport and a separate `televecha-e2e` database. It tests login and offline states, desktop and phone navigation, drafts, sends and failed-outbox recovery, focus-aware read receipts, uploads, lazy media caching, live edits and deletions, history/search/shared-media pagination, scroll anchoring and render bounds, modal focus, reload persistence, layout containment, and the two-tab lock. It never opens a production Telegram session.

## Current limits

Static WebP, video, and TGS/Lottie stickers render in chat; animated media plays only while hovered or focused. Voice notes and rectangular video messages play inline, grouped media albums render as grids, and Telegram service events appear in history. Attachments can be staged together, sent as compressed media or files, cropped and rotated before upload, and replaced while Telegram still permits editing. Bot commands, start/restart flows, reply keyboards, inline callbacks, links, and copy buttons are supported. Calls, stories, secret chats, threaded topics, and Telegram cloud drafts are outside the current scope.

The files under `src/vendor/weba` come from Telegram Web A. See its `UPSTREAM.md` and `LICENSE` for the pinned revision and license. TeleVecha is licensed under GPL-3.0-or-later.
