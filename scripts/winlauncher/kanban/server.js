// Kanban board for multi-model pi orchestration - HTTP/SSE shell.
//
// This is a MODE, not a fork of pi. It drives stock `pi` as a child process
// with ordinary CLI flags and writes plain markdown; nothing here patches pi,
// installs hooks, or changes its defaults. Stop the board and pi keeps working
// exactly as before - the task files just sit on disk.
//
// Everything real lives in the three modules beside this file:
//   taskfile.js   the on-disk task format (the only thing that knows it)
//   projects.js   the registry and the single writer of task files
//   scheduler.js  the model slot and the phase-machine scheduler
//
// This file wires them to HTTP, the llama.cpp router, and pi worker children.
//
// No external dependencies. Node >= 18.

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const tf = require("./taskfile.js");
const { Registry } = require("./projects.js");
const { ModelSlot, Scheduler } = require("./scheduler.js");

const HERE = __dirname;
const PORT = Number(process.env.KANBAN_PORT || 8090);

// Resolve pi's entry script so children can be spawned as `node cli.js ...`.
// Going through pi.cmd would need shell:true, and Node does not quote argv when
// a shell is used - a multi-word prompt would fragment into separate arguments
// and pi would sit waiting on stdin forever.
const PI_CLI = process.env.PI_CLI || path.join(
    process.env.APPDATA || "", "npm", "node_modules",
    "@earendil-works", "pi-coding-agent", "dist", "cli.js",
);

// ---------------------------------------------------------------- config ---

function loadRouting() {
    // routing.json is the single source of truth for model choices; it lives one
    // directory up, beside models.ini and start_router.bat.
    for (const p of [path.join(HERE, "..", "routing.json"), path.join(HERE, "routing.json")]) {
        try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* try next */ }
    }
    throw new Error("routing.json not found next to the kanban directory");
}

const routing = loadRouting();
const ROUTER = routing.router.baseUrl.replace(/\/$/, "");
const AUTH = { Authorization: "Bearer " + routing.router.apiKey };

// ---------------------------------------------------------------- router ---

const router = {
    async list() {
        const res = await fetch(ROUTER + "/models", { headers: AUTH });
        if (!res.ok) throw new Error("GET /models -> " + res.status);
        const body = await res.json();
        const out = {};
        for (const m of body.data || []) out[m.id] = (m.status && m.status.value) || "unknown";
        return out;
    },
    async load(model) {
        const res = await fetch(ROUTER + "/models/load", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, AUTH),
            body: JSON.stringify({ model }),
        }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }));
        const body = await res.json().catch(() => ({}));
        // The router fails this fast (500 "model limit reached") when the
        // resident model still has an in-flight request; only the inference path
        // queues. Callers retry rather than treating it as fatal.
        return { ok: !!res.ok, status: res.status, body };
    },
    async unload(model) {
        await fetch(ROUTER + "/models/unload", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, AUTH),
            body: JSON.stringify({ model }),
        }).catch(() => {});
    },
};

// ------------------------------------------------------------------- sse ---

const clients = new Set();

function broadcast(event, data) {
    const payload = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
    for (const res of clients) {
        try { res.write(payload); } catch { clients.delete(res); }
    }
}

// Everything the board does is narrated here and mirrored to the UI console.
// Without it the GUI can only show end states, and a run that has gone wrong
// looks identical to one that has not started.
const ACTIVITY_MAX = 400;
const activity = [];
let seq = 0;

function note(level, msg, extra) {
    const entry = { seq: ++seq, ts: Date.now(), level, msg };
    if (extra) entry.extra = extra;
    activity.push(entry);
    if (activity.length > ACTIVITY_MAX) activity.shift();
    broadcast("log", entry);
    console.log("[kanban] " + level + "  " + msg);
    return entry;
}

// A quiet SSE stream gets dropped by idle timeouts, and the client cannot tell
// "nothing is happening" from "the connection died". A comment every 15s does.
setInterval(() => {
    for (const res of clients) {
        try { res.write(": ping\n\n"); } catch { clients.delete(res); }
    }
}, 15000);

// ------------------------------------------------------------------ wire ---

const registry = new Registry(undefined, routing.assignment || {});
const slot = new ModelSlot(router);

// Live token streams are deliberately NOT written into the task files: the card
// keeps the final Result, the UI gets the deltas over SSE and forgets them.
const live = new Map();          // `${slug}:${id}` -> { text, thinking }

function liveKey(project, task) { return project.slug + ":" + task.id; }

/**
 * Run one task as a clean-context pi child. The rendered card IS the prompt, so
 * what you read on the board is exactly what ran.
 */
