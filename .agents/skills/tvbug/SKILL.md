---
name: tvbug
description: Inspect TeleVecha .tvbug reports and extract the most likely cause from their sanitized snapshot and trace. Use when debugging, opening, or explaining a .tvbug file.
---

# Inspect a tvbug report

Treat the report as evidence, not as a recording that must execute successfully.

Start with the smallest useful view:

1. Read `manifest.json` for the producer version, capture completeness, environment, and privacy profile.
2. Read the snapshot summary. Prioritize `runtime` errors and flags, `workspace`, `ui`, the active conversation, failed `pending` items, and collection counts. Do not print every dialog or message unless the bug requires it.
3. Read only the end of the trace and the events immediately before an error or relevant UI action. Prefer the stable diagnostic `code` over synthetic message text.

Try the read-only viewer when visual state matters:

```sh
npm run tvbug -- /absolute/path/report.tvbug
```

Do not patch application behavior merely to make an old report open. If the viewer fails, inspect the archive directly. A `.tvbug` file is a ZIP:

```sh
unzip -l /absolute/path/report.tvbug
unzip -p /absolute/path/report.tvbug manifest.json | jq
unzip -p /absolute/path/report.tvbug snapshot.v2.json \
  | jq '{version, workspace, runtime, ui, counts: {dialogs: (.dialogs | length), messages: (.messages | length), pending: (.pending | length)}}'
unzip -p /absolute/path/report.tvbug trace.v2.ndjson | tail -100
```

State what the report directly shows, then label any inferred cause. Remember that identifiers and text are synthetic, timestamps are shifted, and media contains metadata rather than original bytes.

## Empty / unsupported message content

New captures retain `messages[].contentDiagnostic` alongside the cached message. It records
only the negotiated layer, public TL constructor IDs, text length, grouping presence,
document attribute constructor IDs, rich block constructors/counts, and mapping outcome.
It deliberately excludes source text, filenames, document IDs, access hashes and bytes.

- `server-unsupported`: Telegram sent `messageMediaUnsupported` for the negotiated layer;
  the original attachment type cannot be recovered from that response.
- `unmapped-media`: the source contained media without a mapped media/contact/poll/preview.
- `unmapped-rich-content`: rich blocks/documents were present but not fully mapped.
- `empty-source`: the decoded source had no supported content.
- `mapped`: compare the mapping evidence with the current snapshot/rendered result to
  investigate later cache, synchronization or presentation losses.

Constructor numbers are unsigned TL constructor IDs, not attachment identifiers. Resolve
with `constructorDescriptorFor(id)` in `src/telegram/mtproto/tl/registry.ts` or convert to hex
and look up the pinned `src/telegram/mtproto/schema/api-layer-*.tl` schema.
Missing `contentDiagnostic` means unknown provenance (older cache, older app, fixture,
or a message that did not pass through the full-message mapper), not an empty Telegram
response. Old reports cannot be retroactively enriched. A fresh capture needs the affected
message to have been received from Telegram by the updated client.
