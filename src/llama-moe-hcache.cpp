#include "llama-moe-hcache.h"

#include "llama-impl.h"
#include "llama-model.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <map>
#include <tuple>

static int env_int(const char * name, int def) {
    const char * v = getenv(name);
    return v ? atoi(v) : def;
}

// expert weights the cache can copy verbatim: plain (or pinned) host memory, not a repacked CPU layout
static bool moe_cache_plain_host(const ggml_tensor * t, ggml_backend_dev_t dev) {
    if (t == nullptr || t->buffer == nullptr || !ggml_backend_buffer_is_host(t->buffer) || !ggml_is_contiguous(t)) {
        return false;
    }
    ggml_backend_buffer_type_t buft = ggml_backend_buffer_get_type(t->buffer);
    const char * name = ggml_backend_buft_name(buft);
    return strcmp(name, "CPU") == 0 || strcmp(name, "CPU_Mapped") == 0 || buft == ggml_backend_dev_host_buffer_type(dev);
}

static void moe_cache_plan_op(ggml_tensor * dst, int ith, int nth, void * userdata) {
    GGML_UNUSED(nth);
    if (ith != 0) {
        return;
    }
    auto * op = (llama_moe_hcache_op *) userdata;
    op->cache->plan(dst->src[0], dst, op->il);
}

static void moe_cache_cpu_ids_op(ggml_tensor * dst, int ith, int nth, void * userdata) {
    GGML_UNUSED(nth);
    if (ith != 0) {
        return;
    }
    auto * op = (llama_moe_hcache_op *) userdata;
    const int32_t zero = op->cache->groups[op->cache->layers[op->il].group].n_slots;

    const ggml_tensor * sel = dst->src[0];
    const int32_t * gpu = (const int32_t *) dst->src[1]->data;
    int32_t * out = (int32_t *) dst->data;

    for (int64_t i1 = 0; i1 < sel->ne[1]; ++i1) {
        for (int64_t i0 = 0; i0 < sel->ne[0]; ++i0) {
            const int64_t i = i1*sel->ne[0] + i0;
            const int32_t e = *(const int32_t *) ((const char *) sel->data + i0*sel->nb[0] + i1*sel->nb[1]);
            out[i] = (gpu[i] < 0 || gpu[i] == zero) ? e : -1;
        }
    }
}

