# Ornith-1.0-35B-A3B — Bottleneck Profile (RTX 4050 6GB + i7-13620H + 24GB DDR5)

Date: 2026-07-09 · Build: fd1a05791 (9852) · Model: qwen35moe 35B.A3B Q4_K-M, 15.39 GiB
n_layer=40, n_expert=256, n_expert_used=8, hybrid full-attn + SSM(linear-attn) layers.

## Hardware
- GPU: RTX 4050 **Laptop**, **6141 MiB** VRAM (≈5.7 GB usable). Bus ~96-bit, ~180 GB/s.
- CPU: i7-13620H, 6 P-cores + 4 E-cores (16 threads).
- RAM: **24 GB = 8 GB (SK Hynix) + 16 GB (Crucial)**, DDR5 rated 5600, **running 5200 MT/s**.
  Mismatched capacity ⇒ Intel **Flex mode**: 16 GB runs dual-channel, remaining 8 GB single-channel ⇒ effective bandwidth below full 2×.

## Verdict
| Phase | Bound by | Evidence |
|---|---|---|
| **Token gen (tg)** | **CPU memory subsystem** (DDR5 bandwidth + scattered 8-of-256 expert gather) | tg saturates at 4-6 threads then *declines*: t2 25.6 → t4 35.5 → t6 38.6 → t16 37.4. Adding threads past 6 does nothing = not compute-bound. |
| **Offload limit** | **6 GB VRAM ceiling (hard)** | Pushing experts onto GPU past the ceiling collapses tg via **WDDM VRAM paging**: ncmoe 36→37, 32→36, **28→22.7, 20→15.8, 16→10.9**. |
| **Prompt proc (pp)** | GPU compute at offload boundary | ~370-510 t/s @512; fine. |
| **Long context** | mild KV/attention tax | tg 35.8 (d0) → 33.2 (16k) → 30.9 (32k) → **26.1 (64k)**. Gentle thanks to hybrid SSM layers. |

**Why more GPU offload doesn't help:** GPU attention and CPU experts run largely *serial* per layer. Moving a layer CPU→GPU shrinks the CPU path but grows the GPU path ~equally — until VRAM overflows and WDDM paging over PCIe destroys throughput. ncmoe=36 sits right at the VRAM ceiling; that is why it was chosen and why it's near-optimal.

## Measurements (all -fa on, q8_0 KV, -ub 2048, --no-mmap)
- Baseline (t6, ncmoe36): **pp512 396, tg128 39.0**.
- Thread scan (tg128, ncmoe36): 2→25.6, 4→35.5, **6→38.6**, 8→38.2, 10→36.5, 12→37.5, 16→37.4.
- ncmoe scan @512 (tg): 48/44/40/38→36-37 (clamp=all-CPU), 36→37.3, 34→36.9, 32→36.0, **28→22.7, 24→19.0, 20→15.8, 16→10.9 (VRAM paging)**.
- Depth scan (ncmoe36, tg64): d0 35.8, d4k 36.7, d16k 33.2, d32k 30.9, **d64k 26.1**.
- @ d65536: ncmoe 38→25.8, 36→25.9, **34→26.7**. Peak VRAM **5055/6141 MiB (~1 GB free)**.

## Recommendations

### Software (free, small)
1. **`-ncmoe 34`** (was 36). Uses the spare ~1 GB VRAM; +~3% tg at 64k, neutral short-ctx. Watch nvidia-smi stays < ~5.9 GB; if any WDDM paging/stutter, revert to 36.
2. **`-t 6` is optimal** — keep it. Your `-C 0x555` (pins to the 6 P-cores, skipping HT siblings) + `--cpu-strict 1` is correct; do not raise threads.
3. Leave `-ub 2048` (pp is fine). Lowering it frees a little VRAM for maybe one more expert layer but the tg gain is within noise and pp drops.
4. Everything else in your launch line is already sensible for this hardware.

### Hardware (the real gains — tg is memory-bound)
1. **Enable XMP/EXPO in BIOS**: RAM runs 5200 vs rated 5600 → **~+8% tg** for free.
2. **Replace the 8 GB stick with a matched 16 GB** (2×16 GB): kills Flex-mode single-channel penalty → full symmetric dual-channel. **Likely the single biggest tg lever (~+15-25%)** since generation is memory-subsystem bound.

### Ceiling note
This model is fundamentally RAM-bandwidth limited on a 6 GB GPU: 90% of expert layers must stream from DDR5 every token. No arg change escapes that; only faster/matched RAM or a bigger-VRAM GPU moves the needle materially.

## Source-code investigation (CPU MoE path)
Scanned the CPU MoE offload + online-repack code and tested it (details in 06_source_repack_investigation.md):
- `--n-cpu-moe` forces experts to the plain CPU buffer; the loader then re-selects and lands them in
  `CUDA_Host` (pinned) because that buft is ordered before `CPU_REPACK`, so online repack never engages.
- Forcing repack via `--no-host 1` (experts -> `CPU_REPACK`): **tg 38.10 -> 37.72 (flat), pp 375 -> 328 (-12%)**.
- Repack is doubly moot here: (a) tg is bandwidth-bound so weight relayout cannot help; (b) ~35/40 expert
  layers are q3_K, which has no repack kernel (only blk.0-4 are q4_K).
- **Verdict: no CPU-side source change helps tg.** This is the code-side confirmation of the bandwidth-bound
  bottleneck. Do NOT use `--no-host`.

## Files
- 00_baseline.md, 01_thread_scaling.md, 02_ncmoe_sweep.md, 03_ncmoe_low.md, 04_depth_sweep.md, 05_ncmoe_at_64k.md, 05_vram_samples.csv, 06_source_repack_investigation.md