function runWorker(project, task, kind, done) {
    const verify = kind === "review";
    const model = verify ? task.reviewer : task.assignee;
    const prompt = verify
        ? tf.renderReviewPrompt(task, project.meta, task.assignee)
        : tf.renderWorkerPrompt(task, project.meta);
    const key = liveKey(project, task);
    live.set(key, { text: "", thinking: "", trace: [], kind });

    const cwd = project.meta.path && fs.existsSync(project.meta.path)
        ? project.meta.path
        : process.cwd();

    note("run", verify
        ? `${task.id} verification started on ${model} (work was done by ${task.assignee})`
        : `${task.id} "${task.title}" started on ${model}`,
    { project: project.slug, id: task.id, cwd });

    // --no-extensions: a worker runs stock pi with nothing of the user's ambient
    // setup loaded. Whatever is in settings.json must not change how a card runs,
    // or the same card produces different work on different machines.
    const args = [
        PI_CLI, "--mode", "json", "--models", model,
        "--no-extensions", "-p", prompt,
    ];
    // No shell: argv is passed through verbatim, so prompts with spaces, quotes
    // and newlines survive intact.
    const child = spawn(process.execPath, args, {
        cwd,
        windowsHide: true,
        // stdin MUST be ignored, not piped: pi reads stdin for piped input and
        // an open pipe that never closes makes it hang forever instead of
        // running the -p prompt.
        stdio: ["ignore", "pipe", "pipe"],
        env: Object.assign({}, process.env, { PI_CODING_AGENT: "true" }),
    });

    let cancelled = false;
    let buf = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line.startsWith("{")) handleEvent(project, task, line);
        }
    });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });

    child.on("close", (code) => {
        const l = live.get(key) || { text: "" };
        // pi exits 0 even when the turn ended in a provider error (a 401 from the
        // router, say), so the exit code alone would report a silent success with
        // an empty card. The event stream is the authority on whether work happened.
        const failure = l.error
            || (!cancelled && !(l.text || "").trim() ? "worker produced no output" : null);
        const transcript = [
            "# " + task.id + (verify ? " verification" : " run " + task.attempts)
                + " on " + model, "",
            "## Prompt", "", "```", prompt, "```", "",
            "## Thinking", "", (l.thinking || "").trim(), "",
            "## Output", "", (l.text || "").trim(), "",
            failure ? "## Failure\n\n" + failure + "\n" : "",
            stderr.trim() ? "## stderr\n\n```\n" + stderr.trim().slice(-4000) + "\n```" : "",
        ].join("\n");
        const runName = verify ? `${task.attempts}-verify` : task.attempts;
        try { project.writeResult(task, runName, transcript); } catch { /* non-fatal */ }
        live.delete(key);

        const chars = (l.text || "").trim().length;
        if (cancelled) note("warn", `${task.id} cancelled after ${Math.round((Date.now() - (task.startedAt || Date.now())) / 1000)}s`, { id: task.id });
        else if (failure) note("error", `${task.id} failed: ${failure}`, { id: task.id });
        else note("ok", `${task.id} finished in ${Math.round((Date.now() - (task.startedAt || Date.now())) / 1000)}s, ${chars} chars`, { id: task.id });

        done({
            ok: code === 0 && !cancelled && !failure,
            cancelled,
            output: (l.text || "").trim(),
            error: cancelled ? null : String(
                failure || (code === 0 ? "" : (stderr.trim() || "pi exited with code " + code)),
            ).slice(-2000) || null,
        });
    });

    return {
        cancel() {
            cancelled = true;
            try { child.kill(); } catch { /* already gone */ }
        },
    };
}

// pi's JSON stream is the same shape for workers and the planner, so one reader
// turns it into a trace: turns, thinking, tool calls and their results. Without
// this the board can only show the final answer, which hides everything the
// agent actually did.
const TRACE_MAX = 300;
const THINK_MAX = 40000;     // per row; reasoning can run long on these models

let traceSeq = 0;

function pushTrace(sink, e) {
    e.ts = Date.now();
    e.seq = ++traceSeq;
    if (sink) {
        sink.push(e);
        if (sink.length > TRACE_MAX) sink.shift();
    }
    return e;
}

/**
 * Reasoning arrives as a stream of small deltas. One trace row per delta would
 * be unreadable, so an open `thinking` row is kept and grown in place - the
 * pane then reads like the model is typing its thought. `emit` is given either
 * a new {entry} or an {append:{seq,delta}} so the UI can do the same.
 */