llama_moe_hcache::llama_moe_hcache(const llama_model & model, size_t budget_bytes) {
    n_expert    = model.hparams.n_expert;
    max_tokens  = env_int("LLAMA_MOE_CACHE_MAX_TOKENS", 8);
    max_fetch   = env_int("LLAMA_MOE_CACHE_FETCH", 64);
    stats_every = env_int("LLAMA_MOE_CACHE_STATS", 0);
    if (const char * v = getenv("LLAMA_MOE_CACHE_DECAY")) {
        decay = (float) atof(v);
    }

    const int n_layer = (int) model.layers.size();
    layers.resize(n_layer);
    ops.resize(n_layer);
    for (int il = 0; il < n_layer; ++il) {
        ops[il] = { this, il };
    }

    if (n_expert <= 1) {
        return;
    }

    // group the eligible layers by expert tensor signature (type + shape of each matrix)
    using sig_t = std::vector<std::tuple<int, int64_t, int64_t>>;
    std::map<sig_t, int> sig_group;
    std::vector<std::vector<int>> group_layers;
    std::vector<size_t> group_bytes;
    ggml_backend_dev_t dev = nullptr;

    for (int il = 0; il < n_layer; ++il) {
        const auto & l = model.layers[il];
        ggml_tensor * mats[MAX_MATS] = { l.ffn_gate_up_exps, l.ffn_up_exps, l.ffn_gate_exps, l.ffn_down_exps };
        if ((mats[0] == nullptr && mats[1] == nullptr) || mats[3] == nullptr) {
            continue;
        }

        ggml_backend_dev_t dev_l = model.dev_layer(il);
        if (dev_l == nullptr || ggml_backend_dev_type(dev_l) != GGML_BACKEND_DEVICE_TYPE_GPU) {
            continue;
        }
        if (dev != nullptr && dev_l != dev) {
            continue; // single device only
        }

        sig_t sig;
        size_t bytes = 0;
        bool ok = true;
        layer desc;
        int n = 0;
        for (ggml_tensor * t : mats) {
            if (t == nullptr) {
                continue;
            }
            if (!moe_cache_plain_host(t, dev_l) || t->ne[2] != n_expert || t->ne[3] != 1) {
                ok = false;
                break;
            }
            sig.emplace_back((int) t->type, t->ne[0], t->ne[1]);
            bytes += t->nb[2];
            desc.src[n++] = t;
        }
        if (!ok) {
            continue;
        }

        dev = dev_l;
        auto it = sig_group.find(sig);
        if (it == sig_group.end()) {
            it = sig_group.emplace(sig, (int) group_layers.size()).first;
            group_layers.emplace_back();
            group_bytes.push_back(bytes);
        }
        desc.group = it->second;
        layers[il] = desc;
        group_layers[it->second].push_back(il);
    }

    if (group_layers.empty()) {
        LLAMA_LOG_INFO("%s: no CPU-resident expert layers, cache disabled\n", __func__);
        return;
    }

    if (budget_bytes == BUDGET_AUTO) {
        // free device memory once the compute (and scheduler prefetch) buffers are allocated, minus a
        // margin for lazy driver allocations; negative margins go past the (conservative on WDDM) free figure
        size_t free = 0, total = 0;
        ggml_backend_dev_memory(dev, &free, &total);
        const int64_t reserve = (int64_t) env_int("LLAMA_MOE_CACHE_RESERVE_MIB", 0) * 1024 * 1024;
        budget_bytes = (size_t) std::max<int64_t>((int64_t) free - reserve, 0);
        LLAMA_LOG_INFO("%s: auto budget %.0f MiB = %.0f MiB free - %.0f MiB reserve\n", __func__,
            budget_bytes / 1048576.0, free / 1048576.0, reserve / 1048576.0);
    }

    // same number of slots per layer in every group
    size_t bytes_per_layer_slot = 0;
    for (size_t g = 0; g < group_layers.size(); ++g) {
        bytes_per_layer_slot += group_layers[g].size() * group_bytes[g];
    }
    const int64_t slots_per_layer = std::min<int64_t>(budget_bytes / bytes_per_layer_slot, n_expert);
    if (slots_per_layer < 4) {
        LLAMA_LOG_WARN("%s: budget %.0f MiB too small (%.1f MiB per slot per layer), cache disabled\n", __func__,
            budget_bytes / 1048576.0, bytes_per_layer_slot / 1048576.0);
        for (auto & l : layers) {
            l.group = -1;
        }
        return;
    }

    ggml_init_params ip = {
        /*.mem_size   =*/ ggml_tensor_overhead() * MAX_MATS * group_layers.size(),
        /*.mem_buffer =*/ nullptr,
        /*.no_alloc   =*/ true,
    };
    ctx_pools = ggml_init(ip);

    groups.resize(group_layers.size());
    for (size_t gi = 0; gi < groups.size(); ++gi) {
        group & g = groups[gi];
        const layer & first = layers[group_layers[gi][0]];
        g.n_slots = (int) (slots_per_layer * group_layers[gi].size());
        for (int m = 0; m < MAX_MATS && first.src[m]; ++m) {
            const ggml_tensor * s = first.src[m];
            g.pool[m] = ggml_new_tensor_3d(ctx_pools, s->type, s->ne[0], s->ne[1], g.n_slots + 1);
            ggml_format_name(g.pool[m], "moe_hcache.g%d.m%d", (int) gi, m);
            GGML_ASSERT(g.pool[m]->nb[2] == s->nb[2]);
            g.n_mats = m + 1;
        }
        g.owner.assign(g.n_slots, -1);
        g.stamp.assign(g.n_slots, 0);
        g.ready.assign(g.n_slots, 0);
        g.pending.assign(g.n_slots, 0);
    }

    buf_pools = ggml_backend_alloc_ctx_tensors_from_buft(ctx_pools, ggml_backend_dev_buffer_type(dev));
    if (buf_pools == nullptr) {
        LLAMA_LOG_WARN("%s: failed to allocate %.0f MiB of VRAM, cache disabled\n", __func__, budget_bytes / 1048576.0);
        groups.clear();
        for (auto & l : layers) {
            l.group = -1;
        }
        return;
    }
    ggml_backend_buffer_set_usage(buf_pools, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);

    for (auto & g : groups) {
        for (int m = 0; m < g.n_mats; ++m) {
            ggml_backend_tensor_memset(g.pool[m], 0, (size_t) g.n_slots * g.pool[m]->nb[2], g.pool[m]->nb[2]);
        }
    }

    upload_backend = ggml_backend_dev_init(dev, nullptr);
    GGML_ASSERT(upload_backend != nullptr);

    slot_of.assign((size_t) n_layer * n_expert, -1);
    freq.assign((size_t) n_layer * n_expert, 0.0f);
    worker = std::thread(&llama_moe_hcache::worker_main, this);

    LLAMA_LOG_INFO("%s: %s: %zu groups, %lld slots/layer (%.1f%% of experts), %.2f MiB, max_tokens = %lld, max_fetch = %d, decay = %.4f\n",
        __func__, ggml_backend_dev_name(dev), groups.size(), (long long) slots_per_layer,
        100.0 * slots_per_layer / n_expert, ggml_backend_buffer_get_size(buf_pools) / 1048576.0,
        (long long) max_tokens, max_fetch, decay);
}

