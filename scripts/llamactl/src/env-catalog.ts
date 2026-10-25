/** Known ggml/CUDA tuning env vars, ported from winlauncher/llm_config.ps1's
 * $envCatalog — same notes, same measured numbers, so the knowledge isn't
 * lost moving off the old GUI. Applied as global.env (every spawned child
 * inherits them), same as llm_env.cmd's MANAGED block did. */
export interface EnvCatalogEntry {
  name: string;
  recommendedValue: string;
  recommended: boolean;
  note: string;
}

export const ENV_CATALOG: EnvCatalogEntry[] = [
  {
    name: "GGML_SCHED_PREFETCH",
    recommendedValue: "1",
    recommended: true,
    note: "+25% pp (698->874 t/s). Overlaps expert weight uploads with compute. Needs ~420 MiB VRAM + a 2nd CUDA context: at -ncmoe 38 cuBLAS init aborts, use -ncmoe 44 or lower -ub.",
  },
  {
    name: "LLAMA_MOE_CACHE_MIB",
    recommendedValue: "auto",
    recommended: false,
    note: "Hybrid MoE expert cache for -ncmoe decode: VRAM pool of frequently routed experts, hits run on GPU, misses on CPU. 'auto' = all VRAM the driver reports free after KV/compute/prefetch buffers, minus LLAMA_MOE_CACHE_RESERVE_MIB. Set per profile, not global. Nex profile 72k ctx: +13% tg (30.5->34.6 t/s, 16 slots/layer). Min ~341 MiB (Nex). Overcommitting VRAM makes WDDM page and tg drops below no-cache.",
  },
  {
    name: "LLAMA_MOE_CACHE_RESERVE_MIB",
    recommendedValue: "-400",
    recommended: false,
    note: "MoE cache, auto mode: VRAM kept free (default 0). Negative goes past the driver's free figure, which is ~700 MiB conservative on this WDDM RTX 4050: -400 best (34.6 t/s), -700 pages (29.6 t/s).",
  },
  {
    name: "LLAMA_MOE_CACHE_FETCH",
    recommendedValue: "64",
    recommended: false,
    note: "MoE cache: max expert uploads queued per token (default 64). 32-128 measured equal.",
  },
  {
    name: "LLAMA_MOE_CACHE_DECAY",
    recommendedValue: "0.995",
    recommended: false,
    note: "MoE cache: per-token decay of expert routing frequencies (default 0.995). 0.999 measured worse.",
  },
  {
    name: "LLAMA_MOE_CACHE_STATS",
    recommendedValue: "50",
    recommended: false,
    note: "DIAGNOSTIC. MoE cache hit rate + uploads/token every N tokens (INFO log, needs -lv 4 / -v).",
  },
  {
    name: "GGML_CUDA_REGISTER_HOST",
    recommendedValue: "1",
    recommended: true,
    note: "Pins mmap-backed CPU weights for faster H2D. Inert under --no-mmap; the 22 GiB range is too big to page-lock here anyway.",
  },
  {
    name: "GGML_CUDA_GRAPH_OPT",
    recommendedValue: "1",
    recommended: false,
    note: "Measured, no gain: pp 864->852, tg 31.5->31.2.",
  },
  {
    name: "GGML_SCHED_PERF",
    recommendedValue: "1",
    recommended: false,
    note: "DIAGNOSTIC. Synchronizes after every phase, destroying the overlap prefetch provides - its t/s is meaningless. Use bench_prefetch.cmd.",
  },
  {
    name: "GGML_MOE_STATS",
    recommendedValue: "1",
    recommended: false,
    note: "DIAGNOSTIC. Expert routing histogram to stderr.",
  },
  {
    name: "GGML_SCHED_DEBUG",
    recommendedValue: "1",
    recommended: false,
    note: "DIAGNOSTIC. Per-node backend assignment dump.",
  },
  {
    name: "GGML_SCHED_DEBUG_REALLOC",
    recommendedValue: "1",
    recommended: false,
    note: "DIAGNOSTIC.",
  },
  {
    name: "GGML_CUDA_ENABLE_UNIFIED_MEMORY",
    recommendedValue: "1",
    recommended: false,
    note: "Lets allocations spill silently to host RAM instead of failing. That spill is the demand-paging behind the multi-second stalls - a hard OOM is the signal you want.",
  },
  {
    name: "GGML_CUDA_NO_PINNED",
    recommendedValue: "1",
    recommended: false,
    note: "Disables pinned staging. Slower.",
  },
  {
    name: "GGML_CUDA_DISABLE_FUSION",
    recommendedValue: "1",
    recommended: false,
    note: "Disables kernel fusion. Slower.",
  },
  {
    name: "GGML_CPU_DISABLE_FUSION",
    recommendedValue: "1",
    recommended: false,
    note: "Disables kernel fusion on the CPU backend. Slower.",
  },
  {
    name: "GGML_OP_OFFLOAD_MIN_BATCH",
    recommendedValue: "32",
    recommended: false,
    note: "Batch threshold for offloading ops to GPU (default 32). Untested here.",
  },
];
