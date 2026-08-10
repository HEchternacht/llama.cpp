@echo off
rem Shared ggml/CUDA environment for the QWEN36MOE launcher chain.
rem Called by QWEN36MOE.bat, QWEN36MOECLI.BAT (the pi/piq path) and QWEN36MOE_custom.bat,
rem so there is one place to change. Anything set before the call wins - see the
rem "if not defined" guards - which lets bench scripts override a single var.
rem
rem Edit through llm_config.ps1 -> Environment tab. Everything between the BEGIN/END
rem MANAGED markers is rewritten wholesale by that tab; text outside them is preserved.
rem
rem Measured 2026-07-22, Ornith-1.0-35B-APEX-I-Balanced, RTX 4050 6GB,
rem llama-bench -ncmoe 44 -ub 2048 -p 4096 -r 3.

rem === BEGIN MANAGED ===
if not defined GGML_SCHED_PREFETCH set GGML_SCHED_PREFETCH=1
if not defined GGML_CUDA_REGISTER_HOST set GGML_CUDA_REGISTER_HOST=1
rem === END MANAGED ===

rem ---------------------------------------------------------------------------
rem Reference - why each variable is on or off. The Environment tab shows the same
rem notes, this copy is for when you are reading the file directly.
rem
rem ON
rem   GGML_SCHED_PREFETCH=1      +25% prompt processing (698 -> 874 t/s). Uploads
rem                              offloaded expert weights on a second CUDA stream,
rem                              overlapping them with compute. Costs 2 x 210 MiB of
rem                              VRAM plus a second CUDA backend context - at
rem                              -ncmoe 38 there is not enough left and cuBLAS handle
rem                              creation aborts, so this needs -ncmoe 44 or lower -ub.
rem   GGML_CUDA_REGISTER_HOST=1  Pins mmap-backed CPU weights so H2D copies come from
rem                              page-locked memory. Inert while --no-mmap is used, and
rem                              the 22 GiB range is too large to page-lock on this
rem                              machine anyway. Kept on for smaller models under mmap.
rem
rem OFF - do not enable for normal runs
rem   GGML_CUDA_GRAPH_OPT=1      measured, no gain: pp 864 -> 852, tg 31.5 -> 31.2
rem   GGML_SCHED_PERF=N          diagnostic. synchronizes after every phase, which
rem                              destroys the very overlap prefetch provides - the t/s
rem                              it reports is meaningless. use bench_prefetch.cmd
rem   GGML_MOE_STATS=1           diagnostic, expert routing histogram to stderr
rem   GGML_SCHED_DEBUG=N         diagnostic, per-node backend assignment dump
rem   GGML_SCHED_DEBUG_REALLOC=1 diagnostic
rem   GGML_CUDA_ENABLE_UNIFIED_MEMORY=1
rem                              lets allocations silently spill to host RAM instead of
rem                              failing. that spill is the demand-paging behind the
rem                              multi-second stalls - a hard OOM is the signal you want
rem   GGML_CUDA_NO_PINNED=1      disables pinned staging, slower
rem   GGML_CUDA_DISABLE_FUSION=1 disables kernel fusion, slower
rem   GGML_CPU_DISABLE_FUSION=1  same on the CPU backend
rem   GGML_OP_OFFLOAD_MIN_BATCH=N
rem                              batch threshold for offloading ops to GPU (default 32).
rem                              untested here, left alone
rem   GGML_CUDA_P2P / _ALLREDUCE / _CUBLAS_COMPUTE_TYPE
rem                              multi-GPU only, irrelevant on a single 4050
