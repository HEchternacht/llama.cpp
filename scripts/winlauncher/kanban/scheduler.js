// Scheduling and the model slot.
//
// ModelSlot is the ONLY path to a model. Both worker runs and (later) main-agent
// turns acquire it, so "who is using the model" has exactly one answer and
// wait/interrupt is not a special case bolted onto the chat box.
//
// The scheduler is a phase machine, not a workflow engine: drain the loaded
// model's ready tasks, then swap. Swaps cost 28-37 s for the 23 GB models, so
// batching is the whole point.

"use strict";

const { EventEmitter } = require("node:events");
const tf = require("./taskfile.js");

// --------------------------------------------------------------- ModelSlot ---

class ModelSlot extends EventEmitter {
    constructor(router) {
        super();
        this.router = router;
        this.holder = null;          // { kind: "worker"|"agent", label }
        this.loaded = null;          // model id the router reports as loaded
        this.loading = null;
        this.waiters = [];
    }

    get busy() { return this.holder !== null; }

    describe() {
        return {
            loaded: this.loaded,
            loading: this.loading,
            holder: this.holder,
        };
    }

    /**
     * Ensure `model` is resident. The router refuses to evict a model with an
     * in-flight request (500 "model limit reached"), which is a feature - it
     * means a swap can never kill a running generation - so callers retry.
     */
    async ensure(model) {
        if (this.loaded === model) return true;
        this.loading = model;
        this.emit("changed");
        try {
            const r = await this.router.load(model);
            // 400 "model is already running" is success with a stale local view,
            // not a failure - retrying it would stall until the next poll.
            const already = r.status === 400
                && /already running/i.test(JSON.stringify(r.body || ""));
            if (!r.ok && !already) return false;
            this.loaded = model;
            return true;
        } finally {
            this.loading = null;
            this.emit("changed");
        }
    }

    acquire(kind, label) {
        if (this.holder) return false;
        this.holder = { kind, label, since: Date.now() };
        this.emit("changed");
        return true;
    }

    release() {
        this.holder = null;
        this.emit("changed");
        const w = this.waiters.shift();
        if (w) w();
    }

    /** Resolves when the slot is free. Used by the "Wait" contention choice. */
    waitFree() {
        if (!this.holder) return Promise.resolve();
        return new Promise((resolve) => this.waiters.push(resolve));
    }
}

// -------------------------------------------------------------- Scheduler ---

const TERMINAL = ["done", "failed", "cancelled"];

// How many times a card may come back from verification before it is the
// human's problem: once to re-run the work, once more to confirm.
const MAX_REVIEW_FAILS = 2;

class Scheduler extends EventEmitter {
    constructor({ registry, slot, config, runner }) {
        super();
        this.registry = registry;
        this.slot = slot;
        this.config = config;
        this.runner = runner;        // (project, task) -> child handle
        this.paused = false;
        this.note = "idle";
        this.running = new Map();    // taskId -> { project, task, child }
        this.ticking = false;
    }

    status() {
        return {
            paused: this.paused,
            note: this.note,
            slot: this.slot.describe(),
            running: [...this.running.values()].map((r) => ({
                id: r.task.id, project: r.project.slug, model: r.model,
                kind: r.kind || "work",
            })),
        };
    }

    setPaused(v) {
        this.paused = !!v;
        this.note = this.paused ? "paused" : "resumed";
        this.emit("changed");
        if (!this.paused) this.tick();
    }

    /** Model for a task: explicit assignee wins, else complexity + type bands. */
    assign(task) {
        if (task.assignee) return task.assignee;
        const a = this.config.assignment || {};
        const bands = a.bands || [];
        const codeTypes = a.codeTypes || [];
        const isCode = codeTypes.includes(task.taskType);
        const cx = task.complexity == null ? 5 : task.complexity;
        for (const b of bands) {
            if (cx <= b.upTo) {
                if (isCode && b.code) return b.code;
                return b.model || b.default;
            }
        }
        return this.config.mainModel || "bigbang";
    }

