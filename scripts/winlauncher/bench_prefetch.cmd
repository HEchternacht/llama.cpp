@echo off
rem Measure the expert-prefetch optimization on Ornith Balanced.
rem Run with llama-server STOPPED - this needs the whole GPU.
rem
rem   1. prefetch off  -> baseline pp t/s
rem   2. prefetch on   -> end-to-end gain (this is the number that decides anything)
rem   3. prefetch on + GGML_SCHED_PERF=1 -> per-graph copy vs compute breakdown.
rem      PERF synchronizes after every phase, so it destroys the overlap it is
rem      measuring: read run 3 only as "how much copy time exists to hide",
rem      never as a speed number. Compare its t/s to nothing.
setlocal
set MODEL=C:\cmodels\Ornith-1.0-35B-APEX-I-Balanced.gguf
rem args mirror the Balanced entry in model_args.json, minus the server-only ones, except:
rem  -ub 2048 (not 4096): llama-bench reserves logits for all n_prompt positions, so its
rem           compute buffer is ~3976 MiB at ub 4096 and cudaMalloc fails on a 6 GB card.
rem           the server only outputs the last token, so it runs ub 4096 at ~1096 MiB.
rem  -ncmoe 44 (not 38): 38 leaves no room for the prefetch slots plus the second CUDA
rem           backend the copy stream needs - cuBLAS handle creation then aborts. 44 costs
rem           nothing in pp (measured identical) and fits.
rem -mmp 0 = --no-mmap, so cold page-in does not swamp the measurement.
set ARGS=-m "%MODEL%" -ngl 99 -ncmoe 44 -b 4096 -ub 2048 -fa on -ctk q8_0 -ctv q8_0 -t 6 -mmp 0 -dio 0
set OUT=%~dp0logs\bench_prefetch-%RANDOM%.log

tasklist /FI "IMAGENAME eq llama-server.exe" 2>nul | find /I "llama-server.exe" >nul
if not errorlevel 1 (
    echo llama-server is running - stop it first or the numbers are meaningless.
    pause
    exit /b 1
)

echo Logging to %OUT%
echo.

echo === 1/3  prefetch OFF, pp4096
set GGML_SCHED_PREFETCH=0
set GGML_SCHED_PERF=
"%~dp0llama-bench.exe" %ARGS% -p 4096 -n 0 -r 3 >> "%OUT%" 2>&1

echo.
echo === 2/3  prefetch ON, pp4096
set GGML_SCHED_PREFETCH=1
"%~dp0llama-bench.exe" %ARGS% -p 4096 -n 0 -r 3 >> "%OUT%" 2>&1

echo.
echo === 3/3  prefetch ON + per-graph copy/compute (timings distorted by design)
rem -v is required: the perf lines are GGML_LOG_INFO and llama-bench filters those out
set GGML_SCHED_PERF=1
"%~dp0llama-bench.exe" %ARGS% -p 4096 -n 0 -r 1 -v >> "%OUT%" 2>&1

echo.
echo ================ results ================
type "%OUT%" | findstr /C:"pp4096" /C:"sched perf" /C:"prefetch buffers" /C:"model size"
echo.
echo Full output: %OUT%
pause
