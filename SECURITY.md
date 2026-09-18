# Security

- Scoring always uses TypeSafe Jev (`POST https://api.typesafe.ai/v1/systemone`, `jev-latest`). There is no stub scorer.
- `TYPESAFE_API_KEY` is read from the environment only. Do not commit it, put it in source, or print it.
- This package never writes `~/.cursor/hooks.json`, `~/.cursor/cli-config.json`, or another project’s hooks.
- Runtime state is `<plugin>/.data/` or `CURSOR_JEV_HOME`. Treat it as local conversation residue.
- Cursor CLI hooks fail open (`failClosed: false`) so a missing key or TypeSafe outage cannot block `agent`.
- `stop` is capped with `loop_limit: 1` so recovery cannot follow-up-loop.
