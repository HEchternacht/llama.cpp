#pragma once

#include "ggml.h"
#include "ggml-backend.h"

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

struct llama_model;
struct llama_moe_hcache;

struct llama_moe_hcache_op {
    llama_moe_hcache * cache;
    int il;
};

// Hybrid MoE expert cache: keeps frequently routed CPU-resident experts in a VRAM slot pool.
// During small-batch decode, cache hits run on the GPU against the pool and misses run on
// the CPU from the original host weights; the two partial results are summed. A miss whose
// decayed routing frequency beats the least frequent evictable slot is uploaded asynchronously
// by a worker thread and becomes usable once the copy completes.
// Enabled with LLAMA_MOE_CACHE_MIB=<VRAM budget> or LLAMA_MOE_CACHE_MIB=auto.
struct llama_moe_hcache {
    static constexpr int MAX_MATS = 4; // gate_up, up, gate, down
    static constexpr size_t BUDGET_AUTO = SIZE_MAX; // size the pool from the free device memory

    struct group {
        // one pool per expert matrix: [ne0, ne1, n_slots + 1], the last slot is all zeros
        ggml_tensor * pool[MAX_MATS] = {};
        int n_mats  = 0;
        int n_slots = 0;

        std::vector<int32_t>  owner;  // [n_slots] key (il*n_expert + e) or -1
        std::vector<uint64_t> stamp;  // [n_slots] last use
        std::vector<uint8_t>  ready;  // [n_slots] upload finished
        std::vector<uint8_t>  pending;
    };

    struct layer {
        int group = -1;
        ggml_tensor * src[MAX_MATS] = {}; // host expert tensors, same order as the group pools
    };

    struct fetch {
        int group;
        int slot;
        int il;
        int expert;
    };

    llama_moe_hcache(const llama_model & model, size_t budget_bytes);
    ~llama_moe_hcache();

    bool ok() const { return !groups.empty(); }

    // returns the layer descriptor if layer il's experts can be served by the cache for this batch
    const layer * get_layer(int il, int64_t n_tokens) const;

    // graph construction: slot ids for the GPU pool (misses -> zero slot) and expert ids for the CPU (hits -> -1)
    ggml_tensor * build_ids_gpu(ggml_context * ctx, ggml_tensor * selected, ggml_tensor * cur, int il);
    ggml_tensor * build_ids_cpu(ggml_context * ctx, ggml_tensor * selected, ggml_tensor * ids_gpu, int il);

    // called from the plan op (CPU backend thread)
    void plan(const ggml_tensor * sel, ggml_tensor * dst, int il);

    std::vector<group> groups;
    std::vector<layer> layers;     // [n_layer]
    std::vector<struct llama_moe_hcache_op> ops; // [n_layer] stable custom op payloads
    std::vector<int32_t> slot_of;  // [n_layer * n_expert] slot or -1
    std::vector<float>   freq;     // [n_layer * n_expert] exponentially decayed routing frequency

    int64_t n_expert    = 0;
    int64_t max_tokens  = 8;
    int     max_fetch   = 64;      // uploads queued per token
    int     stats_every = 0;
    float   decay       = 0.995f;  // per token frequency decay

private:
    void worker_main();
    int  pick_victim(group & g) const;

    ggml_context          * ctx_pools = nullptr;
    ggml_backend_buffer_t   buf_pools = nullptr;
    ggml_backend_t          upload_backend = nullptr;

    std::mutex              mtx;
    std::condition_variable cv;
    std::deque<fetch>       queue;
    std::thread             worker;
    bool                    stop = false;

    uint64_t clock       = 0;
    uint64_t epoch_start = 0;  // stamp at the start of the current token
    int      last_il     = 1 << 30;
    int      n_fetch_cur = 0;
    float    freq_inc    = 1.0f;  // decay is applied by growing the increment instead of shrinking every count
    uint64_t n_epoch     = 0;
    uint64_t n_upload    = 0;
    uint64_t n_hit       = 0;
    uint64_t n_act       = 0;
};
