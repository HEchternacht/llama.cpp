// Project registry. Owns the on-disk layout and is the SINGLE writer of task
// files, so agent tool calls, the UI and the fs watcher cannot race each other.
//
//   ~/.pi/agent/projects/<slug>/
//       project.md      objective + constraints
//       tasks/*.md      the source of truth
//       results/        raw worker transcripts
//
// board.json is intentionally absent: everything is derived from the .md files
// so the board can be rebuilt by deleting nothing at all.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const tf = require("./taskfile.js");

const ROOT = process.env.KANBAN_ROOT
    || path.join(os.homedir(), ".pi", "agent", "projects");

/**
 * Readable but bounded: folder name plus a hash of the full path. Encoding the
 * whole path the way pi does is fine for short paths but blows past Windows'
 * limit for deep ones, and the directory name still has to hold task files.
 */
function slugify(projectPath) {
    const full = String(projectPath);
    const base = (path.basename(full) || "project")
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .slice(0, 40);
    const hash = crypto.createHash("sha1").update(full.toLowerCase()).digest("hex").slice(0, 8);
    return `${base}-${hash}`;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

// ---------------------------------------------------------------- project ---

class Project {
    constructor(dir) {
        this.dir = dir;
        this.tasksDir = path.join(dir, "tasks");
        this.resultsDir = path.join(dir, "results");
        this.slug = path.basename(dir);
        this.tasks = new Map();      // id -> task
        this.meta = { path: "", name: this.slug, objective: "" };
        this.watcher = null;
        this.watchTimer = null;
    }

    // -- project.md ----------------------------------------------------------

    loadMeta() {
        const p = path.join(this.dir, "project.md");
        let text = "";
        try { text = fs.readFileSync(p, "utf8"); } catch { return; }
        const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
        const body = m ? m[2] : text;
        if (m) {
            for (const line of m[1].split(/\r?\n/)) {
                const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
                if (kv) this.meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
            }
        }
        const secs = tf.parseSections(body);
        this.meta.objective = (secs.Objective || "").trim();
        this.meta.constraints = (secs.Constraints || "").trim();
    }

    saveMeta() {
        const lines = [
            "---",
            `name: ${this.meta.name}`,
            `path: ${this.meta.path}`,
            `created: ${this.meta.created || new Date().toISOString()}`,
            "---",
            "",
            "## Objective",
            this.meta.objective || "",
            "",
            "## Constraints",
            this.meta.constraints || "",
            "",
        ];
        fs.writeFileSync(path.join(this.dir, "project.md"), lines.join("\n"), "utf8");
    }

    // -- tasks ---------------------------------------------------------------

    loadTasks() {
        this.tasks.clear();
        let names = [];
        try { names = fs.readdirSync(this.tasksDir); } catch { return; }
        for (const name of names) {
            if (!name.endsWith(".md")) continue;
            const full = path.join(this.tasksDir, name);
            try {
                const t = tf.parseTask(fs.readFileSync(full, "utf8"), full);
                // A file with no usable id still gets a card, keyed by filename:
                // silently dropping it would lose hand-written work with no clue
                // on the board as to why.
                if (!t.id) { t.id = `!${name}`; t.title = t.title || name; }
                this.tasks.set(t.id, t);
            } catch (e) {
                // A file we cannot even read must not take the whole board down.
                console.warn(`[kanban] failed to read ${full}: ${e.message}`);
            }
        }
        this.recompute();
    }

    nextId() {
        let max = 0;
        for (const id of this.tasks.keys()) {
            const n = Number(String(id).replace(/^T-/, ""));
            if (Number.isFinite(n) && n > max) max = n;
        }
        return `T-${String(max + 1).padStart(3, "0")}`;
    }

    fileFor(task) {
        return task.filePath
            || path.join(this.tasksDir, `${task.id}-${tf.slugifyTitle(task.title)}.md`);
    }

    writeTask(task) {
        ensureDir(this.tasksDir);
        const file = this.fileFor(task);
        task.filePath = file;
        // Single writer: mark our own write so the watcher can ignore the echo.
        this._selfWrite = (this._selfWrite || new Set());
        this._selfWrite.add(path.basename(file));
        // Write atomically. fs.writeFileSync truncates first, so the watcher can
        // read a half-written file: parseTask then sees no frontmatter and
        // defaults the card to `draft`, which silently parks work that was ready.
        // A same-directory rename is atomic, so a reader sees old or new, never half.
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, tf.serialiseTask(task), "utf8");
        fs.renameSync(tmp, file);
        this.tasks.set(task.id, task);
        this.recompute();
        return task;
    }

    deleteTask(id) {
        const t = this.tasks.get(id);
        if (!t) return false;
        try { if (t.filePath) fs.unlinkSync(t.filePath); } catch { /* already gone */ }
        this.tasks.delete(id);
        this.recompute();
        return true;
    }

    writeResult(task, runIndex, content) {
        ensureDir(this.resultsDir);
        const p = path.join(this.resultsDir, `${task.id}.run-${runIndex}.md`);
        fs.writeFileSync(p, content, "utf8");
        return p;
    }

    // -- derived state -------------------------------------------------------

    /**
     * Recompute blocked/ready. These two states are never stored by hand: they
     * are a pure function of dependsOn and complexity, so a stale file cannot
     * wedge the scheduler.
     */
    recompute(config) {
        // The scheduler's assignment config is stashed on the project by the
        // registry, so writeTask()/the watcher recompute with the same rules a
        // caller-supplied config would use.
        const cfg = config || this.config || {};
        const decomposeAbove = cfg.decomposeAbove || 7;

        const childrenOf = new Map();
        for (const t of this.tasks.values()) {
            if (t.parent) childrenOf.set(t.parent, (childrenOf.get(t.parent) || 0) + 1);
        }

        for (const t of this.tasks.values()) {
            t.blockedReason = null;
            // In-flight and terminal states are owned by the scheduler / agent.
            if (["running", "review", "testing", "done", "failed", "cancelled"].includes(t.status)) {
                continue;
            }
            // A genuine draft is awaiting human approval; leave it alone.
            if (t.status === "draft") continue;

            if (childrenOf.get(t.id)) {
                t.status = "blocked";
                t.blockedReason = "rolled up - subtasks carry the work";
                continue;
            }
            if (t.complexity != null && t.complexity > decomposeAbove) {
                t.status = "needs-decomposition";
                t.blockedReason = `complexity ${t.complexity} > ${decomposeAbove}; split into independent subtasks`;
                continue;
            }
            const missing = t.dependsOn.filter((d) => {
                const dep = this.tasks.get(d);
                return !dep || dep.status !== "done";
            });
            if (missing.length) {
                t.status = "blocked";
                t.blockedReason = `waiting on ${missing.join(", ")}`;
            } else {
                t.status = "ready";
            }
        }
        this.cycles = this.findCycles();
    }

    findCycles() {
        const state = new Map();   // 0 unvisited, 1 in-stack, 2 done
        const bad = [];
        const visit = (id, stack) => {
            const s = state.get(id) || 0;
            if (s === 1) { bad.push([...stack, id].join(" -> ")); return; }
            if (s === 2) return;
            state.set(id, 1);
            const t = this.tasks.get(id);
            for (const d of (t ? t.dependsOn : [])) visit(d, [...stack, id]);
            state.set(id, 2);
        };
        for (const id of this.tasks.keys()) visit(id, []);
        return bad;
    }

    toJSON() {
        return {
            slug: this.slug,
            meta: this.meta,
            cycles: this.cycles || [],
            tasks: [...this.tasks.values()].map((t) => ({
                id: t.id, title: t.title, status: t.status, complexity: t.complexity,
                assignee: t.assignee, taskType: t.taskType, priority: t.priority,
                parent: t.parent, dependsOn: t.dependsOn, files: t.files,
                createdBy: t.createdBy, needsTesting: t.needsTesting,
                blockedReason: t.blockedReason, attempts: t.attempts,
                startedAt: t.startedAt, endedAt: t.endedAt,
                reviewer: t.reviewer, reviewFails: t.reviewFails, reviewedAt: t.reviewedAt,
                sections: t.sections, errors: t.errors,
                filePath: t.filePath,
            })),
        };
    }

    // -- watching ------------------------------------------------------------

    /** Hand edits and agent `edit` calls converge here. Debounced; never throws. */
    watch(onChange) {
        ensureDir(this.tasksDir);
        try {
            this.watcher = fs.watch(this.tasksDir, (_event, filename) => {
                if (filename && this._selfWrite && this._selfWrite.has(filename)) {
                    this._selfWrite.delete(filename);
                    return;
                }
                clearTimeout(this.watchTimer);
                this.watchTimer = setTimeout(() => {
                    this.loadTasks();
                    onChange();
                }, 200);
            });
        } catch (e) {
            console.warn(`[kanban] cannot watch ${this.tasksDir}: ${e.message}`);
        }
    }

    close() {
        if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } }
        clearTimeout(this.watchTimer);
    }
}

