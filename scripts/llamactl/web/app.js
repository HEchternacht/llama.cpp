(function () {
  "use strict";

  const API_KEY_STORAGE = "llamactl_api_key";

  function getApiKey() {
    let k = null;
    try { k = localStorage.getItem(API_KEY_STORAGE); } catch (e) { /* private window */ }
    if (!k) {
      k = window.prompt("llamactl API key (Bearer token):", "") || "";
      try { localStorage.setItem(API_KEY_STORAGE, k); } catch (e) { /* ignore */ }
    }
    return k;
  }

  let apiKey = getApiKey();

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ "Authorization": "Bearer " + apiKey }, opts.headers || {});
    if (opts.body && typeof opts.body !== "string") {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch("/v1" + path, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      try { localStorage.removeItem(API_KEY_STORAGE); } catch (e) { /* ignore */ }
      throw new Error("unauthorized — reload to re-enter API key");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    return body;
  }

  // ---------------------------------------------------------------- tabs ---
  document.querySelectorAll("nav.tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "profiles") loadProfiles();
      if (btn.dataset.tab === "settings") loadSettings();
      if (btn.dataset.tab === "logs") loadLogsTab();
    });
  });

  // -------------------------------------------------------------- charts ---
  function drawSparkline(canvas, series, opts) {
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (!series.length) {
      ctx.fillStyle = "#8b93a7"; ctx.font = "12px sans-serif";
      ctx.fillText("no data yet", 8, h / 2);
      return;
    }
    const colors = opts.colors || ["#5b8cff", "#3ecf8e"];
    const names = opts.names || series.map((_, i) => "series" + i);
    const allVals = series.flat().filter((v) => v != null);
    const maxAll = Math.max(1, ...allVals);
    // dualAxis: every series gets its own scale (tg/s ~30 vs pp/s ~1000)
    const maxes = series.map((vals) => opts.dualAxis ? Math.max(1, ...vals.filter((v) => v != null)) : maxAll);
    series.forEach((vals, si) => {
      const max = maxes[si];
      ctx.beginPath();
      ctx.strokeStyle = colors[si % colors.length];
      ctx.lineWidth = 1.5;
      vals.forEach((v, i) => {
        const x = (i / Math.max(1, vals.length - 1)) * (w - 4) + 2;
        const y = h - 18 - ((v || 0) / max) * (h - 24);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    ctx.fillStyle = "#8b93a7"; ctx.font = "11px sans-serif";
    names.forEach((n, i) => {
      ctx.fillStyle = opts.dualAxis ? colors[i % colors.length] : "#8b93a7";
      ctx.fillText(opts.dualAxis ? n + " (max " + maxes[i].toFixed(0) + ")" : n, 6 + i * (opts.dualAxis ? 130 : 70), h - 4);
    });
  }

  // ----------------------------------------------------------- dashboard ---
  function statusClass(v) { return v || "unloaded"; }

  async function refreshDashboard() {
    try {
      const [live, breakdown, errors, history] = await Promise.all([
        api("/stats/live"),
        api("/stats/breakdown"),
        api("/errors?limit=30"),
        api("/stats/history?bucket=hour"),
      ]);

      const last = live.lastMetrics;
      const tiles = document.getElementById("dash-tiles");
      tiles.innerHTML = "";
      const reqs = live.recentRequests || [];
      const recentReq = reqs[0];
      const sum = (k) => reqs.reduce((a, r) => a + (r[k] || 0), 0);
      addTile(tiles, "Last tg/s", recentReq && recentReq.predicted_per_second ? recentReq.predicted_per_second.toFixed(1) : "—",
        recentReq && recentReq.prompt_per_second ? "pp/s " + recentReq.prompt_per_second.toFixed(1) : "");
      addTile(tiles, "Cache hit", recentReq ? cacheHit(recentReq.cache_tokens, recentReq.prompt_tokens) : "—",
        "last " + reqs.length + ": " + cacheHit(sum("cache_tokens"), sum("prompt_tokens")));
      addTile(tiles, "Draft accept", recentReq ? pctOf(recentReq.draft_accepted, recentReq.draft_tokens) : "—",
        "last " + reqs.length + ": " + pctOf(sum("draft_accepted"), sum("draft_tokens")));
      addTile(tiles, "VRAM used", last && last.gpu_mem_used_mb != null ? (last.gpu_mem_used_mb / 1024).toFixed(1) + " GB" : "n/a",
        last && last.gpu_mem_total_mb ? "of " + (last.gpu_mem_total_mb / 1024).toFixed(1) + " GB" : "");
      addTile(tiles, "Resident slots", last ? (last.slots_busy ?? 0) + " / " + (last.slots_total ?? 0) : "—");
      addTile(tiles, "Total requests", (breakdown.data || []).reduce((s, r) => s + r.request_count, 0));
      addTile(tiles, "Errors (recent)", (errors.data || []).length);

      const rtbody = document.querySelector("#recent-table tbody");
      rtbody.innerHTML = "";
      reqs.forEach((r) => {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + fmtTime(r.started_at) + "</td><td>" + escapeHtml(r.profile_id || r.model_id) + "</td><td>" + fmtNum(r.prompt_tokens) +
          "</td><td>" + fmtNum(r.cache_tokens) + "</td><td>" + cacheHit(r.cache_tokens, r.prompt_tokens) +
          "</td><td>" + fmtRate(r.prompt_per_second) + "</td><td>" + fmtNum(r.predicted_tokens) + "</td><td>" + fmtRate(r.predicted_per_second) +
          "</td><td>" + pctOf(r.draft_accepted, r.draft_tokens) + (r.draft_tokens ? " <span class='muted'>" + r.draft_accepted + "/" + r.draft_tokens + "</span>" : "") +
          "</td><td>" + (r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + " s" : "—") + "</td>";
        rtbody.appendChild(tr);
      });

      const recent = (live.recentRequests || []).slice().reverse();
      drawSparkline(document.getElementById("chart-recent"),
        [recent.map((r) => r.predicted_per_second), recent.map((r) => r.prompt_per_second)],
        { names: ["tg/s", "pp/s"] });

      const hist = history.data || [];
      drawSparkline(document.getElementById("chart-history"),
        [hist.map((r) => r.avg_tg_s), hist.map((r) => r.avg_pp_s)],
        { names: ["avg tg/s", "avg pp/s"] });

      const tbody = document.querySelector("#breakdown-table tbody");
      tbody.innerHTML = "";
      (breakdown.data || []).forEach((r) => {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + r.model_id + "</td><td>" + (r.profile_id || "—") + "</td><td>" + r.request_count +
          "</td><td>" + (r.avg_pp_s ? r.avg_pp_s.toFixed(1) : "—") + "</td><td>" + (r.avg_tg_s ? r.avg_tg_s.toFixed(1) : "—") +
          "</td><td>" + cacheHit(r.cache_tokens, r.prompt_tokens) + "</td><td>" + pctOf(r.draft_accepted, r.draft_tokens) +
          "</td><td>" + fmtNum(r.predicted_tokens) + "</td><td>" + fmtTime(r.last_used_at) + "</td>";
        tbody.appendChild(tr);
      });

      const etbody = document.querySelector("#error-table tbody");
      etbody.innerHTML = "";
      (errors.data || []).forEach((e) => {
        const tr = document.createElement("tr");
        tr.className = "err-row " + e.category;
        const msg = e.message || "";
        const firstLine = msg.split("\n")[0];
        const hasMore = msg.includes("\n");
        tr.innerHTML = "<td>" + fmtTime(e.occurred_at) + "</td><td>" + (e.model_id || "—") + "</td><td>" + e.category + "</td><td title='" +
          escapeHtml(msg).replace(/'/g, "&#39;") + "'>" + escapeHtml(firstLine) + (hasMore ? " <span class='muted'>(hover for log tail)</span>" : "") + "</td>";
        etbody.appendChild(tr);
      });
    } catch (e) {
      console.error("dashboard refresh failed", e);
    }
    await refreshCurrentModel();
  }

  async function refreshCurrentModel() {
    const panel = document.getElementById("current-model-panel");
    const body = document.getElementById("current-model-body");
    try {
      const { data: models } = await api("/models");
      const loaded = models.find((m) => m.status.value === "loaded");
      if (!loaded) {
        panel.style.display = "none";
        return;
      }
      const live = await api("/models/" + encodeURIComponent(loaded.id) + "/live");
      panel.style.display = "";

      const pct = live.n_ctx ? Math.min(100, (live.context_used / live.n_ctx) * 100) : 0;
      const barClass = pct > 90 ? "bad" : pct > 70 ? "warn" : "";

      const flagChips = [];
      for (let i = 0; i < live.args.length; i++) {
        const a = live.args[i];
        if (a.startsWith("-")) {
          const next = live.args[i + 1];
          if (next != null && !next.startsWith("-")) {
            flagChips.push("<span class='flag-chip'><span class='k'>" + escapeHtml(a) + "</span> " + escapeHtml(next) + "</span>");
            i++;
          } else {
            flagChips.push("<span class='flag-chip'><span class='k'>" + escapeHtml(a) + "</span></span>");
          }
        }
      }

      body.innerHTML =
        "<div class='cur-model-head'><span class='name'>" + escapeHtml(live.display_name) + "</span>" +
        "<span class='muted'>" + escapeHtml(live.model) + (live.profile ? ":" + escapeHtml(live.profile) : "") + "</span></div>" +
        "<div class='cur-model-stats'>" +
          "<div><div class='label'>Context size</div><div class='value'>" + (live.n_ctx != null ? live.n_ctx.toLocaleString() : "—") + "</div></div>" +
          "<div><div class='label'>n_predict</div><div class='value'>" + (live.n_predict != null ? (live.n_predict < 0 ? "unlimited" : live.n_predict.toLocaleString()) : "—") + "</div></div>" +
          "<div><div class='label'>Context used</div><div class='value'>" + live.context_used.toLocaleString() + (live.n_ctx ? " (" + pct.toFixed(0) + "%)" : "") + "</div></div>" +
          "<div><div class='label'>Slots</div><div class='value'>" + (live.total_slots ?? "—") + "</div></div>" +
        "</div>" +
        "<div class='ctx-bar'><div class='" + barClass + "' style='width:" + pct.toFixed(1) + "%'></div></div>" +
        "<div class='label' style='margin-bottom:6px'>Flags enabled</div>" +
        "<div class='flag-chips'>" + (flagChips.join("") || "<span class='muted'>none</span>") + "</div>";
    } catch (e) {
      panel.style.display = "none";
    }
  }

  function addTile(container, label, value, sub) {
    const d = document.createElement("div");
    d.className = "tile";
    d.innerHTML = "<div class='label'>" + label + "</div><div class='value'>" + value + "</div>" + (sub ? "<div class='sub'>" + sub + "</div>" : "");
    container.appendChild(d);
  }

  function pctOf(a, b) { return b > 0 ? (100 * (a || 0) / b).toFixed(0) + "%" : "—"; }
  // prompt_tokens counts only the reprocessed part, cache_tokens the reused part
  function cacheHit(cached, processed) { return pctOf(cached, (cached || 0) + (processed || 0)); }
  function fmtNum(n) { return n != null ? Number(n).toLocaleString() : "—"; }
  function fmtRate(n) { return n ? n.toFixed(1) : "—"; }

  // ------------------------------------------------------------ realtime ---
  // 1 s poll of the server-side /slots rates: 0 when nothing is being processed
  const RT_POINTS = 120;
  const rtTg = [], rtPp = [];
  async function refreshRealtime() {
    if (!document.getElementById("tab-dashboard").classList.contains("active")) return;
    let r;
    try {
      const { data } = await api("/stats/realtime");
      r = data.find((x) => x.state !== "idle") || data[0];
    } catch (e) { return; }
    rtTg.push(r ? r.tgPerSecond : 0); rtPp.push(r ? r.ppPerSecond : 0);
    if (rtTg.length > RT_POINTS) { rtTg.shift(); rtPp.shift(); }

    const tiles = document.getElementById("live-tiles");
    tiles.innerHTML = "";
    const stateText = !r ? "no model" : r.state === "prompt" ? "prompt processing" : r.state;
    addTile(tiles, "State", "<span class='state " + (r ? r.state : "idle") + "'>" + stateText + "</span>", r ? escapeHtml(r.profileId || r.modelId) : "");
    addTile(tiles, "tg/s now", r ? r.tgPerSecond.toFixed(1) : "0.0");
    addTile(tiles, "pp/s now", r ? r.ppPerSecond.toFixed(0) : "0");
    const busy = r && r.nProcessed != null;
    addTile(tiles, r && r.state !== "idle" ? "Current request" : "Last request",
      busy ? fmtNum(r.nDecoded) + " gen" : "—",
      busy ? fmtNum(r.nProcessed) + " processed · " + fmtNum(r.nCached) + " cached (" + cacheHit(r.nCached, r.nProcessed) + ")" : "");
    addTile(tiles, "Context", r && r.nPromptTokens != null ? fmtNum(r.nPromptTokens) : "—",
      r && r.nCtx ? "of " + fmtNum(r.nCtx) + " (" + pctOf(r.nPromptTokens, r.nCtx) + ")" : "");

    drawSparkline(document.getElementById("chart-realtime"), [rtTg, rtPp], { names: ["tg/s", "pp/s"], dualAxis: true });
  }

  function fmtTime(ms) { return ms ? new Date(ms).toLocaleTimeString() : "—"; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // --------------------------------------------------------------- models ---
  async function refreshModels() {
    try {
      const { data } = await api("/models");
      const tbody = document.querySelector("#models-table tbody");
      tbody.innerHTML = "";
      data.forEach((m) => {
        const tr = document.createElement("tr");
        const pill = "<span class='pill " + statusClass(m.status.value) + "'>" + m.status.value + "</span>" +
          (m.status.progress != null && m.status.value === "loading" ? "<div class='progress-bar'><div style='width:" + Math.round(m.status.progress * 100) + "%'></div></div>" : "");
        const canLoad = m.status.value === "unloaded" || m.status.value === "error";
        const canUnload = m.status.value === "loaded";
        const canDelete = m.status.value === "unloaded" || m.status.value === "error";
        tr.innerHTML = "<td>" + m.id + "</td><td>" + pill + "</td><td>" + (m.pid || "—") + "</td><td>" + (m.port || "—") +
          "</td><td>" + fmtTime(m.lastCacheSavedAt) + "</td><td>" + fmtBytes(m.cacheSizeBytes) + "</td><td></td>";
        const actionsTd = tr.lastElementChild;
        const loadBtn = mkButton("Load", "primary", !canLoad, () => doLoad(m.model, m.profile));
        const unloadBtn = mkButton("Unload", "danger", !canUnload, () => doUnload(m.model, m.profile));
        const cfgBtn = mkButton("Config", "", !!m.profile, () => openModelConfig(m.model));
        const clearCacheBtn = mkButton("Clear cache", "", !m.cacheSizeBytes, () => doClearCache(m));
        const deleteBtn = mkButton("Delete", "danger", !canDelete, () => doDelete(m));
        actionsTd.append(loadBtn, unloadBtn, cfgBtn, clearCacheBtn, deleteBtn);
        tbody.appendChild(tr);
      });
    } catch (e) {
      console.error("models refresh failed", e);
    }
  }

  function mkButton(label, cls, disabled, onClick) {
    const b = document.createElement("button");
    b.className = "action " + cls;
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }

  async function doLoad(model, profile) {
    try { await api("/models/load", { method: "POST", body: { model, profile } }); } catch (e) { alert("load failed: " + e.message); }
    refreshModels();
  }
  async function doUnload(model, profile) {
    try { await api("/models/unload", { method: "POST", body: { model, profile } }); } catch (e) { alert("unload failed: " + e.message); }
    refreshModels();
  }
  function fmtBytes(n) {
    if (!n) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(1) + " " + units[i];
  }
  async function doClearCache(m) {
    if (!confirm("Delete all saved cache slots for " + m.id + "?")) return;
    try { await api("/models/" + encodeURIComponent(m.id) + "/cache", { method: "DELETE" }); } catch (e) { alert("clear cache failed: " + e.message); }
    refreshModels();
  }
  async function doDelete(m) {
    const what = m.profile ? "profile \"" + m.profile + "\"" : "model \"" + m.model + "\" (and all its profiles)";
    if (!confirm("Delete " + what + "? This removes it from the config, not the gguf file.")) return;
    try {
      await api(m.profile ? "/profiles/" + encodeURIComponent(m.profile) : "/models/" + encodeURIComponent(m.model), { method: "DELETE" });
    } catch (e) { alert("delete failed: " + e.message); }
    refreshModels();
  }

  // Textarea may hold a JSON array ["--foo","bar"] or a raw command-line
  // string (model_args.json style, JSON-escaping and all) — the server
  // tokenizes the latter itself.
  function parseArgsInput(text) {
    const t = text.trim();
    if (!t) return [];
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) return v;
    } catch (e) { /* not JSON — send as raw string */ }
    return t;
  }

  async function openModelConfig(modelId) {
    const panel = document.getElementById("model-config-panel");
    panel.style.display = "block";
    document.getElementById("model-config-title").textContent = "Model config — " + modelId;
    const cfg = await api("/config/models/" + encodeURIComponent(modelId));
    document.getElementById("model-config-args").value = JSON.stringify(cfg.args || [], null, 2);
    document.getElementById("model-config-save").onclick = async () => {
      const note = document.getElementById("model-config-note");
      try {
        const args = parseArgsInput(document.getElementById("model-config-args").value);
        const res = await api("/config/models/" + encodeURIComponent(modelId), { method: "PATCH", body: { args } });
        note.textContent = res.requiresRestart ? "saved — restart model to apply" : "saved";
      } catch (e) {
        note.textContent = "error: " + e.message;
      }
    };
  }

  // ------------------------------------------------------------- profiles ---
  async function loadProfiles() {
    const [{ data: profiles }, { data: models }] = await Promise.all([api("/profiles"), api("/models")]);
    const modelIds = [...new Set(models.map((m) => m.model))];
    const sel = document.getElementById("new-profile-model");
    sel.innerHTML = modelIds.map((id) => "<option value='" + id + "'>" + id + "</option>").join("");

    const tbody = document.querySelector("#profiles-table tbody");
    tbody.innerHTML = "";
    Object.entries(profiles || {}).forEach(([id, p]) => {
      const tr = document.createElement("tr");
      const restoreChecked = p.prefix_cache_restore !== false;
      const rebuildChecked = !!p.prefix_cache_rebuild;
      tr.innerHTML = "<td>" + id + "</td><td>" + p.model + "</td><td>" + escapeHtml(JSON.stringify(p.args)) + "</td>" +
        "<td><label><input type='checkbox' class='pc-restore'" + (restoreChecked ? " checked" : "") + "> restore</label> " +
        "<label><input type='checkbox' class='pc-rebuild'" + (rebuildChecked ? " checked" : "") + "> rebuild</label></td><td></td>";
      const [restoreBox, rebuildBox] = tr.querySelectorAll("input[type=checkbox]");
      const savePrefixFlags = async () => {
        try {
          await api("/profiles/" + encodeURIComponent(id), {
            method: "PATCH",
            body: { prefix_cache_restore: restoreBox.checked, prefix_cache_rebuild: rebuildBox.checked },
          });
        } catch (e) { alert("save failed: " + e.message); loadProfiles(); }
      };
      restoreBox.addEventListener("change", savePrefixFlags);
      rebuildBox.addEventListener("change", savePrefixFlags);
      const edit = mkButton("Edit", "", false, () => openProfileEdit(id, p));
      const del = mkButton("Delete", "danger", false, async () => {
        await api("/profiles/" + encodeURIComponent(id), { method: "DELETE" });
        loadProfiles();
      });
      tr.lastElementChild.appendChild(edit);
      tr.lastElementChild.appendChild(del);
      tbody.appendChild(tr);
    });
  }

  function openProfileEdit(id, p) {
    document.getElementById("profile-edit-title").textContent = "Edit profile — " + id + " (" + p.model + ")";
    document.getElementById("profile-edit-args").value = JSON.stringify(p.args || [], null, 2);
    document.getElementById("profile-edit-startup").checked = !!p.load_on_startup;
    document.getElementById("profile-edit-prefix-restore").checked = p.prefix_cache_restore !== false;
    document.getElementById("profile-edit-prefix-rebuild").checked = !!p.prefix_cache_rebuild;
    document.getElementById("profile-edit-note").textContent = "";
    document.getElementById("profile-edit-panel").style.display = "block";

    document.getElementById("profile-edit-save").onclick = async () => {
      const note = document.getElementById("profile-edit-note");
      try {
        const args = parseArgsInput(document.getElementById("profile-edit-args").value);
        const startupChecked = document.getElementById("profile-edit-startup").checked;
        await api("/profiles/" + encodeURIComponent(id), {
          method: "PATCH",
          body: {
            args,
            prefix_cache_restore: document.getElementById("profile-edit-prefix-restore").checked,
            prefix_cache_rebuild: document.getElementById("profile-edit-prefix-rebuild").checked,
          },
        });
        // load_on_startup is exclusive across profiles — go through the
        // dedicated endpoint so checking one clears any other.
        if (startupChecked !== !!p.load_on_startup) {
          await api("/config/startup", { method: "PATCH", body: { profile: startupChecked ? id : null } });
        }
        note.textContent = "saved";
        loadProfiles();
      } catch (e) {
        note.textContent = "error: " + e.message;
      }
    };
  }

  document.getElementById("profile-edit-cancel").addEventListener("click", () => {
    document.getElementById("profile-edit-panel").style.display = "none";
  });

  document.getElementById("new-profile-create").addEventListener("click", async () => {
    try {
      const id = document.getElementById("new-profile-id").value.trim();
      const model = document.getElementById("new-profile-model").value;
      const args = parseArgsInput(document.getElementById("new-profile-args").value);
      const prefix_cache_restore = document.getElementById("new-profile-prefix-restore").checked;
      const prefix_cache_rebuild = document.getElementById("new-profile-prefix-rebuild").checked;
      if (!id) throw new Error("id required");
      await api("/profiles", { method: "POST", body: { id, model, args, prefix_cache_restore, prefix_cache_rebuild } });
      document.getElementById("new-profile-id").value = "";
      loadProfiles();
      refreshModels();
    } catch (e) {
      alert("create profile failed: " + e.message);
    }
  });

  // ------------------------------------------------------------- settings ---
  async function loadSettings() {
    const g = await api("/config/global");
    document.getElementById("cfg-max-resident").value = g.max_resident;
    document.getElementById("cfg-max-cache-slots").value = g.max_cache_slots_per_model;
    document.getElementById("cfg-port-lo").value = g.port_range[0];
    document.getElementById("cfg-port-hi").value = g.port_range[1];
    document.getElementById("cfg-args").value = JSON.stringify(g.args || [], null, 2);

    const [{ data: profiles }, startup] = await Promise.all([api("/profiles"), api("/config/startup")]);
    const sel = document.getElementById("cfg-startup-profile");
    sel.innerHTML = "<option value=''>(none)</option>";
    for (const id of Object.keys(profiles)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id + " (" + profiles[id].model + ")";
      sel.appendChild(opt);
    }
    sel.value = startup.profile || "";

    const paths = await api("/config/paths");
    document.getElementById("cfg-models-dir").value = paths.models_dir;

    await loadEnvTable();
  }

  // ------------------------------------------------------- environment ---
  let envCatalog = [];
  async function loadEnvTable() {
    const [{ data: catalog }, g] = await Promise.all([api("/config/env-catalog"), api("/config/global")]);
    envCatalog = catalog;
    const current = g.env || {};
    const tbody = document.querySelector("#env-table tbody");
    tbody.innerHTML = "";
    const seen = new Set();
    const rows = catalog.map((c) => ({ ...c, on: Object.prototype.hasOwnProperty.call(current, c.name), value: current[c.name] ?? c.recommendedValue }));
    for (const k of Object.keys(current)) seen.add(k);
    for (const c of catalog) seen.delete(c.name);
    for (const k of seen) rows.push({ name: k, value: current[k], on: true, recommended: false, note: "Set in global.env but not in the catalog — left as is.", notInCatalog: true });

    rows.forEach((r) => {
      const tr = document.createElement("tr");
      const onCell = document.createElement("td");
      const onBox = document.createElement("input");
      onBox.type = "checkbox";
      onBox.checked = r.on;
      onCell.appendChild(onBox);
      const nameCell = document.createElement("td");
      nameCell.textContent = r.name;
      const valCell = document.createElement("td");
      const valInput = document.createElement("input");
      valInput.type = "text";
      valInput.style.width = "90px";
      valInput.value = r.value ?? "";
      valCell.appendChild(valInput);
      const recCell = document.createElement("td");
      recCell.textContent = r.notInCatalog ? "not in catalog" : (r.recommended ? "on (" + r.recommendedValue + ")" : "off");
      tr.append(onCell, nameCell, valCell, recCell);
      tr.addEventListener("click", () => { document.getElementById("env-note").value = r.name + "\n" + r.note; });
      tr._envRow = { name: r.name, onBox, valInput };
      tbody.appendChild(tr);
    });
  }

  document.getElementById("env-save").addEventListener("click", async () => {
    const status = document.getElementById("env-note-status");
    const env = {};
    document.querySelectorAll("#env-table tbody tr").forEach((tr) => {
      const r = tr._envRow;
      if (r.onBox.checked) env[r.name] = r.valInput.value.trim() || "1";
    });
    try {
      await api("/config/global", { method: "PATCH", body: { env } });
      status.textContent = "saved — takes effect on next model load";
    } catch (e) {
      status.textContent = "error: " + e.message;
    }
  });

  document.getElementById("env-restore-recommended").addEventListener("click", () => {
    document.querySelectorAll("#env-table tbody tr").forEach((tr) => {
      const r = tr._envRow;
      const c = envCatalog.find((x) => x.name === r.name);
      if (!c) return;
      r.onBox.checked = c.recommended;
      r.valInput.value = c.recommendedValue;
    });
    document.getElementById("env-note-status").textContent = "recommended values loaded — press Save to write them";
  });

  document.getElementById("cfg-startup-save").addEventListener("click", async () => {
    const note = document.getElementById("cfg-startup-note");
    try {
      await api("/config/startup", { method: "PATCH", body: { profile: document.getElementById("cfg-startup-profile").value || null } });
      note.textContent = "saved";
    } catch (e) {
      note.textContent = "error: " + e.message;
    }
  });

  document.getElementById("cfg-models-dir-save").addEventListener("click", async () => {
    const note = document.getElementById("cfg-models-dir-note");
    try {
      await api("/config/paths", { method: "PATCH", body: { models_dir: document.getElementById("cfg-models-dir").value } });
      note.textContent = "saved";
    } catch (e) {
      note.textContent = "error: " + e.message;
    }
  });

  document.getElementById("cfg-models-dir-rescan").addEventListener("click", async () => {
    const note = document.getElementById("cfg-models-dir-note");
    try {
      const { added } = await api("/config/discover-models", { method: "POST" });
      note.textContent = added.length ? "added: " + added.join(", ") : "no new models found";
      if (added.length) await refreshModels();
    } catch (e) {
      note.textContent = "error: " + e.message;
    }
  });

  document.getElementById("cfg-save").addEventListener("click", async () => {
    const note = document.getElementById("cfg-note");
    try {
      const args = parseArgsInput(document.getElementById("cfg-args").value);
      await api("/config/global", {
        method: "PATCH",
        body: {
          max_resident: Number(document.getElementById("cfg-max-resident").value),
          max_cache_slots_per_model: Number(document.getElementById("cfg-max-cache-slots").value),
          port_range: [Number(document.getElementById("cfg-port-lo").value), Number(document.getElementById("cfg-port-hi").value)],
          args,
        },
      });
      note.textContent = "saved";
    } catch (e) {
      note.textContent = "error: " + e.message;
    }
  });

  // ------------------------------------------------------------------ logs ---
  async function loadLogsTab() {
    const idSel = document.getElementById("log-id");
    const prevId = idSel.value;
    const { data: models } = await api("/models");
    idSel.innerHTML = models.map((m) => "<option value='" + m.id + "'>" + m.id + "</option>").join("");
    if (prevId && models.some((m) => m.id === prevId)) idSel.value = prevId;
    await refreshLogFiles();
    await refreshLogBox();
  }

  async function refreshLogFiles() {
    const id = document.getElementById("log-id").value;
    if (!id) return;
    const fileSel = document.getElementById("log-file");
    const prev = fileSel.value;
    try {
      const { data: files } = await api("/logs/" + encodeURIComponent(id) + "/files");
      fileSel.innerHTML = "<option value=''>(latest)</option>" + files.map((f) => "<option value='" + f.name + "'>" + f.name + " (" + fmtBytes(f.size) + ")</option>").join("");
      if (files.some((f) => f.name === prev)) fileSel.value = prev;
    } catch (e) {
      fileSel.innerHTML = "<option value=''>(latest)</option>";
    }
  }

  async function refreshLogBox() {
    const id = document.getElementById("log-id").value;
    const box = document.getElementById("log-box");
    if (!id) { box.value = ""; return; }
    const file = document.getElementById("log-file").value;
    const lines = Number(document.getElementById("log-lines").value) || 300;
    try {
      const q = "?lines=" + lines + (file ? "&file=" + encodeURIComponent(file) : "");
      const res = await api("/logs/" + encodeURIComponent(id) + q);
      box.value = res.file ? res.lines.join("\n") : "(no log file yet for " + id + ")";
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      box.value = "error: " + e.message;
    }
  }

  document.getElementById("log-id").addEventListener("change", async () => { await refreshLogFiles(); await refreshLogBox(); });
  document.getElementById("log-file").addEventListener("change", refreshLogBox);
  document.getElementById("log-refresh").addEventListener("click", refreshLogBox);

  // ------------------------------------------------------------------ SSE ---
  function connectEvents() {
    const dot = document.getElementById("conn-dot");
    const text = document.getElementById("conn-text");
    let es;
    try {
      es = new EventSource("/v1/events?token=" + encodeURIComponent(apiKey));
      es.onopen = () => { dot.classList.add("live"); text.textContent = "live"; };
      es.onerror = () => { dot.classList.remove("live"); text.textContent = "reconnecting..."; };
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          if (["session_started", "session_ended", "request", "error"].includes(payload.type)) {
            if (document.getElementById("tab-dashboard").classList.contains("active")) refreshDashboard();
            if (document.getElementById("tab-models").classList.contains("active")) refreshModels();
          }
        } catch (e) { /* ignore malformed event */ }
      };
    } catch (e) {
      startPolling();
    }
  }

  function startPolling() {
    setInterval(() => {
      if (document.getElementById("tab-dashboard").classList.contains("active")) refreshDashboard();
      if (document.getElementById("tab-models").classList.contains("active")) refreshModels();
    }, 2000);
  }

  refreshDashboard();
  refreshModels();
  connectEvents();
  setInterval(refreshDashboard, 5000);
  refreshRealtime();
  setInterval(refreshRealtime, 1000);
  setInterval(refreshModels, 5000);
})();
