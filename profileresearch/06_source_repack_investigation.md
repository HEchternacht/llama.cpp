# Source-code investigation: CPU MoE repack path (why no tg lever exists)

Date: 2026-07-09 - Build: fd1a05791 (9852)

Goal: scan llama.cpp source for a MoE CPU+GPU optimization on the RTX 4050 6GB + i7-13620H setup.

## What the code does

- `--n-cpu-moe N` / `-cmoe` (common/arg.cpp:2457-2475) push a tensor buffer override
  mapping the expert regex `\.ffn_(up|down|gate|gate_up)_(ch|)exps` to
  `ggml_backend_cpu_buffer_type()` (the PLAIN CPU buffer).
- On override to CPU, the loader (src/llama-model-loader.cpp:1166-1189) re-runs
  `select_weight_buft` over the CPU buft list, which DOES include the online-repack
  extra buffer (`CPU_REPACK`, ggml/src/ggml-cpu/repack.cpp).
- BUT `make_cpu_buft_list` (src/llama-model.cpp:872-930) orders the list:
  ACCEL -> host (`CUDA_Host`, pinned) -> `CPU_REPACK` -> `CPU`.
  `select_weight_buft` takes the FIRST supporting buft, and the CUDA device reports
  it supports MUL_MAT_ID with weights in its host buffer, so **`CUDA_Host` wins and
  `CPU_REPACK` is never reached** for offloaded experts.

Confirmed in load log (verbose):
- default `-ncmoe 36`: `blk.N.ffn_*_exps ... buffer type overridden to CUDA_Host`
- `-ncmoe 36 --no-host 1`: same tensors `... overridden to CPU_REPACK` (q4_K layers only)

## Repack coverage for THIS model

file type = Q4_K-Medium, but per-tensor expert quant is mixed:
- blk.0-4 experts: **q4_K** (144 MiB each) -> repack kernel `q4_K_8x8_q8_K` (AVX2) applies.
- blk.5-39 experts: **q3_K** (110 MiB each) -> repack.cpp has **NO q3_K kernel** -> stays plain CPU.
So ~5/40 layers could repack; ~35/40 cannot regardless.

CPU backend loaded = `ggml-cpu-alderlake.dll` (AVX2+FMA+F16C present), so repack is
otherwise eligible - the limiter is the q3_K quant, not the build.

## Measurement (the decisive A/B)

`-ngl 99 -ncmoe 36 -fa 1 -ctk/ctv q8_0 -ub 2048 -t 6 -p512 -n128 -r3`

| Config | pp512 t/s | tg128 t/s |
|---|---|---|
| Baseline (experts -> CUDA_Host, repack OFF) | 374.85 +/- 7.9 | 38.10 +/- 0.17 |
| `--no-host 1` (experts -> CPU_REPACK, repack ON) | 327.95 +/- 5.2 (-12%) | 37.72 +/- 0.17 (flat) |

## Conclusion

Repack (the primary CPU-MoE compute optimization in the tree) yields **no tg gain and
a 12% pp loss** here, for two independent reasons:
1. tg is DDR5-bandwidth bound - repack alters weight LAYOUT, not BYTES/token, so it
   cannot move a bandwidth-bound kernel. tg 38.10 -> 37.72 is noise. This is the
   code-side confirmation of the bottleneck verdict in REPORT.md.
2. The model is ~87% q3_K experts, which repack does not support at all.
3. `--no-host` additionally removes the pinned buffer that overlaps prompt-batch expert
   work with GPU transfer, costing 12% pp.

No source change to the CPU MoE path helps this workload. The bottleneck is physical RAM
bandwidth (see REPORT.md hardware levers), not the CPU matmul implementation.

Do NOT run with `--no-host` on this setup.
