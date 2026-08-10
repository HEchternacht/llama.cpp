#include "server-mol.h"

#include <nlohmann/json.hpp>

#include <fstream>
#include <sstream>
#include <stdexcept>

using json = nlohmann::ordered_json;

const mol_adapter_config * mol_config::find(const std::string & name) const {
    for (const auto & a : adapters) {
        if (a.name == name) {
            return &a;
        }
    }
    return nullptr;
}

static std::string mol_read_file(const std::string & path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        throw std::runtime_error("mol-config: failed to read file: " + path);
    }
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

mol_config mol_config_load(const std::string & path, size_t n_lora_adapters_loaded) {
    std::string text = mol_read_file(path);

    json j;
    try {
        j = json::parse(text);
    } catch (const std::exception & e) {
        throw std::runtime_error("mol-config: invalid JSON in " + path + ": " + e.what());
    }

    mol_config cfg;

    if (!j.contains("adapters") || !j.at("adapters").is_array() || j.at("adapters").empty()) {
        throw std::runtime_error("mol-config: 'adapters' must be a non-empty array");
    }

    for (const auto & a : j.at("adapters")) {
        mol_adapter_config ac;
        ac.name       = a.at("name").get<std::string>();
        ac.lora_index = a.at("lora_index").get<int>();
        ac.role       = a.value("role", std::string());
        ac.lora_md    = a.value("lora_md", std::string());
        ac.intro_md   = a.value("intro_md", std::string());

        if (ac.name.empty()) {
            throw std::runtime_error("mol-config: adapter entry missing 'name'");
        }
        if (ac.lora_index < 0 || (size_t) ac.lora_index >= n_lora_adapters_loaded) {
            throw std::runtime_error("mol-config: adapter '" + ac.name + "' lora_index " +
                std::to_string(ac.lora_index) + " out of bounds (" +
                std::to_string(n_lora_adapters_loaded) + " lora adapter(s) loaded via --lora/--lora-scaled)");
        }

        if (!ac.lora_md.empty())  { cfg.lora_md_text[ac.name]  = mol_read_file(ac.lora_md); }
        if (!ac.intro_md.empty()) { cfg.intro_md_text[ac.name] = mol_read_file(ac.intro_md); }

        cfg.adapters.push_back(std::move(ac));
    }

    cfg.router_adapter_name        = j.value("router_adapter", std::string("L0"));
    cfg.route_prompt_md            = j.value("route_prompt_md", std::string());
    cfg.summary_prompt_md          = j.value("summary_prompt_md", std::string());
    cfg.reroute_every_n_user_turns = j.value("reroute_every_n_user_turns", 1);
    cfg.router_slot_id             = j.value("router_slot_id", -2);
    cfg.max_route_tokens           = j.value("max_route_tokens", 16);
    cfg.max_summary_tokens         = j.value("max_summary_tokens", 128);

    if (cfg.find(cfg.router_adapter_name) == nullptr) {
        throw std::runtime_error("mol-config: router_adapter '" + cfg.router_adapter_name + "' not found in 'adapters'");
    }
    if (cfg.reroute_every_n_user_turns < 1) {
        throw std::runtime_error("mol-config: reroute_every_n_user_turns must be >= 1");
    }

    if (!cfg.route_prompt_md.empty())   { cfg.route_prompt_text   = mol_read_file(cfg.route_prompt_md); }
    if (!cfg.summary_prompt_md.empty()) { cfg.summary_prompt_text = mol_read_file(cfg.summary_prompt_md); }

    return cfg;
}

mol_conv_state mol_state_store::get(const std::string & conv_id) {
    std::lock_guard<std::mutex> lock(mtx);
    auto it = conversations.find(conv_id);
    if (it == conversations.end()) {
        return mol_conv_state();
    }
    return it->second;
}

void mol_state_store::put(const std::string & conv_id, const mol_conv_state & state) {
    std::lock_guard<std::mutex> lock(mtx);
    conversations[conv_id] = state;
}
