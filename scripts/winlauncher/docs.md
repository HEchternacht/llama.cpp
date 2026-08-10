# Windows launcher suite

Runs `llama-server.exe` on Windows with a model picker, a tray wrapper, a persistent
prompt-prefix cache, and a config GUI.

Everything lives in `build/bin/Release/` at runtime — that is what the `.bat`/`.vbs`
entrypoints execute, because they all resolve paths relative to themselves (`%~dp0`).
`scripts/winlauncher/` holds the tracked source copies. **Edits must be made in both
places**, or you will edit a file that never runs.

---

## Entrypoints

| You run | It does |
|---|---|
| `QWEN36MOE.bat` | Interactive. Model picker in a console window, server in the foreground. |
| `QWEN36MOE_TRAY.vbs` | Same, silent — no console flash, tray icon, auto-closes when all `vibe` instances exit. |
| `QWEN36MOECLI.BAT` | Non-interactive. `--args "3"` feeds answers to the picker prompts on stdin. |
| `QWEN36MOECLI_TRAY.vbs` | Silent `QWEN36MOECLI.BAT`, reading its `--args` from `QWEN36MOECLI_config.json`. |
| `pi_open.bat` | Ensure a server is up, then run `pi`. |
| `piq.cmd` | Same, but kills the server afterwards *if it started it*. |
| `llm_config.vbs` | Config GUI (`llm_config.ps1`), silent. |
| `bench_prefetch.cmd` | Benchmarks the expert-prefetch optimization. Requires the server stopped. |

`QWEN36MOE_custom.bat` runs a hardcoded model, bypassing the picker.

---

## Chains

### Interactive

```
QWEN36MOE.bat
  └─ call llm_env.cmd                  ← ggml/CUDA environment
  └─ python llama_launcher.py
       └─ llama-server.exe
```

### Tray

```
QWEN36MOE_TRAY.vbs                     (wscript, window style 0 = hidden)
  └─ powershell tray_wrapper.ps1 -Bat QWEN36MOE.bat -WatchVibe
       └─ Start-Process cmd /c QWEN36MOE.bat      ← env inherits normally
            └─ (as above)
```

### pi / piq — the one that matters most

```
piq.cmd  (or pi_open.bat)
  ├─ probe 127.0.0.1:8080 via Net.Sockets.TcpClient, 300 ms
  ├─ if it answers ────────────────────────────► skip to pi
  └─ else
       ├─ wscript QWEN36MOECLI_TRAY.vbs
       │    └─ tray_wrapper.ps1 -Bat QWEN36MOECLI.BAT -BatArgs "--args N" -WatchVibe
       │         └─ cmd /c QWEN36MOECLI.BAT --args N
       │              ├─ call llm_env.cmd
       │              └─ echo N | python llama_launcher.py
       │                   └─ llama-server.exe
       ├─ powershell wait_server.ps1     (polls /health, spinner, 300 s cap)
       └─ call %APPDATA%\npm\pi.cmd %*
            └─ piq only: taskkill /IM llama-server.exe   if PIQ_STARTED
```

**`piq` reuses a running server.** If something is already on 8080, its flags and
environment apply — not the ones in `llm_env.cmd`. After changing the environment you
must restart the server for it to take effect.

---

## llama_launcher.py

- Lists `*.gguf` in `C:\cmodels`, sorted with Python `sorted()` (ordinal). Models whose
  name contains `ornith` get a second numbered entry that adds `--mmproj`
  (`C:\cmodels\ornithmmproj\mmproj.gguf`).
- Looks up per-model arguments in `model_args.json`, keyed by exact filename.
- Spawns `llama-server.exe`, tees output to `logs/server-<timestamp>.log`.
- Appends events to `logs/launcher.log`.
- Strips its own flags before spawning the server (see below), then starts the
  prefix-cache worker thread.

### Launcher-only flags

Live in the model's args string, consumed by `pop_flag()` and never passed to
`llama-server`. Toggleable as checkboxes in the GUI's Config tab.