function traceThinking(d, sink, emit) {
    if (!d || !d.type || !sink) return;

    const open = () => {
        const last = sink[sink.length - 1];
        if (last && last.kind === "thinking" && last.open) return last;
        const e = pushTrace(sink, { kind: "thinking", text: "", open: true });
        emit({ entry: e });
        return e;
    };

    // Measured: pi nests thinking_start/delta/end INSIDE message_update, not at
    // the top level. Unwrap once and treat both shapes the same, so this keeps
    // working if a build ever emits them bare.
    const ev = d.type === "message_update" ? (d.assistantMessageEvent || {}) : d;

    if (ev.type === "thinking_start") { open(); return; }

    if (ev.type === "thinking_end") {
        const last = sink[sink.length - 1];
        if (last && last.kind === "thinking") {
            last.open = false;
            emit({ close: { seq: last.seq } });
        }
        return;
    }

    if (ev.type === "thinking_delta") {
        const delta = ev.delta || "";
        if (!delta) return;
        const e = open();
        if (e.text.length >= THINK_MAX) return;
        e.text += delta;
        emit({ append: { seq: e.seq, delta } });
    }
}

function traceFromEvent(d, sink) {
    if (!d || !d.type) return null;
    let e = null;
    if (d.type === "turn_start") e = { kind: "turn" };
    else if (d.type === "tool_execution_start") {
        e = { kind: "tool", name: d.toolName, args: summarise(d.args) };
    } else if (d.type === "tool_execution_end") {
        const txt = ((d.result && d.result.content) || [])
            .filter((c) => c.type === "text").map((c) => c.text).join("\n");
        e = { kind: "tool_result", name: d.toolName, text: firstLines(txt, 12) };
    } else if (d.type === "auto_retry_start") {
        e = { kind: "note", text: "auto-retry" };
    }
    if (!e) return null;
    return pushTrace(sink, e);
}

function summarise(args) {
    if (!args || typeof args !== "object") return "";
    const parts = [];
    for (const [k, v] of Object.entries(args)) {
        let s = typeof v === "string" ? v : JSON.stringify(v);
        if (s === undefined) s = "";
        if (s.length > 90) s = s.slice(0, 90) + "…";
        parts.push(k + "=" + s);
        if (parts.join(" ").length > 220) break;
    }
    return parts.join("  ");
}

function firstLines(text, n) {
    const lines = String(text || "").split("\n").filter((l) => l.trim());
    const out = lines.slice(0, n).join("\n");
    return lines.length > n ? out + "\n… +" + (lines.length - n) + " more lines" : out;
}

function handleEvent(project, task, line) {
    let d;
    try { d = JSON.parse(line); } catch { return; }
    const key = liveKey(project, task);
    const l = live.get(key);
    if (!l) return;

    const tr = traceFromEvent(d, l.trace);
    if (tr) broadcast("trace", { project: project.slug, id: task.id, entry: tr });
    traceThinking(d, l.trace, (payload) =>
        broadcast("trace", Object.assign({ project: project.slug, id: task.id }, payload)));

    if (d.type === "message_update") {
        const ev = d.assistantMessageEvent || {};
        if (ev.type === "text_delta") {
            l.text += ev.delta || "";
            broadcast("delta", { project: project.slug, id: task.id, kind: "text", delta: ev.delta || "" });
        } else if (ev.type === "thinking_delta") {
            l.thinking += ev.delta || "";
            broadcast("delta", { project: project.slug, id: task.id, kind: "thinking", delta: ev.delta || "" });
        }
        return;
    }

    // A turn that ends in a provider or API error carries stopReason "error" and
    // an errorMessage, while the process still exits 0.
    if (d.type === "turn_end" || d.type === "message_end" || d.type === "agent_end") {
        for (const msg of (d.messages || (d.message ? [d.message] : []))) {
            if (msg && msg.stopReason === "error" && msg.errorMessage) {
                l.error = String(msg.errorMessage).slice(0, 1000);
            }
        }
    }

    if (d.type === "agent_end") {
        // Authoritative final content; the deltas above are only for the live view.
        const msgs = d.messages || [];
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role !== "assistant") continue;
            const text = (msgs[i].content || [])
                .filter((c) => c.type === "text").map((c) => c.text).join("");
            if (text) l.text = text;
            break;
        }
    }
}

const scheduler = new Scheduler({ registry, slot, config: routing, runner: runWorker });

// ---------------------------------------------------------------- planner ---

// The planning agent is bigbang with the kanban tools. It runs one-shot with a
// clean context every time: the task files are its memory, so it re-reads the
// board through kanban_get_board rather than carrying a conversation that an
// eviction would destroy anyway.
const PLANNER_EXT = path.join(HERE, "kanban-tools.ts");
let planner = null;   // { child, project, started, text }

const PLANNER_BRIEF = `You are the planning agent for this project's kanban board.

Your job is to turn the objective into task cards other agents can execute, and to
keep those cards correct as results come in. You do NOT do the work yourself.

Always start by calling kanban_get_board so you are working from the real state.

When you create tasks:
- Each card is read by a worker that sees ONLY that card. It cannot see this
  conversation and cannot ask you anything, so Context must be self-contained.
- Keep every complexity at 7 or below. The board refuses 8+. Split instead.
- Tasks that may run at the same time must not list the same file.
- Use dependsOn for real ordering constraints. A task that DESCRIBES, DOCUMENTS,
  TESTS or REVIEWS the output of another task depends on it - writing the docs
  before the code exists produces documentation for something that is not there.
  Ask for each pair: could B be done correctly if A had not run yet? If not, B
  depends on A.
- Do not over-order either: two tasks that touch different files and do not read
  each other's output should be independent so they can run at the same time.

Available workers: ${Object.entries(routing.models).map(([k, v]) => `${k} (${v.desc})`).join("; ")}.
Leave assignee empty unless you have a reason - complexity picks the model.`;

