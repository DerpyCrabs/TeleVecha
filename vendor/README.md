# Telegram widget sandbox

Pinned upstream: [TelegramMessenger/widget-sandbox v0.6.0](https://github.com/TelegramMessenger/widget-sandbox/tree/d6f39f3bc9a126aa418a1ac74825d84d6144183e),
commit `d6f39f3bc9a126aa418a1ac74825d84d6144183e`.

Upstream packages are private workspace packages. The two npm archives retain the official
QuickJS worker, DOM shim, validator, renderer and WASM. The core package is mechanically
transpiled to ES2022 JavaScript so Node can load its Vite plugin; explicit `.ts` import paths
are changed to `.js`, and the workspace QuickJS dependency is assigned its package version.
No sandbox behavior is patched. Parser versions are pinned to the upstream lockfile because
its bundle transformations depend on their source layout.

Rebuild after `npm ci` with `node scripts/vendor-widget-sandbox.mjs`, then `npm install`.
The script fetches the immutable revision into a temporary directory and packs both packages.
The accompanying upstream third-party notices are retained; the QuickJS package includes its
license texts. The application license does not replace upstream notices.

SHA-256:

- `telegram-widget-sandbox-0.6.0.tgz`: `b63a58e275c9f2dce95237c7bcc1fad180cdda4f2ec92145d720a919d0c1e2cb`
- `telegram-widget-sandbox-quickjs-0.32.0-fork.tgz`: `07139ed24038e6f02ddb5eb02fa053390da279e5797959c8f96a74c4c10c2353`

The viewer runs at `/widget.html` in a separate COOP/COEP-isolated window. This supplies
SharedArrayBuffer to the official runtime without isolating the messenger or breaking embedded
bot Mini Apps. Widget code runs inside QuickJS, not in the app's JavaScript context. Only
message-scoped bot data queries and validated external links are bridged. Wallet calls are
unavailable. Widget HTML and bot data are excluded from tvbug exports.

Reference checkouts refreshed for the layer 233 implementation:

- Telegram Desktop `7381fb1df75d863eb3463fdddef57a2ac51f1d56`
- Telegram Web A `6002824b6532f3d913997ce496d9ab5f9b86bc22`
