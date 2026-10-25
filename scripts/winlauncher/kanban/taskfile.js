// Task files are the source of truth. This module is the only place that knows
// their on-disk shape: YAML-ish frontmatter + "## Section" markdown bodies.
//
// The parser deliberately supports a small, fixed subset of YAML rather than
// pulling in a dependency: scalars, quoted strings, inline lists ([a, b]) and
// block lists ("- item"). Anything else is preserved verbatim on rewrite so a
// hand-edited file never silently loses content.

"use strict";

// "draft" means awaiting human approval. "needs-decomposition" is the separate,
// machine-set hold for a task scoring above the complexity threshold - keeping
// them distinct is what lets an auto-held task become runnable again once it
// gains subtasks, while a genuine draft stays put until approved.
const STATUSES = [
    "draft", "needs-decomposition", "blocked", "ready", "running",
    "review", "testing", "done", "failed", "cancelled",
];

// Frontmatter keys we understand. Order here is the order written back out, so
// hand-edited files converge on a stable layout instead of churning in git.
const SCALAR_KEYS = [
    "id", "title", "status", "complexity", "assignee", "taskType",
    "priority", "parent", "createdBy", "needsTesting", "blockedReason",
    "attempts", "startedAt", "endedAt",
    // Verification: which model checked the work (never the one that did it),
    // and how many times it came back FAIL.
    "reviewer", "reviewFails", "reviewedAt",
];
const LIST_KEYS = ["dependsOn", "files"];

const SECTION_ORDER = ["Description", "Context", "Acceptance", "Result"];

// ------------------------------------------------------------------ parse ---

function stripQuotes(v) {
    const s = v.trim();
    if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
        return s.slice(1, -1);
    }
    return s;
}