function plannerStatus() {
    if (!planner) return { running: false };
    return {
        running: true,
        kind: planner.kind || "planner",
        project: planner.project,
        started: planner.started,
        text: planner.text.slice(-4000),
        trace: planner.trace.slice(-80),
    };
}

async function startPlanner(project, message, opts) {
    const o = opts || {};
    const model = routing.mainModel;
    // The planner is a model user like any worker. Taking the slot is what stops
    // the scheduler dispatching underneath it - without this the two compete,
    // the router thrashes between models, and both sides lose.
    slot.acquire("agent", "planner:" + project.slug);
    changed();
    const ready = await slot.ensure(model);
    if (!ready) {
        slot.release();
        note("error", `planner could not load ${model} - is the router up?`);
        changed();
        return null;
    }
    const prompt = (o.brief || PLANNER_BRIEF)
        + `\n\nProject: ${project.meta.name}\nObjective: ${project.meta.objective || "(none set)"}`
        + (project.meta.constraints ? `\nConstraints: ${project.meta.constraints}` : "")
        + `\n\n--- your instruction ---\n${message}`;

    const cwd = project.meta.path && fs.existsSync(project.meta.path)
        ? project.meta.path : process.cwd();

    note("run", `${o.kind || "planner"} started on ${model}: ${message.split("\n")[0].slice(0, 80)}`);

    const child = spawn(process.execPath, [
        PI_CLI, "--mode", "json", "--models", model,
        // Discovery off; an explicit -e still loads, so the planner gets the
        // kanban tools and nothing else.
        "--no-extensions", "--extension", PLANNER_EXT, "-p", prompt,
    ], {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: Object.assign({}, process.env, {
            PI_CODING_AGENT: "true",
            KANBAN_URL: "http://127.0.0.1:" + PORT,
            KANBAN_PROJECT: project.slug,
        }),
    });

    planner = {
        child, project: project.slug, started: Date.now(),
        text: "", trace: [], kind: o.kind || "planner",
    };

    let buf = "", stderr = "";
    child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("{")) continue;
            let d;
            try { d = JSON.parse(line); } catch { continue; }
            const tr = traceFromEvent(d, planner.trace);
            if (tr) {
                broadcast("planner", { entry: tr });
                if (tr.kind === "tool") {
                    note("sched", (o.kind || "planner") + ": " + tr.name + " " + (tr.args || ""));
                }
            }
            traceThinking(d, planner.trace, (payload) => broadcast("planner", payload));
            if (d.type === "message_update") {
                const ev = d.assistantMessageEvent || {};
                if (ev.type === "text_delta") {
                    planner.text += ev.delta || "";
                    broadcast("planner", { delta: ev.delta || "" });
                }
            } else if (d.type === "message_end" || d.type === "agent_end") {
                for (const msg of (d.messages || (d.message ? [d.message] : []))) {
                    if (msg && msg.stopReason === "error" && msg.errorMessage) {
                        planner.error = String(msg.errorMessage).slice(0, 500);
                    }
                }
            }
        }
    });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });

    child.on("close", (code) => {
        const secs = Math.round((Date.now() - planner.started) / 1000);
        const who = planner.kind || "planner";
        if (planner.cancelled) note("warn", `${who} cancelled after ${secs}s`);
        else if (planner.error) note("error", `${who} failed: ${planner.error}`);
        else if (code !== 0) note("error", `${who} exited ${code}: ${stderr.trim().slice(-400)}`);
        else note("ok", `${who} finished in ${secs}s`);
        broadcast("planner", { done: true, text: planner.text.slice(-8000) });
        planner = null;
        slot.release();
        changed();
        setImmediate(() => scheduler.tick());
    });

    changed();
    return planner;
}

// A message typed while something is running. "Steer" waits for the drain -
// no swap, nothing killed. "Interrupt" kills first and lands here too, so the
// start path is the same either way.
let pendingSteer = null;

function steerStatus() {
    if (!pendingSteer) return null;
    return {
        project: pendingSteer.slug, mode: pendingSteer.mode,
        at: pendingSteer.at, message: pendingSteer.message.slice(0, 400),
    };
}