| Flag | Effect |
|---|---|
| `--getcache` | Watch, compare, rebuild and save the prompt prefix. |
| `--norestore` | Do not restore the saved prefix at startup. |

| `--getcache` | `--norestore` | Behaviour |
|---|---|---|
| off | off | Restore the saved prefix, then the worker exits. **Default.** |
| on | off | Restore, then watch/compare/rebuild. |
| off | on | Nothing — the worker thread never starts, the server is never polled. |
| on | on | No restore, but build and save a fresh prefix. |

`LLAMA_SERVER_SLOTS_DEBUG=1` is set **only** when `--getcache` is on, and explicitly
removed from the environment otherwise. The watcher needs it because it reads prompt
text off `/slots`, but it also costs a retained copy of every generated text and a
token dump on every cache mismatch.

### Prefix cache

For a model `X.gguf`, with `--slot-save-path cache`:

- `cache/X-prefix.bin` — the saved slot state
- `cache/X-prefix.meta.json` — `prefix_tokens` and `last_prompt_tokens`

On startup the worker waits for `/health`, checks `/props` reports the expected model,
then `POST /slots/0?action=restore`. With `--getcache` it then watches `/slots`, and
when the stored prefix no longer matches it rebuilds one as the longest common token
prefix between this session's prompt and the previous session's, replays it with
`/completion` + `n_predict: 0`, and saves via `/slots/0?action=save`.

The GUI's **Delete cache** button removes both files for the selected model.

---

## llm_env.cmd — ggml/CUDA environment

Called by `QWEN36MOE.bat`, `QWEN36MOECLI.BAT` and `QWEN36MOE_custom.bat`. Single source
of truth so the chain cannot drift. Every variable is guarded with `if not defined`, so
anything set beforehand wins — that is how `bench_prefetch.cmd` overrides one var.

Only the block between `rem === BEGIN MANAGED ===` and `rem === END MANAGED ===` is
rewritten by the GUI. Comments outside it survive.

### On

| Variable | Why |
|---|---|
| `GGML_SCHED_PREFETCH=1` | +25% prompt processing, 698 → 874 t/s measured. Uploads offloaded expert weights on a second CUDA stream, overlapping them with compute. |
| `GGML_CUDA_REGISTER_HOST=1` | Pins mmap-backed CPU weights for faster H2D copies. Inert under `--no-mmap`. |

### Off, deliberately

| Variable | Why not |
|---|---|
| `GGML_CUDA_GRAPH_OPT` | Measured, no gain: pp 864 → 852, tg 31.5 → 31.2. |
| `GGML_SCHED_PERF` | Diagnostic. Synchronizes after every phase, destroying the overlap prefetch creates — its t/s is meaningless. |
| `GGML_MOE_STATS`, `GGML_SCHED_DEBUG`, `GGML_SCHED_DEBUG_REALLOC` | Diagnostics. |
| `GGML_CUDA_ENABLE_UNIFIED_MEMORY` | Lets allocations spill silently to host RAM instead of failing. That spill is the demand-paging behind multi-second stalls — a hard OOM is the signal you want. |
| `GGML_CUDA_NO_PINNED`, `GGML_CUDA_DISABLE_FUSION`, `GGML_CPU_DISABLE_FUSION` | Turn optimizations off. |
| `GGML_OP_OFFLOAD_MIN_BATCH` | Default 32, untested here. |
| `GGML_CUDA_P2P`, `_ALLREDUCE`, `_CUBLAS_COMPUTE_TYPE` | Multi-GPU only. |

**`GGML_SCHED_PREFETCH` needs VRAM headroom.** It allocates 2 × 210 MiB of slot buffers
*and* creates a second full CUDA backend (its own cuBLAS handle and pool) for the copy
stream. At `-ncmoe 38` on a 6 GB card there is nothing left and cuBLAS handle creation
aborts the process. It needs `-ncmoe 44` or a smaller `-ub`.

---

## llm_config.ps1 — the GUI

