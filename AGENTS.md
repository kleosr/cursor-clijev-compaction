# cursor-clijev-compaction

Cursor CLI (`agent`) only. Capture tool I/O, score keep/drop with TypeSafe Jev, re-inject after native compact.

## Load

Opt-in: `cursor-jev agent -- …` or `agent --plugin-dir <this-repo>`.

Never writes `~/.cursor/hooks.json`, project `.cursor/hooks.json`, or CLI config.

## Layout

- `src/` — decision engine, Cursor JSONL/store, hooks, wrapper
- `hooks/hooks.json` — plugin hooks (loaded only via `--plugin-dir`)
- `.cursor-plugin/plugin.json` — plugin manifest
- `.data/` — runtime store (gitignored; `CURSOR_JEV_HOME` overrides)

## Proof

```sh
pnpm test
pnpm typecheck
```