async function drainSteer() {
    if (!pendingSteer || planner) return;
    if (scheduler.running.size || slot.busy || scheduler.ticking) return;
    const proj = registry.get(pendingSteer.slug);
    const { message } = pendingSteer;
    pendingSteer = null;
    if (!proj) return;
    await startPlanner(proj, message);
}

let changeTimer = null;
let lastNote = null;
function changed() {
    // The scheduler's note is the single best "what is it doing right now"
    // signal, so every transition of it becomes a console line.
    if (scheduler.note !== lastNote) {
        lastNote = scheduler.note;
        note("sched", lastNote);
    }
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => broadcast("state", snapshot()), 60);
}
registry.on("changed", changed);
scheduler.on("changed", changed);
slot.on("changed", changed);

// The model being swapped is the expensive event on this box, so say exactly
// what it is being swapped in FOR, and what is queued behind that batch.
scheduler.on("batch", ({ model, ids, width, queued }) => {
    const w = width > 1 ? `, ${width} at a time` : "";
    note("model", `${model} <- ${ids.join(", ")}${w}`
        + (queued ? ` (${queued} more queued behind them)` : ""));
});
scheduler.on("topup", ({ model, added, width, running }) => {
    note("run", `slot freed on ${model}: starting ${added.join(", ")}`
        + ` (${running} of ${width} running)`);
});
scheduler.on("verdict", ({ id, ok, by, reason, fails }) => {
    if (ok) note("ok", `${id} verified by ${by}: PASS - ${reason || ""}`.trim(), { id });
    else if (fails >= 2) note("error", `${id} failed verification twice - stopping: ${reason}`, { id });
    else note("warn", `${id} failed verification by ${by}, sending it back: ${reason}`, { id });
});

// ---------------------------------------------------------------- models ---

let modelState = {};
async function pollModels() {
    try {
        const state = await router.list();
        // Keep the slot's idea of what is resident honest even when a model is
        // loaded or unloaded from outside the board.
        const loaded = Object.keys(state).find((m) => state[m] === "loaded") || null;
        if (loaded !== slot.loaded) slot.loaded = loaded;
        if (modelState.__down) note("ok", "router is back on " + ROUTER);
        if (JSON.stringify(state) !== JSON.stringify(modelState)) {
            for (const id of Object.keys(state)) {
                if (modelState[id] !== state[id] && !modelState.__down) {
                    note("model", `${id}: ${modelState[id] || "?"} -> ${state[id]}`);
                }
            }
            modelState = state;
            broadcast("models", modelState);
        }
    } catch {
        if (modelState.__down !== true) {
            modelState = { __down: true };
            note("error", "router unreachable at " + ROUTER + " - start start_router.bat");
            broadcast("models", modelState);
        }
    }
}

// ------------------------------------------------------------------ http ---

function json(res, code, body) {
    const s = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
    res.end(s);
}

function readBody(req) {
    return new Promise((resolve) => {
        let b = "";
        req.on("data", (c) => { b += c; });
        req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
    });
}