Launched silently by `llm_config.vbs`.

### Config tab

Model list on the left (`*` marks the startup default, numbering matches
`llama_launcher.py` exactly). Args editor on the right, with `getcache` / `disable
restore` checkboxes that stay in sync with the text in both directions.

- **Save args** → `model_args.json`
- **Set as startup default** → writes `--args N` into `QWEN36MOECLI_config.json`
- **Restart server with this model** → kills `llama-server`, relaunches via `QWEN36MOECLI_TRAY.vbs`
- **Delete cache** → removes the prefix `.bin` + `.meta.json`, shows their size

### Environment tab

Grid over `llm_env.cmd`'s managed block. Columns: On / Variable / Value / Recommended.
Selecting a row shows why that variable is on or off.

- **Save** — rewrites the managed block only
- **Restore recommended** — loads the recommended set into the grid (does not save)
- **Open llm_env.cmd** — opens it in Notepad

Variables present in the file but absent from the GUI's catalog are shown as
`not in catalog` and preserved on save, never silently dropped.

Changes apply on the **next server start**.

### Logs tab

Tails the last 500 lines of `logs/launcher.log`, with buttons to open the folder or the
full file.

---

## Files

| File | Role |
|---|---|
| `model_args.json` | Per-model `llama-server` arguments, keyed by `.gguf` filename |
| `QWEN36MOECLI_config.json` | `{"args": "--args N"}` — the startup model index |
| `llm_env.cmd` | Shared ggml/CUDA environment |
| `logs/launcher.log` | Launcher events |
| `logs/server-<ts>.log` | Full server output, one per run |
| `cache/<model>-prefix.bin` / `.meta.json` | Prompt-prefix cache |
| `tray_wrapper.ps1` | Runs a `.bat` hidden with a tray icon, watches `vibe` |
| `wait_server.ps1` | Spinner until `/health` returns 200, 300 s cap |

---

## Benchmarking

`bench_prefetch.cmd` — three runs: prefetch off, prefetch on, prefetch on with
`GGML_SCHED_PERF=1`. Requires `llama-server` stopped; it checks and refuses otherwise.

Two things force its arguments to differ from `model_args.json`:

- **`-ub 2048`, not 4096.** `llama-bench` reserves logits for every prompt position
  (`n_outputs = 4096`), making the compute buffer ~3976 MiB — `cudaMalloc` fails on a
  6 GB card. The server only outputs the last token and runs `-ub 4096` at ~1096 MiB.
- **`-ncmoe 44`, not 38.** 38 leaves no room for the prefetch slots plus the second CUDA
  backend. 44 measured identical in prompt processing (702 vs 698 t/s) and fits.

Reading run 3: compare `ms/graph copy` against `ms/graph compute`. Its t/s is garbage by
construction — `perf` serializes the two phases. Last measurement:

```
sched perf: CUDA0:  2068 ms/graph copy,  1244 ms/graph compute,  121.0 splits/graph
```

Copy is ~1.7× compute, so the pipeline is copy-bound; perfect overlap floors at
`max(copy, compute)`, a 1.60× ceiling against the 1.25× currently achieved. 121 splits
over 40 layers is 3.02 per layer — the gate/up/down expert tensors, which is why a third
prefetch slot (currently 2) is the open optimization.

---

## Gotchas

- **Two copies of every file.** `build/bin/Release/` runs; `scripts/winlauncher/` is
  tracked. Keep them in sync.
- **`piq` reuses a live server** and will not apply new flags or environment to it.
- **Exit code 3221225786** = `0xC000013A` = `STATUS_CONTROL_C_EXIT`, i.e. Ctrl-C.
  `llama_launcher.py` mislabels it as a crash.
- **Warming up with a short prompt does not warm the model.** With `-ncmoe`, only the
  experts those few tokens route to get paged in; the rest stay cold.
- **A short warmup evicts a restored prefix** from the slot. Replay the cached prefix as
  an `n_predict: 0` completion instead.
