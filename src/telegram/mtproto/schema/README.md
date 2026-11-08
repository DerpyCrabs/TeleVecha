# Telegram TL schema

These files are generated inputs for TeleVecha's TL generator. TeleVecha does not load them at
runtime.

## Pinned official sources

The layer 233 application schema comes from Telegram's official TDLib repository at commit
[`562a82abf952fdaf808aca67a1dc5e2698aa0dd3`](https://github.com/tdlib/td/commit/562a82abf952fdaf808aca67a1dc5e2698aa0dd3),
whose commit title is `Update layer to 233`:

- [`telegram_api.tl`](https://raw.githubusercontent.com/tdlib/td/562a82abf952fdaf808aca67a1dc5e2698aa0dd3/td/generate/scheme/telegram_api.tl),
  SHA-256 `89bf71464239646c233f0a2a3d77512c9be08e4a63eab362afba0b721f69a26d`
- [`mtproto_api.tl`](https://raw.githubusercontent.com/tdlib/td/562a82abf952fdaf808aca67a1dc5e2698aa0dd3/td/generate/scheme/mtproto_api.tl),
  SHA-256 `bde4942be06dc112dfc655e2a8aa5163a4e3aa0d859d7840cfc76ec3a00654c4`

TDLib is distributed under the Boost Software License 1.0. The pinned
[`LICENSE_1_0.txt`](https://raw.githubusercontent.com/tdlib/td/562a82abf952fdaf808aca67a1dc5e2698aa0dd3/LICENSE_1_0.txt)
has SHA-256 `c9bff75738922193e67fa726fa225535870d2aa1059f91452c411736284ad566`.
The required statement is included beside these inputs as the
[Boost Software License 1.0](LICENSE).

Current TDLib no longer lists `server_DH_params_fail`, but TeleVecha's authorization handshake must
decode that response. The canonicalizer extracts this one declaration from Telegram's older TDLib
commit
[`b18b5309b69b5684405d998a2cce80a49ad474ef`](https://github.com/tdlib/td/commit/b18b5309b69b5684405d998a2cce80a49ad474ef):

- [`mtproto_api.tl`](https://raw.githubusercontent.com/tdlib/td/b18b5309b69b5684405d998a2cce80a49ad474ef/td/generate/scheme/mtproto_api.tl),
  SHA-256 `d0cac1b70002bbfddace3f52781d500079b49d6777e56668ca82281ed633d470`

Telegram removed that declaration from TDLib in commit
[`397274daf7ad7282061286dc555cc6a8c88307e1`](https://github.com/tdlib/td/commit/397274daf7ad7282061286dc555cc6a8c88307e1).

The MTProto wire normalization was checked against Telegram's public
[`core.telegram.org/schema/mtproto`](https://core.telegram.org/schema/mtproto) page. The normalized
TL code block used for the check has SHA-256
`b3ef6a9533b772fdcf2a6d8dd236092f799ad8907ab4ca2615e42bded246da4c`.

Telegram's `core.telegram.org/schema` and `core.telegram.org/schema/json` endpoints exposed layer
223 when this snapshot was prepared on 2026-08-29. The canonical JSON response had SHA-256
`287817f49fea78191c5f4342ad683ba2aed6c3bc2acc89757fc64f68ea24d846`. Those endpoints cannot by
themselves reproduce layer 233, so the immutable official TDLib commit is the structural source.

## Canonicalization

Run [`scripts/fetch-telegram-tl.mjs`](../../../../scripts/fetch-telegram-tl.mjs) to fetch the pinned
files and write deterministic TL:

- Constructor IDs are lowercase, zero-padded eight-digit hexadecimal values.
- Definitions are sorted by TL name inside the types and functions sections.
- TDLib's primitive declarations, compiler test hooks, prefix helpers, legacy compiler-only file
  locations, and TDLib-only ephemeral declarations are not emitted.
- Binary MTProto fields that TDLib represents as C++ `string` values are emitted as `bytes`, which
  matches Telegram's public MTProto schema and TeleVecha's codec.
- TDLib's commented wire declarations for RPC results, containers, the bare message record, session
  destruction, and ping are restored with their published IDs. The bare message uses the internal
  name `mtproto.message` and descriptor ID zero because it has no constructor ID on the wire.
- No fake-TLS block definitions are emitted.

The committed canonical files are:

- `api-layer-233.tl`, SHA-256
  `9f90084f34e7a686cc8a741fd8a4fa0f00f0ccdcc03b592d49c46d0fffca5b7c`
- `mtproto.tl`, SHA-256
  `d0c36bc9fcdf0a382c952a3ad94ab7fd9811c71e906756ce2a3e75b2ddb3029b`

The runtime catalog includes all constructors and the methods used by the application.
Layer 233 adds rich document blocks and separates reply and inline keyboard button types.

## Refresh and checks

Refresh the canonical schema files from the pinned official commits, then regenerate TypeScript:

```sh
npm run fetch:telegram-tl
npm run generate:telegram-tl
```

Check both provenance inputs and generated output without writing files:

```sh
npm run check:telegram-tl-sources
npm run check:telegram-tl
```

After any intentional layer change, inspect both schema diffs, update `LAYER` in
`src/telegram/mtproto/tl/types.ts`, update every pinned commit and hash in the fetcher and this file,
then run:

```sh
npm run generate:telegram-tl
npm run check:telegram-tl
npm test -- src/telegram/mtproto/tl/codec.test.ts
npm run check
```
