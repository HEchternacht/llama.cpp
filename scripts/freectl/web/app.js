(function () {
  "use strict";

  const KEY_STORAGE = "freectl_api_key";
  let apiKey = "test";
  try { apiKey = localStorage.getItem(KEY_STORAGE) || "test"; } catch (e) { /* private window */ }

  async function api(path, opts) {
    opts = opts || {};
    const headers = { "Authorization": "Bearer " + apiKey };
    if (opts.body !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.body); }
    let res = await fetch(path, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      apiKey = window.prompt("freectl API key:", "") || "";
      try { localStorage.setItem(KEY_STORAGE, apiKey); } catch (e) { /* ignore */ }
      headers.Authorization = "Bearer " + apiKey;
      res = await fetch(path, Object.assign({}, opts, { headers }));
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body.error && body.error.message) || ("HTTP " + res.status));
    return body;
  }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtCtx = (n) => !n ? "—" : n >= 1048576 ? (n / 1048576).toFixed(n % 1048576 ? 1 : 0) + "M" : Math.round(n / 1024) + "K";
  const lines = (t) => t.split("\n").map((s) => s.trim()).filter(Boolean);

  // ---------------------------------------------------------------- tabs ---
  document.querySelectorAll("nav.tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $("tab-" + btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "providers" || btn.dataset.tab === "settings") loadConfig();
      if (btn.dataset.tab === "ranking") refreshStatus();
    });
  });

  // -------------------------------------------------------------- status ---
  const testResults = {};

  function renderStatus(st) {
    renderRanking(st);
    $("refreshed").textContent = "models listed " + new Date(st.refreshedAt).toLocaleTimeString() +
      (st.checkedAt ? ", checked " + new Date(st.checkedAt).toLocaleTimeString() : "");
    const CHANGE_CLASS = { "new free": "ok", "free again": "ok", "left free list": "warn", "became paid": "bad" };
    $("changes").innerHTML = (st.changes || []).map((c) => "<li><span class='muted'>" + esc(new Date(c.at).toLocaleString()) +
      "</span> <span class='" + CHANGE_CLASS[c.event] + "'>" + esc(c.event) + "</span> <span class='mono'>" + esc(c.id) + "</span></li>").join("") ||
      "<li class='muted'>none yet</li>";
    document.querySelector("#paid-table tbody").innerHTML = (st.paid || []).map((p) => "<tr><td class='mono'>" + esc(p.id) + "</td><td>" +
      esc(new Date(p.since).toLocaleString()) + "</td><td class='bad'>" + esc(p.error.slice(0, 200)) + "</td></tr>").join("") ||
      "<tr><td colspan='3' class='muted'>none</td></tr>";
    $("cascade").innerHTML = st.cascade.map((id) => "<li>" + esc(id) + "</li>").join("") || "<li class='muted'>no free models</li>";

    const tbody = document.querySelector("#models-table tbody");
    tbody.innerHTML = "";
    st.models.forEach((m, i) => {
      const inCascade = st.cascade.includes(m.id);
      const state = m.agentOnly && m.lastOk !== true ? "<span class='warn' title='served only to recognised agent apps'>agent apps only</span>"
        : m.coolingDownSeconds > 0
        ? "<span class='warn' title='" + esc(m.lastError) + "'>cooldown " + m.coolingDownSeconds + "s</span>"
        : m.failed && !m.ok ? "<span class='bad' title='" + esc(m.lastError) + "'>failing</span>"
        : m.ok ? "<span class='ok'>ok</span>" : "<span class='muted'>untested</span>";
      const t = testResults[m.id];
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + (i + 1) + "</td><td class='mono'>" + esc(m.id) + (inCascade ? "" : " <span class='muted'>(not in default)</span>") +
        (t ? "<div class='" + (t.ok ? "ok" : t.agentOnly ? "warn" : "bad") + "'>" + esc(t.ok ? "test " + t.ms + " ms: " + (t.content || "(empty — reasoning only?)").slice(0, 80) : t.agentOnly ? "agent apps only (not an error)" : "test: " + t.error).slice(0, 300) + "</div>" : "") +
        "</td><td>" + (m.paramsB ? m.paramsB + "B" : "—") + "</td><td>" + fmtCtx(m.contextLength) + "</td><td>" + m.score +
        "</td><td>" + m.ok + " / " + m.failed + "</td><td>" + (m.lastLatencyMs ? m.lastLatencyMs + " ms" : "—") + "</td><td>" + state + "</td><td></td>";
      const btn = document.createElement("button");
      btn.className = "action";
      btn.textContent = "Test";
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = "…";
        try { testResults[m.id] = await api("/freectl/test", { method: "POST", body: { id: m.id } }); }
        catch (e) { testResults[m.id] = { ok: false, error: e.message }; }
        refreshStatus();
      };
      tr.lastElementChild.appendChild(btn);
      tbody.appendChild(tr);
    });

    const ptbody = document.querySelector("#prov-status-table tbody");
    ptbody.innerHTML = st.providers.map((p) =>
      "<tr><td>" + esc(p.name) + "</td><td>" + (p.enabled ? "yes" : "<span class='muted'>no</span>") + "</td><td>" + p.models +
      "</td><td>" + (p.skipped.length ? "<details><summary>" + p.skipped.length + " model(s)</summary><div class='mono muted'>" + p.skipped.map(esc).join("<br>") + "</div></details>" : "—") +
      "</td><td class='bad'>" + esc(p.error || "") + "</td></tr>").join("");
  }

  async function refreshStatus() {
    try { renderStatus(await api("/freectl/status")); } catch (e) { $("refreshed").textContent = "error: " + e.message; }
  }

  // one short request per model, a few at a time; each row shows its reply or the upstream error
  const TEST_CONCURRENCY = 4;
  async function testAll(btn, note) {
    btn.disabled = true;
    let ids;
    try { ids = (await api("/freectl/status")).models.map((m) => m.id); } catch (e) { note.textContent = e.message; btn.disabled = false; return; }
    let done = 0, ok = 0, agent = 0;
    const queue = ids.slice();
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try { testResults[id] = await api("/freectl/test", { method: "POST", body: { id } }); }
        catch (e) { testResults[id] = { ok: false, error: e.message }; }
        done++; if (testResults[id].ok) ok++; else if (testResults[id].agentOnly) agent++;
        note.textContent = "tested " + done + " / " + ids.length + " — " + ok + " ok, " + (done - ok - agent) + " failed" + (agent ? ", " + agent + " agent-apps only" : "");
        refreshStatus();
      }
    };
    await Promise.all(Array.from({ length: TEST_CONCURRENCY }, worker));
    btn.disabled = false;
  }
  $("btn-test-all").onclick = () => testAll($("btn-test-all"), $("test-all-note"));

  $("btn-refresh").onclick = async () => {
    $("btn-refresh").disabled = true;
    try { renderStatus(await api("/freectl/refresh", { method: "POST" })); } catch (e) { alert(e.message); }
    $("btn-refresh").disabled = false;
  };

  // -------------------------------------------------------------- config ---
  let config = null;
  const SETTINGS = ["free_pattern", "exclude_pattern", "min_context", "cooldown_seconds", "first_byte_timeout_seconds",
    "max_attempts", "default_context_length", "prefer_different_providers", "refresh_minutes", "check_hours", "port", "api_key"];

  async function loadConfig() {
    config = await api("/freectl/config");
    renderProviders();
    SETTINGS.forEach((k) => { const el = $("s-" + k); if (el.type === "checkbox") el.checked = !!config[k]; else el.value = config[k]; });
    $("s-priority").value = (config.priority || []).join("\n");
    $("s-cascade_exclude").value = (config.cascade_exclude || []).join("\n");
  }

  function renderProviders() {
    const list = $("prov-list");
    list.innerHTML = "";
    config.providers.forEach((p) => list.appendChild(providerCard(p)));
  }

  function providerCard(p) {
    const node = $("prov-tpl").content.firstElementChild.cloneNode(true);
    node.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.dataset.k;
      if (el.type === "checkbox") el.checked = p[k] !== false;
      else if (el.tagName === "TEXTAREA") el.value = (p[k] || []).join("\n");
      else el.value = p[k] || "";
    });
    node.querySelector("[data-act=remove]").onclick = () => node.remove();
    return node;
  }

  function readProviders() {
    return [...document.querySelectorAll("#prov-list .prov")].map((node) => {
      const p = {};
      node.querySelectorAll("[data-k]").forEach((el) => {
        const k = el.dataset.k;
        if (el.type === "checkbox") p[k] = el.checked;
        else if (el.tagName === "TEXTAREA") { const v = lines(el.value); if (v.length) p[k] = v; }
        else if (el.value.trim()) p[k] = el.value.trim();
      });
      return p;
    });
  }

  async function save(next, note) {
    note.textContent = "saving + re-listing…";
    try {
      renderStatus(await api("/freectl/config", { method: "PUT", body: next }));
      // the server checks the new key from now on
      // (only when the UI signs in with the api_key; the Workers deploy uses a separate UI password)
      if (next.api_key !== config.api_key && apiKey === config.api_key) { apiKey = next.api_key; try { localStorage.setItem(KEY_STORAGE, apiKey); } catch (e) { /* ignore */ } }
      await loadConfig();
      note.textContent = "saved";
    } catch (e) {
      note.textContent = "error: " + e.message;
    }
  }

  $("btn-add-prov").onclick = () => $("prov-list").appendChild(providerCard({ enabled: true }));
  $("btn-save-prov").onclick = () => save(Object.assign({}, config, { providers: readProviders() }), $("prov-note"));
  $("btn-save-settings").onclick = () => {
    const next = Object.assign({}, config);
    SETTINGS.forEach((k) => {
      const el = $("s-" + k);
      next[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
    });
    next.priority = lines($("s-priority").value);
    next.cascade_exclude = lines($("s-cascade_exclude").value);
    save(next, $("settings-note"));
  };

  // ------------------------------------------------------------- ranking ---
  // drag-and-drop order; saved as the full priority list (models found later rank below it by the heuristic)
  let rankDirty = false;
  let dragged = null;
  const HIDE_KEY = "freectl_hide_failing";
  try { $("rank-hide-failing").checked = localStorage.getItem(HIDE_KEY) === "1"; } catch (e) { /* ignore */ }

  function markDirty(text) {
    rankDirty = true;
    $("rank-note").textContent = text || "unsaved changes";
  }

  /** Last known outcome: this page's test result, else the server's last request/test. */
  function outcome(m) {
    const t = testResults[m.id];
    const agentOnly = { ok: null, agent: true, text: "agent apps only", error: "served only to recognised agent apps (OpenRouter app headers) — not an error; a client sending them can use it" };
    if (t && t.agentOnly) return agentOnly;
    if (!t && m.agentOnly && m.lastOk !== true) return agentOnly;
    if (t) return t.ok ? { ok: true, text: "ok " + t.ms + " ms" } : { ok: false, text: "failed", error: t.error };
    if (m.lastOk === true) return { ok: true, text: "ok" + (m.lastLatencyMs ? " " + m.lastLatencyMs + " ms" : "") };
    if (m.lastOk === false) return { ok: false, text: m.coolingDownSeconds ? "cooldown " + m.coolingDownSeconds + "s" : "failed", error: m.lastError };
    return { ok: null, text: "untested" };
  }

  function rankStatusHtml(m) {
    const o = outcome(m);
    return "<span class='" + (o.ok === true ? "ok" : o.ok === false ? "bad" : o.agent ? "warn" : "muted") + "'" + (o.agent ? " title='" + esc(o.error) + "'" : "") + ">" + esc(o.text) + "</span>";
  }

  function renumber() {
    let n = 0;
    document.querySelectorAll("#rank-list li").forEach((li) => { li.querySelector(".pos").textContent = ++n; });
  }

  function applyHideFailing() {
    const hide = $("rank-hide-failing").checked;
    document.querySelectorAll("#rank-list li").forEach((li) => li.classList.toggle("hidden", hide && li._failing));
  }

  function setError(li, o) {
    let err = li.querySelector(".err");
    if (o.ok === false && o.error && !o.agent) {
      if (!err) { err = document.createElement("span"); err.className = "err"; li.appendChild(err); }
      err.title = o.error; err.textContent = o.error;
    } else if (err) err.remove();
    li._failing = o.ok === false;
  }

  function rankItem(m) {
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.id = m.id;
    li.innerHTML = "<span class='handle' title='drag'>&#x2630;</span><span class='pos'></span>" +
      "<span class='id' title='" + esc(m.name || m.id) + "'>" + esc(m.id.slice(m.provider.length + 1)) + "</span>" +
      "<span class='pchip wide'>" + esc(m.provider) + "</span><span class='wide'>" + (m.paramsB ? m.paramsB + "B" : "—") + "</span>" +
      "<span class='wide'>" + fmtCtx(m.contextLength) + "</span><span class='st'>" + rankStatusHtml(m) + "</span>" +
      "<label class='wide'><input type='checkbox' class='indef'" + (m.inDefault ? " checked" : "") + "> default</label><span class='tb'></span>";
    setError(li, outcome(m));
    li.classList.toggle("out", !m.inDefault);
    li.querySelector(".indef").onchange = (e) => { li.classList.toggle("out", !e.target.checked); markDirty(); };

    const btn = document.createElement("button");
    btn.className = "action"; btn.textContent = "Test";
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = "…";
      try { testResults[m.id] = await api("/freectl/test", { method: "POST", body: { id: m.id } }); }
      catch (e) { testResults[m.id] = { ok: false, error: e.message }; }
      btn.disabled = false; btn.textContent = "Test";
      refreshStatus();
    };
    li.querySelector(".tb").appendChild(btn);

    li.addEventListener("dragstart", (e) => { dragged = li; li.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    li.addEventListener("dragend", () => { li.classList.remove("dragging"); dragged = null; renumber(); });
    li.addEventListener("dragover", (e) => {
      if (!dragged || dragged === li) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      li.parentNode.insertBefore(dragged, e.clientY < r.top + r.height / 2 ? li : li.nextSibling);
      if (!rankDirty) markDirty();
    });
    return li;
  }

  function renderRanking(st) {
    const list = $("rank-list");
    if (rankDirty || dragged) {
      // keep the user's unsaved order; only refresh the status cells
      st.models.forEach((m) => {
        const li = list.querySelector("li[data-id='" + CSS.escape(m.id) + "']");
        if (li) { li.querySelector(".st").innerHTML = rankStatusHtml(m); setError(li, outcome(m)); }
      });
    } else {
      list.innerHTML = "";
      st.models.forEach((m) => list.appendChild(rankItem(m)));
      renumber();
    }
    applyHideFailing();
  }

  $("rank-hide-failing").onchange = () => {
    try { localStorage.setItem(HIDE_KEY, $("rank-hide-failing").checked ? "1" : "0"); } catch (e) { /* ignore */ }
    applyHideFailing();
  };

  $("rank-drop-failing").onclick = () => {
    let n = 0;
    document.querySelectorAll("#rank-list li").forEach((li) => {
      const box = li.querySelector(".indef");
      if (li._failing && box.checked) { box.checked = false; li.classList.add("out"); n++; }
    });
    if (n) markDirty(n + " failing model(s) unchecked — Save order to apply");
    else $("rank-note").textContent = "no failing model in default";
  };

  async function saveRanking(priority) {
    const cfgNow = await api("/freectl/config");
    const lis = [...document.querySelectorAll("#rank-list li")];
    const shown = new Set(lis.map((li) => li.dataset.id));
    // exclusions of models not listed right now (e.g. a provider that is down) are kept
    const excluded = (cfgNow.cascade_exclude || []).filter((id) => !shown.has(id) && ![...shown].some((s) => s.endsWith("/" + id)));
    lis.forEach((li) => { if (!li.querySelector(".indef").checked) excluded.push(li.dataset.id); });
    rankDirty = false;
    await save(Object.assign({}, cfgNow, { priority, cascade_exclude: excluded }), $("rank-note"));
  }

  $("rank-save").onclick = () => saveRanking([...document.querySelectorAll("#rank-list li")].map((li) => li.dataset.id));
  $("rank-reset").onclick = () => {
    if (confirm("Drop the saved order and go back to the automatic (size-based) ranking?")) saveRanking([]);
  };
  $("rank-test-all").onclick = () => testAll($("rank-test-all"), $("rank-note"));

  refreshStatus();
  setInterval(() => { if ($("tab-status").classList.contains("active") || $("tab-ranking").classList.contains("active")) refreshStatus(); }, 5000);
})();
