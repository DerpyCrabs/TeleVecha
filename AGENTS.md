# TeleVecha Engineering Rules

Use `npm run fmt` for Oxfmt formatting and `npm run check` for formatting, Oxlint, and type checks. These commands use the shared configuration in `vite.config.ts`.

EffectWeb UI code follows `node_modules/effectweb/docs/README.md` (the documentation of the installed version; `choosing-apis.md` picks the API): render JSX rows with `list`, use structural run keys (`['name', id]` for per-row work), and keep `effectweb/identity` lint warnings at zero in new code.