    readyTasks(project) {
        const out = [];
        for (const t of project.tasks.values()) {
            if (t.status !== "ready") continue;
            if (t.errors && t.errors.length) continue;   // never run a malformed card
            out.push(t);
        }
        return out.sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id));
    }

    /**
     * Who verifies a finished card. Never the model that wrote it: an agent
     * asked to check its own work agrees with itself, and it is blind to the
     * bug it just introduced. Order is config; the first model that is not the
     * author wins.
     */
    reviewerFor(task) {
        const r = (this.config.assignment || {}).review || {};
        if (r.enabled === false) return null;
        const order = r.order || ["kat", "bigbang", "bonsai"];
        return order.find((m) => m !== task.assignee && this.config.models[m]) || null;
    }

    /**
     * Everything the board could run right now, work and verification alike.
     * Review runs sort first: a card stuck in review blocks everything that
     * depends on it, so verifying is worth more than starting new work.
     */
    runnables(project) {
        const out = [];
        for (const t of project.tasks.values()) {
            if (t.errors && t.errors.length) continue;
            if (t.status === "ready") {
                out.push({ task: t, kind: "work", model: this.assign(t) });
            } else if (t.status === "review") {
                // Give up rather than spin: a card whose verification keeps
                // failing to RUN is a human problem, not a scheduling one.
                if ((t.reviewFails || 0) >= MAX_REVIEW_FAILS) continue;
                const m = this.reviewerFor(t);
                if (m) out.push({ task: t, kind: "review", model: m });
            }
        }
        return out.sort((a, b) =>
            (a.kind === b.kind ? 0 : a.kind === "review" ? -1 : 1)
            || (a.task.priority - b.task.priority)
            || String(a.task.id).localeCompare(String(b.task.id)));
    }

    /**
     * Two tasks may run together only if their declared `files` are disjoint.
     * Without this, aggressive decomposition produces concurrent writers to the
     * same file - the obvious failure mode of 4-wide execution.
     */
    conflicts(task, others) {
        const mine = new Set((task.files || []).map((f) => f.replace(/\\/g, "/").toLowerCase()));
        if (mine.size === 0) return false;
        for (const o of others) {
            for (const f of (o.files || [])) {
                if (mine.has(f.replace(/\\/g, "/").toLowerCase())) return true;
            }
        }
        return false;
    }

    pickBatch(project) {
        const units = this.runnables(project);
        if (!units.length) return { model: null, batch: [] };

        const a = this.config.assignment || {};
        const byModel = new Map();
        for (const u of units) {
            if (!byModel.has(u.model)) byModel.set(u.model, []);
            byModel.get(u.model).push(u);
        }

        let model = null;
        // (a) bonsai-first, but only once a real batch exists - its per-task
        //     latency is poor, so it only wins on width. minBatch is measured.
        if (a.preferParallel) {
            const par = a.parallelModel || "bonsai";
            const group = byModel.get(par) || [];
            if (group.length >= (a.minBatch || 3)) model = par;
        }
        // (b) prefer whatever is already loaded - avoids a 30 s swap
        if (!model && this.slot.loaded && byModel.has(this.slot.loaded)) model = this.slot.loaded;
        // (c) otherwise whatever the first unit wants - review runs sort first
        if (!model) model = units[0].model;

        const width = (this.config.models[model] || {}).parallel || 1;
        const picked = [];
        for (const u of (byModel.get(model) || [])) {
            if (picked.length >= width) break;
            if (this.conflicts(u.task, picked.map((p) => p.task))) continue;
            picked.push(u);
        }
        return { model, batch: picked };
    }

    tick() {
        if (this.ticking) return;
        this.ticking = true;
        Promise.resolve()
            .then(() => this.tickInner())
            .catch((e) => { this.note = `error: ${e.message}`; })
            .finally(() => { this.ticking = false; this.emit("changed"); });
    }

    async tickInner() {
        if (this.paused) { this.note = "paused"; return; }

        const project = this.registry.active();
        if (!project) { this.note = "no active project"; return; }

        // While work is in flight, only top up the SAME model, and only with
        // tasks that do not touch a running task's files.
        if (this.running.size > 0) {
            const model = [...this.running.values()][0].model;
            const width = (this.config.models[model] || {}).parallel || 1;
            const room = width - this.running.size;
            this.note = `running ${this.running.size} of ${width} on ${model}`;
            if (room <= 0) return;
            const inFlight = [...this.running.values()].map((r) => r.task);
            const added = [];
            for (const u of this.runnables(project)) {
                if (added.length >= room) break;
                if (u.model !== model) continue;
                if (this.running.has(u.task.id)) continue;
                if (this.conflicts(u.task, inFlight)) continue;
                this.dispatch(project, u, model);
                inFlight.push(u.task);
                added.push(`${u.task.id}${u.kind === "review" ? " (verify)" : ""}`);
            }
            // A freed slot being refilled is the interesting moment in a 4-wide
            // run, so say it rather than leaving the console silent.
            if (added.length) this.emit("topup", { model, added, width, running: this.running.size });
            return;
        }

        if (this.slot.busy) { this.note = `slot held by ${this.slot.holder.kind}`; return; }

        const { model, batch } = this.pickBatch(project);
        if (!batch.length) { this.note = "idle"; return; }

        // Take the slot BEFORE loading, not after. Loading a model while not
        // holding the slot is a race with a real cost: the planner can acquire
        // during this await and load a different model, and then both sides
        // believe they own the GPU - which is the load/unload thrash.
        if (!this.slot.acquire("worker", `${project.slug}:batch`)) {
            this.note = `slot taken by ${this.slot.holder.kind}`;
            return;
        }

        const width = (this.config.models[model] || {}).parallel || 1;
        // Compare by id, not by object: pickBatch built its units from its own
        // runnables() call, so identity never matches and the task being
        // dispatched would be counted as still queued.
        const picked = new Set(batch.map((u) => u.task.id));
        const queued = this.runnables(project)
            .filter((u) => u.model === model && !picked.has(u.task.id)).length;
        this.emit("batch", {
            model, width, queued,
            ids: batch.map((u) => `${u.task.id}${u.kind === "review" ? " (verify)" : ""}`),
        });

        this.note = `loading ${model} for ${batch.map((u) => u.task.id).join(", ")}`;
        this.emit("changed");
        const ok = await this.slot.ensure(model);
        if (!ok) {
            // Busy or transient - next tick retries. Not an error. Hand the slot
            // back or nothing else can run either.
            this.slot.release();
            this.note = `load ${model} deferred, retrying`;
            return;
        }

        this.note = `dispatching ${batch.length} on ${model}`;
        for (const u of batch) this.dispatch(project, u, model);
    }

    dispatch(project, unit, model) {
        const { task, kind } = unit;
        if (kind === "review") {
            // Testing means "verification is running", not "queued for it" -
            // Review is the queue, Testing is the run.
            task.status = "testing";
            task.reviewer = model;
            task.reviewedAt = Date.now();
        } else {
            task.status = "running";
            task.assignee = model;
            task.startedAt = Date.now();
            task.attempts = (task.attempts || 0) + 1;
        }
        project.writeTask(task);

        // The slot is already held by tickInner (or by the batch this is topping
        // up), so this is a no-op unless something went badly wrong - in which
        // case claiming it here is still the right thing.
        if (!this.slot.busy) this.slot.acquire("worker", `${project.slug}:${task.id}`);

        const child = this.runner(project, task, kind, (outcome) => {
            this.finish(project, task, kind, outcome);
        });
        this.running.set(task.id, { project, task, child, kind, model });
        this.emit("changed");
    }

    finish(project, task, kind, outcome) {
        this.running.delete(task.id);
        task.endedAt = Date.now();
        task.sections = task.sections || {};

        if (outcome.cancelled) {
            // Cancelling means "stop, I want to look at this" - so the card is
            // PARKED, not requeued. Putting it back to `ready` made the scheduler
            // re-dispatch it on the very next tick, which read as the Cancel
            // button doing nothing. Use Re-run to send it back.
            if (outcome.output) task.sections.Result = outcome.output;
            task.status = "draft";
            task.startedAt = null;
            task.blockedReason = "cancelled by hand - press Re-run to queue it again";
        } else if (kind === "review") {
            this.finishReview(task, outcome);
        } else if (outcome.ok) {
            if (outcome.output) task.sections.Result = outcome.output;
            // Into the queue for verification by a DIFFERENT model. Nothing
            // downstream unblocks until that comes back PASS.
            task.status = "review";
        } else {
            if (outcome.output) task.sections.Result = outcome.output;
            task.status = "failed";
            task.sections.Result = (task.sections.Result || "") +
                (outcome.error ? `\n\n**Error**\n\n${outcome.error}` : "");
        }
        project.writeTask(task);

        // Only hand back a slot the workers actually hold - the planner is also a
        // holder, and releasing its slot here would let the scheduler dispatch
        // straight into a model the planner is still using.
        if (this.running.size === 0 && this.slot.holder && this.slot.holder.kind === "worker") {
            this.slot.release();
        }
        this.emit("changed");
        setImmediate(() => this.tick());
    }

    /**
     * A verification run came back. The verdict decides, not the reviewer's
     * prose - and an unreadable verdict is not a pass.
     */
    finishReview(task, outcome) {
        const v = outcome.ok
            ? tf.parseVerdict(outcome.output)
            : { ok: false, reason: outcome.error || "the verification run did not finish" };
        const who = task.reviewer || "reviewer";

        task.sections.Result = (task.sections.Result || "")
            + `\n\n**Verified by ${who}: ${v.ok ? "PASS" : "FAIL"}**\n\n${v.reason || ""}`.trimEnd();

        if (v.ok) {
            task.status = "done";
            task.blockedReason = null;
            this.emit("verdict", { id: task.id, ok: true, by: who, reason: v.reason });
            return;
        }

        task.reviewFails = (task.reviewFails || 0) + 1;
        this.emit("verdict", {
            id: task.id, ok: false, by: who, reason: v.reason, fails: task.reviewFails,
        });

        if (task.reviewFails >= MAX_REVIEW_FAILS) {
            task.status = "failed";
            task.blockedReason = `verification failed ${task.reviewFails}x - ${v.reason || "see Result"}`;
            return;
        }
        // First failure: send the work back, and tell the re-run what was wrong.
        // Re-running with the same Context would reproduce the same mistake.
        task.status = "ready";
        task.startedAt = null;
        task.sections.Context = (task.sections.Context || "")
            + `\n\n**A previous attempt failed verification (${who}):** `
            + (v.reason || "see Result");
    }

    /** Kill everything in flight. Partial output is preserved by finish(). */
    interrupt() {
        const ids = [...this.running.keys()];
        for (const { child } of this.running.values()) {
            try { child.cancel(); } catch { /* already gone */ }
        }
        return ids;
    }
}

module.exports = { ModelSlot, Scheduler, TERMINAL };
