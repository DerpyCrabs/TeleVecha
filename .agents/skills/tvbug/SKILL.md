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