// --------------------------------------------------------------- registry ---

class Registry extends EventEmitter {
    constructor(root = ROOT, config = {}) {
        super();
        this.root = root;
        this.config = config;          // assignment rules, handed to each project
        this.projects = new Map();   // slug -> Project
        this.activeSlug = null;
        ensureDir(this.root);
    }

    loadAll() {
        let names = [];
        try { names = fs.readdirSync(this.root, { withFileTypes: true }); } catch { return; }
        for (const d of names) {
            if (!d.isDirectory()) continue;
            this.open(path.join(this.root, d.name));
        }
        if (!this.activeSlug && this.projects.size) {
            this.activeSlug = [...this.projects.keys()][0];
        }
    }

    open(dir) {
        const slug = path.basename(dir);
        if (this.projects.has(slug)) return this.projects.get(slug);
        const p = new Project(dir);
        p.config = this.config;
        p.loadMeta();
        p.loadTasks();
        p.watch(() => this.emit("changed", p.slug));
        this.projects.set(slug, p);
        return p;
    }

    create(projectPath, objective, name) {
        const resolved = path.resolve(projectPath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            throw new Error(`not a directory: ${resolved}`);
        }
        const slug = slugify(resolved);
        const dir = path.join(this.root, slug);
        ensureDir(path.join(dir, "tasks"));
        ensureDir(path.join(dir, "results"));
        const p = this.projects.get(slug) || new Project(dir);
        p.config = this.config;
        p.meta = {
            name: name || path.basename(resolved) || slug,
            path: resolved,
            objective: objective || "",
            created: new Date().toISOString(),
        };
        p.saveMeta();
        p.loadTasks();
        if (!this.projects.has(slug)) {
            p.watch(() => this.emit("changed", slug));
            this.projects.set(slug, p);
        }
        if (!this.activeSlug) this.activeSlug = slug;
        return p;
    }