llama_moe_hcache::~llama_moe_hcache() {
    if (worker.joinable()) {
        {
            std::lock_guard<std::mutex> lk(mtx);
            stop = true;
        }
        cv.notify_all();
        worker.join();
    }
    if (upload_backend) {
        ggml_backend_free(upload_backend);
    }
    if (buf_pools) {
        ggml_backend_buffer_free(buf_pools);
    }
    if (ctx_pools) {
        ggml_free(ctx_pools);
    }
}

const llama_moe_hcache::layer * llama_moe_hcache::get_layer(int il, int64_t n_tokens) const {
    if (groups.empty() || n_tokens > max_tokens || il < 0 || il >= (int) layers.size() || layers[il].group < 0) {
        return nullptr;
    }
    return &layers[il];
}

ggml_tensor * llama_moe_hcache::build_ids_gpu(ggml_context * ctx, ggml_tensor * selected, ggml_tensor * cur, int il) {
    // cur is unused by the op: as a source it is copied to the host together with the ids, so the
    // later CPU expert split has no device inputs and can run while the GPU computes the hits
    ggml_tensor * args[2] = { selected, cur };
    return ggml_custom_4d(ctx, GGML_TYPE_I32, selected->ne[0], selected->ne[1], 1, 1, args, 2, moe_cache_plan_op, 1, &ops[il]);
}

ggml_tensor * llama_moe_hcache::build_ids_cpu(ggml_context * ctx, ggml_tensor * selected, ggml_tensor * ids_gpu, int il) {
    ggml_tensor * args[2] = { selected, ids_gpu };
    return ggml_custom_4d(ctx, GGML_TYPE_I32, selected->ne[0], selected->ne[1], 1, 1, args, 2, moe_cache_cpu_ids_op, 1, &ops[il]);
}

// least frequently routed slot, empty slots first
int llama_moe_hcache::pick_victim(group & g) const {
    int   best   = -1;
    float best_f = 0.0f;
    for (int s = 0; s < g.n_slots; ++s) {
        // never evict an in-flight upload or an expert used during the current token
        if (g.pending[s] || g.stamp[s] >= epoch_start) {
            continue;
        }
        if (g.owner[s] < 0) {
            return s;
        }
        const float f = freq[g.owner[s]];
        if (best < 0 || f < best_f) {
            best   = s;
            best_f = f;
        }
    }
    return best;
}

