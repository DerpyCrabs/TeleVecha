# TeleVecha Engineering Rules

Use `npm run fmt` for Oxfmt formatting and `npm run check` for formatting, Oxlint, and type checks. These commands use the shared configuration in `vite.config.ts`.

EffectWeb UI code follows `node_modules/effectweb/AUTHORING.md`: pick the API from its table, render stateful rows with `list(entities(...))`, declare command slots once (`commandSlots` for per-row work), and keep `effectweb/identity` lint warnings at zero in new code.