    get(slug) { return this.projects.get(slug); }
    active() { return this.activeSlug ? this.projects.get(this.activeSlug) : null; }
    setActive(slug) {
        if (!this.projects.has(slug)) throw new Error(`no such project: ${slug}`);
        this.activeSlug = slug;
    }

    list() {
        return [...this.projects.values()].map((p) => ({
            slug: p.slug,
            name: p.meta.name,
            path: p.meta.path,
            active: p.slug === this.activeSlug,
            counts: countByStatus(p),
        }));
    }

    /**
     * Drop projects whose directory has gone. Without this, deleting a project
     * folder from the shell leaves a card on the board that can never be opened.
     * Returns the slugs that were removed.
     */
    prune() {
        const gone = [];
        for (const [slug, p] of this.projects) {
            if (fs.existsSync(p.dir)) continue;
            p.close();
            this.projects.delete(slug);
            gone.push(slug);
            if (this.activeSlug === slug) {
                this.activeSlug = this.projects.size ? [...this.projects.keys()][0] : null;
            }
        }
        return gone;
    }

    closeAll() { for (const p of this.projects.values()) p.close(); }
}

function countByStatus(p) {
    const out = {};
    for (const t of p.tasks.values()) out[t.status] = (out[t.status] || 0) + 1;
    return out;
}

module.exports = { Registry, Project, slugify, ROOT };