void llama_moe_hcache::plan(const ggml_tensor * sel, ggml_tensor * dst, int il) {
    const layer & l = layers[il];
    group & g = groups[l.group];
    // single token: the CUDA mmvq kernel skips negative ids; larger batches may take kernels that
    // cannot, so misses point at the all-zero slot instead
    const int32_t zero = sel->ne[1] == 1 ? -1 : g.n_slots;
    int32_t * out = (int32_t *) dst->data;
    bool notify = false;

    {
        std::lock_guard<std::mutex> lk(mtx);

        if (il <= last_il) {
            epoch_start = ++clock;
            n_fetch_cur = 0;
            freq_inc /= decay;
            if (freq_inc > 1e30f) {
                for (float & f : freq) {
                    f /= freq_inc;
                }
                freq_inc = 1.0f;
            }
            if (stats_every > 0 && ++n_epoch % stats_every == 0 && n_act > 0) {
                LLAMA_LOG_INFO("%s: hit rate %.1f%% over %llu expert activations, %.1f uploads/token, %zu queued\n", __func__,
                    100.0 * n_hit / n_act, (unsigned long long) n_act, (double) n_upload / stats_every, queue.size());
                n_hit = n_act = n_upload = 0;
            }
        }
        last_il = il;
        const uint64_t now = ++clock;

        for (int64_t i1 = 0; i1 < sel->ne[1]; ++i1) {
            for (int64_t i0 = 0; i0 < sel->ne[0]; ++i0) {
                const int32_t e = *(const int32_t *) ((const char *) sel->data + i0*sel->nb[0] + i1*sel->nb[1]);
                const int32_t key = il*(int32_t) n_expert + e;
                int32_t & o = out[i1*sel->ne[0] + i0];
                const int32_t s = slot_of[key];

                freq[key] += freq_inc;
                n_act++;
                if (s >= 0 && g.ready[s]) {
                    o = s;
                    g.stamp[s] = now;
                    n_hit++;
                    continue;
                }

                o = zero;
                if (s >= 0 || n_fetch_cur >= max_fetch) {
                    continue; // upload already in flight, or budget for this token spent
                }

                const int v = pick_victim(g);
                if (v < 0 || (g.owner[v] >= 0 && freq[g.owner[v]] >= freq[key])) {
                    continue;
                }
                if (g.owner[v] >= 0) {
                    slot_of[g.owner[v]] = -1;
                }
                g.owner[v]   = key;
                g.ready[v]   = 0;
                g.pending[v] = 1;
                g.stamp[v]   = now;
                slot_of[key] = v;
                queue.push_back({ l.group, v, il, e });
                n_fetch_cur++;
                n_upload++;
                notify = true;
            }
        }
    }

    if (notify) {
        cv.notify_one();
    }
}

void llama_moe_hcache::worker_main() {
    while (true) {
        fetch f;
        {
            std::unique_lock<std::mutex> lk(mtx);
            cv.wait(lk, [&] { return stop || !queue.empty(); });
            if (stop) {
                return;
            }
            f = queue.front();
            queue.pop_front();
        }

        group & g = groups[f.group];
        const layer & l = layers[f.il];
        for (int m = 0; m < g.n_mats; ++m) {
            const size_t nb = l.src[m]->nb[2];
            ggml_backend_tensor_set_async(upload_backend, g.pool[m], (const char *) l.src[m]->data + (size_t) f.expert*nb, (size_t) f.slot*nb, nb);
        }
        ggml_backend_synchronize(upload_backend);

        std::lock_guard<std::mutex> lk(mtx);
        g.ready[f.slot]   = 1;
        g.pending[f.slot] = 0;
    }
}
