# llamactl

Standalone process/cache/config/stats manager for multi-model llama.cpp
serving. Replaces the native `llama-server --models-preset` router for this
use case: it owns `llama-server.exe` child processes itself, so it can save
KV-cache state before evicting a model and restore it on the next load,
track profiles (same model, different flags), and record stats/errors to
SQLite for the dashboard.

This folder is self-contained and movable — nothing in it hardcodes a path
outside `LLAMACTL_HOME` (defaults to this folder).

## Setup

```
cd scripts\llamactl
npm install
npm run build
```

Edit `config/llamactl.toml`:
- `paths.llama_server_exe` — absolute path to your built `llama-server.exe`.
- `paths.cache_dir` — **must be an ASCII-only path** (e.g. `C:\cmodels\...`).
  llama-server mis-decodes non-ASCII bytes in path *arguments* it has to
  parse (model path, slot-save-path, chat-template path) — this is a known
  llama.cpp bug class, not specific to this tool. `llama_server_exe` itself
  is exempt (it's argv[0], Node resolves it directly).
- `global.api_key` — the Bearer token clients must send to llamactl's own
  API (`Authorization: Bearer <api_key>`). Children spawned by llamactl are
  unauthenticated/localhost-only by design — llamactl is the only thing
  that talks to them directly.
- `[models.*]` / `[profiles.*]` — see the shipped example for the schema.
  Reserved flags (`--port`, `--host`, `--model`, `-m`, `--api-key`,
  `--alias`, `--slot-save-path`) are injected by llamactl itself and
  rejected if present in `args`.

## Running

```
npm start
```

or double-click `scripts\LLAMACTL_TRAY.vbs` for a tray-icon launch (same
pattern as `scripts/winlauncher/ROUTER_TRAY.vbs`) — double-click the tray
icon to open the dashboard at `http://127.0.0.1:8080/ui/`.

**Only one of `scripts/winlauncher/start_router.bat` or llamactl can run at
a time** — both bind port 8080.

## Known limitations

- KV-cache save/restore only applies to `parallel=1` models (kat, bigbang).
  For `parallel>1` models (bonsai) there's no external session id to map
  onto a specific slot, so cache save/restore is skipped — documented
  limitation, not a bug.
- VRAM stats require `nvidia-smi` on PATH; on non-NVIDIA machines the VRAM
  tile/chart just shows "n/a".
- Unprefixed `/models`, `/models/load`, `/models/unload`, `/chat/completions`
  aliases are kept temporarily so `scripts/winlauncher/kanban/server.js`
  keeps working without changes. New integrations should use `/v1/*`. See
  `MIGRATION.md`.
