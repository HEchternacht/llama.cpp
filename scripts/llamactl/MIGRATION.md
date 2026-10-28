# Migrating off the native router

llamactl replaces `scripts/winlauncher/start_router.bat`
(`llama-server --models-preset models.ini --models-max 1`) for day-to-day
use. The old files are left untouched as a fallback.

## Already done

- `C:\Users\henri\.config\little-coder\extensions\compaction-compact-swap.ts`
  and `dispatch-compact-swap.ts` — updated to call `/v1/models/load` and
  `/v1/models` instead of `/models/load`/`/models`.

## Still to do (not part of the initial build)

- `scripts/winlauncher/kanban/server.js` calls `ROUTER + "/models"`,
  `/models/load`, `/models/unload` directly (lines ~59/67/79). These work
  unchanged today via llamactl's temporary unprefixed aliases. Repoint them
  to `/v1/models`, `/v1/models/load`, `/v1/models/unload` when convenient,
  then the aliases in `src/api/legacy.ts` can be deleted.
- Check `C:\Users\henri\.omp\plugins\omp-model-switch\router.ts` and
  `omp-compact-swap\index.ts` for the same `/models*` pattern if that
  harness is still in use.

## Cutting over

1. Stop `start_router.bat` if it's running (can't share port 8080 with
   llamactl).
2. `cd scripts\llamactl && npm install && npm run build`.
3. Fill in `config/llamactl.toml` (model paths, llama_server_exe path).
4. Start via `npm start` or `scripts\LLAMACTL_TRAY.vbs`.
5. Open `http://127.0.0.1:8080/ui/` to confirm models list and dashboard.