function snapshot() {
    const active = registry.active();
    return {
        projects: registry.list(),
        active: active ? active.toJSON() : null,
        models: modelState,
        sched: scheduler.status(),
        planner: plannerStatus(),
        steer: steerStatus(),
        routing: {
            models: routing.models,
            taskTypes: routing.taskTypes,
            mainModel: routing.mainModel,
            assignment: routing.assignment,
        },
        statuses: tf.STATUSES,
        piFound: fs.existsSync(PI_CLI),
        router: ROUTER,
        projectsRoot: registry.root,
    };
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost:" + PORT);
    const p = url.pathname;
    let m;

    if (p === "/" || p === "/index.html") {
        const html = fs.readFileSync(path.join(HERE, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
    }

    if (p === "/api/events") {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        res.write("retry: 1000\n\n");
        clients.add(res);
        // Replay the console so a reconnecting tab does not come back blank.
        for (const e of activity.slice(-120)) {
            res.write("event: log\ndata: " + JSON.stringify(e) + "\n\n");
        }
        res.write("event: state\ndata: " + JSON.stringify(snapshot()) + "\n\n");
        req.on("close", () => clients.delete(res));
        return;
    }

    if (p === "/api/activity") return json(res, 200, { activity });

    // Typing an absolute path into a text box is the single most likely way to
    // fail at "new project", and a browser cannot offer a folder picker, so the
    // server lists directories for the UI to walk.
    if (p === "/api/browse") {
        const want = url.searchParams.get("path");
        try {
            if (!want) {
                const drives = [];
                for (const l of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
                    if (fs.existsSync(l + ":\\")) drives.push({ name: l + ":\\", path: l + ":\\" });
                }
                return json(res, 200, { path: "", parent: null, dirs: drives });
            }
            const here = path.resolve(want);
            const dirs = fs.readdirSync(here, { withFileTypes: true })
                .filter((d) => d.isDirectory() && !d.name.startsWith("$"))
                .map((d) => ({ name: d.name, path: path.join(here, d.name) }))
                .slice(0, 500);
            const up = path.dirname(here);
            return json(res, 200, { path: here, parent: up === here ? "" : up, dirs });
        } catch (e) {
            return json(res, 400, { error: e.message });
        }
    }

    if (p === "/api/state") return json(res, 200, snapshot());

    // -- projects ------------------------------------------------------------

    if (p === "/api/projects" && req.method === "POST") {
        const b = await readBody(req);
        if (!b.path) return json(res, 400, { error: "path required" });
        try {
            const proj = registry.create(b.path, b.objective, b.name);
            note("ok", `project "${proj.meta.name}" created at ${proj.dir}`);
            registry.setActive(proj.slug);
            changed();
            return json(res, 200, proj.toJSON());
        } catch (e) {
            note("error", `could not create project from "${b.path}": ${e.message}`);
            return json(res, 400, { error: e.message });
        }
    }

    m = p.match(/^\/api\/projects\/([^/]+)\/activate$/);
    if (m && req.method === "POST") {
        try { registry.setActive(decodeURIComponent(m[1])); }
        catch (e) { return json(res, 404, { error: e.message }); }
        changed();
        setImmediate(() => scheduler.tick());
        return json(res, 200, { active: registry.activeSlug });
    }

    m = p.match(/^\/api\/projects\/([^/]+)\/meta$/);
    if (m && req.method === "PATCH") {
        const proj = registry.get(decodeURIComponent(m[1]));
        if (!proj) return json(res, 404, { error: "no such project" });
        const b = await readBody(req);
        for (const k of ["name", "objective", "constraints"]) {
            if (b[k] !== undefined) proj.meta[k] = b[k];
        }
        proj.saveMeta();
        changed();
        return json(res, 200, proj.meta);
    }

    // -- tasks ---------------------------------------------------------------

    // Compact board view for the planner: enough to reason about the graph
    // without reading every file, small enough not to eat its context.
    // Live trace of what a worker is doing: turns, tool calls and their results.
    // The card only ever keeps the final Result, so this is the "as if I were
    // sitting in pi" view.
    m = p.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/trace$/);
    if (m && req.method === "GET") {
        const l = live.get(decodeURIComponent(m[1]) + ":" + decodeURIComponent(m[2]));
        return json(res, 200, {
            trace: l ? l.trace : [],
            text: l ? l.text : "",
            thinking: l ? (l.thinking || "").slice(-4000) : "",
            active: !!l,
        });
    }

    m = p.match(/^\/api\/projects\/([^/]+)\/board$/);
    if (m && req.method === "GET") {
        const proj = registry.get(decodeURIComponent(m[1]));
        if (!proj) return json(res, 404, { error: "no such project" });
        return json(res, 200, {
            objective: proj.meta.objective,
            constraints: proj.meta.constraints || "",
            cycles: proj.cycles || [],
            tasks: [...proj.tasks.values()].map((t) => ({
                id: t.id, title: t.title, status: t.status, complexity: t.complexity,
                assignee: t.assignee, taskType: t.taskType, priority: t.priority,
                parent: t.parent, dependsOn: t.dependsOn, files: t.files,
                blockedReason: t.blockedReason,
                resultSummary: (t.sections.Result || "").trim().slice(0, 400) || null,
            })),
        });
    }

    // Bulk create in one call: ids are allocated here so the planner never has
    // to guess them, and the whole set is rejected if it names a missing dep.
    m = p.match(/^\/api\/projects\/([^/]+)\/tasks\/bulk$/);
    if (m && req.method === "POST") {
        const proj = registry.get(decodeURIComponent(m[1]));
        if (!proj) return json(res, 404, { error: "no such project" });
        const b = await readBody(req);
        const incoming = Array.isArray(b.tasks) ? b.tasks : [];
        if (!incoming.length) return json(res, 400, { error: "tasks[] required" });

        // Map the planner's local refs ("1", "T-A", whatever) onto real ids so
        // it can express dependencies inside a single call.
        const idFor = new Map();
        let next = Number(proj.nextId().replace("T-", ""));
        for (const t of incoming) {
            const id = "T-" + String(next++).padStart(3, "0");
            idFor.set(String(t.ref != null ? t.ref : t.id != null ? t.id : id), id);
            t.__id = id;
        }
        const resolve = (r) => idFor.get(String(r)) || String(r);

        const known = new Set([...proj.tasks.keys(), ...incoming.map((t) => t.__id)]);
        const bad = [];
        for (const t of incoming) {
            for (const d of (t.dependsOn || [])) {
                if (!known.has(resolve(d))) bad.push(`${t.__id} depends on unknown ${d}`);
            }
        }
        if (bad.length) return json(res, 400, { error: bad.join("; ") });

        const made = [];
        for (const t of incoming) {
            const task = tf.makeTask({
                id: t.__id,
                title: t.title,
                status: t.status || "ready",
                complexity: t.complexity,
                assignee: t.assignee || null,
                taskType: t.taskType || null,
                priority: t.priority,
                parent: t.parent ? resolve(t.parent) : null,
                dependsOn: (t.dependsOn || []).map(resolve),
                files: t.files || [],
                needsTesting: t.needsTesting === true,
                createdBy: "planner",
                sections: {
                    Description: t.description || "",
                    Context: t.context || "",
                    Acceptance: t.acceptance || "",
                    Result: "",
                },
            });
            proj.writeTask(task);
            made.push({ id: task.id, title: task.title, status: task.status });
        }
        note("ok", `planner created ${made.length} task(s): ${made.map((x) => x.id).join(", ")}`);
        changed();
        setImmediate(() => scheduler.tick());
        return json(res, 200, { created: made, cycles: proj.cycles || [] });
    }

    m = p.match(/^\/api\/projects\/([^/]+)\/tasks$/);
    if (m && req.method === "POST") {
        const proj = registry.get(decodeURIComponent(m[1]));
        if (!proj) return json(res, 404, { error: "no such project" });
        const b = await readBody(req);
        if (!b.title) return json(res, 400, { error: "title required" });
        const task = tf.makeTask(Object.assign({}, b, {
            id: b.id || proj.nextId(),
            createdBy: b.createdBy || "user",
            status: b.status || "draft",
        }));
        proj.writeTask(task);
        note("ok", `${task.id} "${task.title}" created (${task.status}, complexity ${task.complexity == null ? "-" : task.complexity})`);
        changed();
        setImmediate(() => scheduler.tick());
        return json(res, 200, { id: task.id });
    }

    m = p.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)$/);
    if (m && (req.method === "PATCH" || req.method === "DELETE")) {
        const proj = registry.get(decodeURIComponent(m[1]));
        if (!proj) return json(res, 404, { error: "no such project" });
        const task = proj.tasks.get(decodeURIComponent(m[2]));
        if (!task) return json(res, 404, { error: "no such task" });

        if (req.method === "DELETE") {
            if (task.status === "running") return json(res, 409, { error: "cancel it first" });
            proj.deleteTask(task.id);
            changed();
            return json(res, 200, { ok: true });
        }

        const b = await readBody(req);
        if (task.status === "running") return json(res, 409, { error: "task is running" });
        for (const k of ["title", "complexity", "assignee", "taskType", "priority",
            "parent", "dependsOn", "files", "needsTesting", "status"]) {
            if (b[k] !== undefined) task[k] = b[k];
        }
        // Hand edits are tagged so the planner is told not to silently discard them.
        task.createdBy = b.createdBy || "user";
        if (b.sections) Object.assign(task.sections, b.sections);
        proj.writeTask(task);
        changed();
        setImmediate(() => scheduler.tick());
        return json(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/(approve|hold|rerun|cancel)$/);
    if (m && req.method === "POST") {
        const proj = registry.get(decodeURIComponent(m[1]));
        if (!proj) return json(res, 404, { error: "no such project" });
        const task = proj.tasks.get(decodeURIComponent(m[2]));
        if (!task) return json(res, 404, { error: "no such task" });
        const action = m[3];

        if (action === "cancel") {
            const running = scheduler.running.get(task.id);
            if (running) { try { running.child.cancel(); } catch { /* gone */ } }
            else { task.status = "draft"; proj.writeTask(task); }
        } else if (action === "hold") {
            if (task.status !== "running") { task.status = "draft"; proj.writeTask(task); }
        } else if (action === "approve") {
            // recompute() decides ready vs blocked vs needs-decomposition; all
            // approval does is release the card from the draft hold.
            if (task.status === "draft") { task.status = "ready"; proj.writeTask(task); }
        } else if (action === "rerun") {
            task.status = "ready";
            note("ok", `${task.id} queued for a re-run`);
            task.sections.Result = "";
            task.startedAt = task.endedAt = null;
            proj.writeTask(task);
        }
        changed();
        setImmediate(() => scheduler.tick());
        return json(res, 200, { ok: true });
    }

    // -- scheduler / models --------------------------------------------------

    // -- planner -------------------------------------------------------------

    m = p.match(/^\/api\/projects\/([^/]+)\/plan$/);
    if (m && req.method === "POST") {
        const proj = registry.get(decodeURIComponent(m[1]));
        if (!proj) return json(res, 404, { error: "no such project" });
        const b = await readBody(req);
        const message = String(b.message || "").trim()
            || "Plan the work needed to reach the objective.";
        const mode = b.mode === "now" ? "now" : "steer";

        // Interrupt: everything stops, the planner answers immediately. The
        // workers must die BEFORE the swap - the router will not evict a model
        // with a request in flight.
        if (mode === "now") {
            if (planner) {
                planner.cancelled = true;
                try { planner.child.kill(); } catch { /* already gone */ }
            }
            const killed = scheduler.interrupt();
            if (killed.length) note("warn", `interrupted ${killed.join(", ")} to answer you now`);
            pendingSteer = { slug: proj.slug, message, at: Date.now(), mode };
            note("run", "queued for immediate start: " + firstLines(message, 1).slice(0, 80));
            changed();
            setTimeout(() => drainSteer(), 200);
            return json(res, 200, { queued: true, mode, killed });
        }

        // Steer: no swap, nothing dies. The message is delivered at the next
        // boundary - when the running batch drains and the slot comes free.
        if (planner || scheduler.running.size || slot.busy) {
            pendingSteer = { slug: proj.slug, message, at: Date.now(), mode };
            note("ok", "steer queued - it runs when the current work drains");
            changed();
            return json(res, 200, { queued: true, mode });
        }
        await startPlanner(proj, message);
        if (!planner) return json(res, 503, { error: "planner could not start - check the router" });
        return json(res, 200, plannerStatus());
    }

    if (p === "/api/planner/steer" && req.method === "DELETE") {
        pendingSteer = null;
        note("warn", "queued steer dropped");
        changed();
        return json(res, 200, { ok: true });
    }

    if (p === "/api/planner" && req.method === "GET") return json(res, 200, plannerStatus());

    if (p === "/api/planner/cancel" && req.method === "POST") {
        if (!planner) return json(res, 200, { ok: true });
        planner.cancelled = true;
        try { planner.child.kill(); } catch { /* already gone */ }
        return json(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/scheduler\/(pause|resume|interrupt|tick)$/);
    if (m && req.method === "POST") {
        if (m[1] === "pause") scheduler.setPaused(true);
        else if (m[1] === "resume") scheduler.setPaused(false);
        else if (m[1] === "interrupt") {
            const ids = scheduler.interrupt();
            note("warn", ids.length ? "interrupted " + ids.join(", ") : "nothing was running");
            return json(res, 200, { interrupted: ids });
        } else scheduler.tick();
        return json(res, 200, scheduler.status());
    }

    m = p.match(/^\/api\/models\/(load|unload)$/);
    if (m && req.method === "POST") {
        const b = await readBody(req);
        if (!b.model) return json(res, 400, { error: "model required" });
        if (m[1] === "load") {
            const r = await router.load(b.model);
            await pollModels();
            return json(res, r.ok ? 200 : 503, r.body);
        }
        await router.unload(b.model);
        slot.loaded = null;
        await pollModels();
        return json(res, 200, { ok: true });
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
});

// ------------------------------------------------------------------ boot ---

registry.loadAll();

// A task that was mid-flight when the board died is not running any more. Put
// it back in line rather than leaving a card wedged in `running` forever.
for (const proj of registry.projects.values()) {
    for (const t of proj.tasks.values()) {
        if (t.status === "running") { t.status = "ready"; t.startedAt = null; proj.writeTask(t); }
    }
}

pollModels();
setInterval(pollModels, 2000);
setInterval(() => {
    // Also picks up projects created or deleted outside the board.
    const gone = registry.prune();
    for (const slug of gone) note("warn", `project ${slug} disappeared from disk, removed from the board`);
    let added = 0;
    try {
        for (const d of fs.readdirSync(registry.root, { withFileTypes: true })) {
            if (d.isDirectory() && !registry.projects.has(d.name)) {
                registry.open(path.join(registry.root, d.name));
                note("ok", `picked up project ${d.name} from disk`);
                added++;
            }
        }
    } catch { /* root may be mid-write */ }
    if (gone.length || added) changed();
    scheduler.tick();
    // Deferred by a tick of the event loop: tick() is async, so checking
    // immediately would always see it still running and never fire.
    setTimeout(() => {
        drainSteer().catch((e) => note("error", "steer failed to start: " + e.message));
    }, 50);
}, 3000);

server.listen(PORT, "127.0.0.1", () => {
    console.log("kanban board  http://127.0.0.1:" + PORT);
    console.log("router        " + ROUTER);
    console.log("pi            " + PI_CLI);
    console.log("projects      " + registry.root + "  (" + registry.projects.size + " found)");
    note("ok", "board up on :" + PORT + ", " + registry.projects.size + " project(s) loaded");
    if (!fs.existsSync(PI_CLI)) note("error", "pi cli not found at " + PI_CLI + " - tasks cannot run");
    if (!fs.existsSync(PI_CLI)) {
        console.warn("[warn] pi entry script not found - tasks will fail to start.");
        console.warn("       set PI_CLI to pi-coding-agent's dist/cli.js");
    }
});

process.on("SIGINT", () => { registry.closeAll(); process.exit(0); });