function coerce(key, raw) {
    const v = stripQuotes(raw);
    if (v === "" || v === "null" || v === "~") return null;
    if (["complexity", "priority", "attempts", "startedAt", "endedAt",
        "reviewFails", "reviewedAt"].includes(key)) {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    if (key === "needsTesting") return v === "true" || v === "yes";
    return v;
}

function parseInlineList(raw) {
    const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
    if (!inner) return [];
    return inner.split(",").map((s) => stripQuotes(s)).filter(Boolean);
}

/**
 * Parse a task file. Never throws on bad input - problems are collected into
 * `errors` so the board can flag the card instead of crashing the watcher.
 */
function parseTask(text, filePath) {
    const errors = [];
    const fm = {};
    const unknown = {};   // preserved verbatim
    let body = text;

    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!m) {
        errors.push("missing frontmatter");
    } else {
        body = m[2];
        const lines = m[1].split(/\r?\n/);
        let listKey = null;
        for (const line of lines) {
            if (!line.trim() || line.trim().startsWith("#")) continue;

            const item = /^\s*-\s+(.*)$/.exec(line);
            if (item && listKey) {
                const val = stripQuotes(item[1].replace(/\s+#.*$/, ""));
                if (val) fm[listKey].push(val);
                continue;
            }

            const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
            if (!kv) { errors.push(`unparsed frontmatter line: ${line.trim()}`); continue; }
            const [, key, rest] = kv;
            listKey = null;

            if (LIST_KEYS.includes(key)) {
                const r = rest.replace(/\s+#.*$/, "").trim();
                if (r.startsWith("[")) fm[key] = parseInlineList(r);
                else if (r === "" || r === "null") { fm[key] = []; listKey = key; }
                else fm[key] = [stripQuotes(r)];
                continue;
            }

            if (SCALAR_KEYS.includes(key)) {
                fm[key] = coerce(key, rest.replace(/\s+#.*$/, ""));
            } else {
                unknown[key] = rest.trim();
            }
        }
    }

    const sections = parseSections(body);

    const task = {
        id: fm.id || null,
        title: fm.title || "",
        status: fm.status || "draft",
        complexity: fm.complexity == null ? null : fm.complexity,
        assignee: fm.assignee || null,
        taskType: fm.taskType || null,
        priority: fm.priority == null ? 100 : fm.priority,
        parent: fm.parent || null,
        dependsOn: fm.dependsOn || [],
        files: fm.files || [],
        createdBy: fm.createdBy || "user",
        needsTesting: fm.needsTesting === true,
        blockedReason: fm.blockedReason || null,
        attempts: fm.attempts || 0,
        startedAt: fm.startedAt || null,
        endedAt: fm.endedAt || null,
        reviewer: fm.reviewer || null,
        reviewFails: fm.reviewFails || 0,
        reviewedAt: fm.reviewedAt || null,
        sections,
        unknown,
        filePath,
        errors,
    };

    validate(task);
    return task;
}

function validate(t) {
    if (!t.id) t.errors.push("missing id");
    else if (!/^T-\d{3,}$/.test(t.id)) t.errors.push(`bad id "${t.id}" (expected T-001 form)`);
    if (!t.title) t.errors.push("missing title");
    if (!STATUSES.includes(t.status)) t.errors.push(`unknown status "${t.status}"`);
    if (t.complexity != null && (t.complexity < 1 || t.complexity > 10)) {
        t.errors.push(`complexity ${t.complexity} out of range 1..10`);
    }
    if (t.dependsOn.includes(t.id)) t.errors.push("task depends on itself");
}

function parseSections(body) {
    const out = {};
    const re = /^##\s+(.+?)\s*$/gm;
    const marks = [];
    let m;
    while ((m = re.exec(body)) !== null) marks.push({ name: m[1], start: m.index, after: re.lastIndex });
    for (let i = 0; i < marks.length; i++) {
        const end = i + 1 < marks.length ? marks[i + 1].start : body.length;
        out[marks[i].name] = body.slice(marks[i].after, end).replace(/^\r?\n/, "").trimEnd();
    }
    return out;
}

// -------------------------------------------------------------- serialise ---

function yamlScalar(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean" || typeof v === "number") return String(v);
    const s = String(v);
    // Quote only when the value could otherwise be misread.
    if (s === "" || /^[\s]|[\s]$|[:#]|^[-[\]{}]|^(true|false|null|yes|no)$/i.test(s)) {
        return JSON.stringify(s);
    }
    return s;
}

function serialiseTask(t) {
    const lines = ["---"];
    for (const k of SCALAR_KEYS) {
        if (t[k] === undefined) continue;
        if (k === "blockedReason" && !t[k]) continue;
        if (["attempts", "startedAt", "endedAt", "reviewer", "reviewFails", "reviewedAt"]
            .includes(k) && !t[k]) continue;
        lines.push(`${k}: ${yamlScalar(t[k])}`);
    }
    for (const k of LIST_KEYS) {
        const arr = t[k] || [];
        if (arr.length === 0) { lines.push(`${k}: []`); continue; }
        lines.push(`${k}:`);
        for (const item of arr) lines.push(`  - ${yamlScalar(item)}`);
    }
    for (const [k, v] of Object.entries(t.unknown || {})) lines.push(`${k}: ${v}`);
    lines.push("---", "");

    const names = [...SECTION_ORDER];
    for (const n of Object.keys(t.sections || {})) if (!names.includes(n)) names.push(n);
    for (const n of names) {
        const v = (t.sections || {})[n];
        if (v === undefined) continue;
        lines.push(`## ${n}`, v, "");
    }
    return lines.join("\n").replace(/\n{3,}$/, "\n");
}

// ------------------------------------------------------------ worker view ---

/**
 * The prompt handed to a worker. This IS the card, minus bookkeeping - keeping
 * one rendering path means the card you read is the task that ran.
 */
function renderWorkerPrompt(t, project) {
    const out = [];
    out.push(`# Task ${t.id}: ${t.title}`, "");
    if (project && project.objective) {
        out.push("## Project objective", project.objective.trim(), "");
    }
    for (const name of ["Description", "Context", "Acceptance"]) {
        const v = (t.sections || {})[name];
        if (v && v.trim()) out.push(`## ${name}`, v.trim(), "");
    }
    if (t.files && t.files.length) {
        out.push("## Files you may change", ...t.files.map((f) => `- ${f}`), "");
        out.push(
            "Do not modify files outside this list - other tasks may be running",
            "against them at the same time.", "",
        );
    }
    out.push(
        "## How to report",
        "Work only on this task. When finished, state briefly what you changed and",
        "anything the next task needs to know. If you could not complete it, say so",
        "plainly and explain why rather than guessing.",
    );
    return out.join("\n");
}

/**
 * The prompt for a review run. Deliberately a separate clean-context worker on
 * a DIFFERENT model than the one that did the work: an agent asked to check its
 * own output tends to agree with itself, and it cannot see the bug it just
 * wrote. The reviewer gets the acceptance criteria and the claim, and is asked
 * to verify by running things rather than by reading.
 */
function renderReviewPrompt(t, project, ranOn) {
    const out = [];
    out.push(`# Verify task ${t.id}: ${t.title}`, "");
    if (project && project.objective) {
        out.push("## Project objective", project.objective.trim(), "");
    }
    for (const name of ["Description", "Acceptance"]) {
        const v = (t.sections || {})[name];
        if (v && v.trim()) out.push(`## ${name}`, v.trim(), "");
    }
    out.push(`## What ${ranOn || "another agent"} claims it did`,
        ((t.sections || {}).Result || "(it reported nothing)").trim(), "");
    if (t.files && t.files.length) {
        out.push("## Files it was allowed to touch", ...t.files.map((f) => `- ${f}`), "");
    }
    out.push(
        "## Your job",
        "You did NOT do this work and you have no reason to trust the claim above.",
        "Check it: read what actually changed, then RUN something - the test suite,",
        "a build, or a smoke test you write yourself. Prefer evidence over reading.",
        "",
        "Do not fix anything. Do not extend the work. Only verify it.",
        "",
        "Finish with a single line, exactly one of:",
        "",
        "VERDICT: PASS - <one line on what you ran and what you saw>",
        "VERDICT: FAIL - <one line on what is wrong>",
        "",
        "If you could not verify it at all, that is a FAIL - say what stopped you.",
    );
    return out.join("\n");
}

/** PASS unless it says otherwise: an unparseable verdict is not a pass. */
function parseVerdict(text) {
    const m = String(text || "").match(/VERDICT:\s*(PASS|FAIL)\b[ \t-]*(.*)/i);
    if (!m) return { ok: false, reason: "no verdict line in the reviewer's output" };
    return { ok: m[1].toUpperCase() === "PASS", reason: (m[2] || "").trim() };
}

function makeTask(fields) {
    return {
        id: fields.id,
        title: fields.title || "",
        status: fields.status || "draft",
        complexity: fields.complexity == null ? null : fields.complexity,
        assignee: fields.assignee || null,
        taskType: fields.taskType || null,
        priority: fields.priority == null ? 100 : fields.priority,
        parent: fields.parent || null,
        dependsOn: fields.dependsOn || [],
        files: fields.files || [],
        createdBy: fields.createdBy || "user",
        needsTesting: fields.needsTesting === true,
        blockedReason: null,
        attempts: 0,
        startedAt: null,
        endedAt: null,
        sections: Object.assign(
            { Description: "", Context: "", Acceptance: "", Result: "" },
            fields.sections || {},
        ),
        unknown: {},
        filePath: fields.filePath || null,
        errors: [],
    };
}

function slugifyTitle(title) {
    return String(title || "task")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "task";
}

module.exports = {
    STATUSES, SECTION_ORDER,
    parseTask, serialiseTask, renderWorkerPrompt, renderReviewPrompt, parseVerdict,
    makeTask, slugifyTitle, parseSections,
};
