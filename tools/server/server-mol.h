#pragma once

// Mixture-of-LoRA (MoL) request-level routing orchestration.
//
// Replicates the MindLab-Research/Mixture-of-LoRA-Harness design on top of this
// server's existing multi-LoRA plumbing: an L0 "router" adapter classifies each
// turn into one of N specialist adapters, the chosen adapter answers, and L0
// writes a short cross-adapter summary used to bridge context on future switches.
// This module owns config parsing and per-conversation sticky state only; the
// actual task orchestration (which needs access to the model/queues) lives in
// server_routes (server-context.cpp).

#include <nlohmann/json_fwd.hpp>

#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

struct mol_adapter_config {
    std::string name;      // e.g. "L0"
    int         lora_index = -1; // index into common_params::lora_adapters (CLI load order)
    std::string role;      // free-form description, informational only
    std::string lora_md;   // path to per-adapter description fragment
    std::string intro_md;  // path to per-adapter identity/system-prompt fragment
};

struct mol_config {
    std::vector<mol_adapter_config> adapters;
    std::string router_adapter_name = "L0";
    std::string route_prompt_md;
    std::string summary_prompt_md;
    int reroute_every_n_user_turns = 1;
    int router_slot_id = -2; // sentinel: -2 = reserve the last slot at startup
    int max_route_tokens = 16;
    int max_summary_tokens = 128;

    // loaded prompt fragment contents, keyed by adapter name (populated at load time)
    std::unordered_map<std::string, std::string> lora_md_text;
    std::unordered_map<std::string, std::string> intro_md_text;
    std::string route_prompt_text;
    std::string summary_prompt_text;

    const mol_adapter_config * find(const std::string & name) const;
    const mol_adapter_config * router_adapter() const { return find(router_adapter_name); }
};

// Throws std::runtime_error on malformed config or unreadable prompt fragment files.
// `n_lora_adapters_loaded` is used to validate lora_index bounds.
mol_config mol_config_load(const std::string & path, size_t n_lora_adapters_loaded);

struct mol_conv_state {
    std::string sticky_adapter;      // empty until first route
    std::string last_summary;
    int user_turns_since_route = 0;
    int answer_slot_id = -1;         // -1 = not yet assigned
};

// Mutex-guarded per-conversation state, keyed by conversation id (see
// server_stream_conv_id_from_headers(), with a best-effort fallback in
// server-context.cpp when the client doesn't send that header).
struct mol_state_store {
    std::mutex mtx;
    std::unordered_map<std::string, mol_conv_state> conversations;

    // returns a copy; caller mutates and calls put() to persist
    mol_conv_state get(const std::string & conv_id);
    void put(const std::string & conv_id, const mol_conv_state & state);
};
