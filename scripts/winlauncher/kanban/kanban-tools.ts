/**
 * Kanban tools for the planning agent.
 *
 * Loaded ONLY with `--extension` when the board spawns its planner child, never
 * from settings.json - the board is a mode, and stock pi must be unaffected by
 * its existence.
 *
 * The tools do not touch task files directly. They call the board's HTTP API,
 * which is the single writer, so planner edits, hand edits and the scheduler can
 * never race each other over the same .md file.
 *
 * Configured through the environment the board sets on the child:
 *   KANBAN_URL      board base url, e.g. http://127.0.0.1:8090
 *   KANBAN_PROJECT  slug of the project being planned
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BOARD = process.env.KANBAN_URL || "http://127.0.0.1:8090";
const PROJECT = process.env.KANBAN_PROJECT || "";

const base = () => `${BOARD}/api/projects/${encodeURIComponent(PROJECT)}`;

async function call(method: string, url: string, body?: unknown) {
	const res = await fetch(url, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = { raw: text };
	}
	if (!res.ok) {
		throw new Error(parsed?.error || `${method} ${url} -> ${res.status}`);
	}
	return parsed;
}

const ok = (text: string, details?: unknown) => ({
	content: [{ type: "text" as const, text }],
	details: details ?? {},
});

// A task as the planner describes it. Ids are allocated by the board, so the
// planner uses `ref` to wire up dependencies inside one call.
const TASK = Type.Object({
	ref: Type.String({
		description: "Your own short label for this task (e.g. \"a\"), used only to express dependsOn within this call.",
	}),
	title: Type.String({ description: "One line, imperative. e.g. \"Add retry to the fetch layer\"" }),
	description: Type.String({
		description: "What must be done, written for a worker with NO prior context and no access to this conversation.",
	}),
	context: Type.String({
		description: "Everything needed to do it without asking: decisions already made, constraints, findings from earlier tasks.",
	}),
	acceptance: Type.String({ description: "How we know it is done." }),
	complexity: Type.Number({
		description: "1-10. 1-3 trivial, 4-6 moderate, 7 hard. 8+ is REFUSED - split it into smaller independent tasks instead.",
	}),
	taskType: Type.String({ description: "code, refactor, test, debug, research, plan, review, summarize, extract" }),
	files: Type.Array(Type.String(), {
		description: "Repo-relative files this task may change. Tasks sharing a file never run in parallel, so keep sets disjoint.",
	}),
	dependsOn: Type.Array(Type.String(), {
		description: "refs of tasks in this same call, or existing ids like T-002, that must be done first.",
	}),
	priority: Type.Optional(Type.Number({ description: "Lower runs sooner. Default 100." })),
	needsTesting: Type.Optional(Type.Boolean({ description: "Send to Testing rather than straight to Review." })),
});

export default function kanbanTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "kanban_get_board",
		label: "Get board",
		description:
			"List every task on this project's board with its status, complexity, dependencies and a short result summary. Call this before planning or updating so you are working from the real state.",
		promptSnippet: "Read the current kanban board for this project",
		parameters: Type.Object({}),
		async execute() {
			const b = await call("GET", `${base()}/board`);
			const lines: string[] = [];
			lines.push(`objective: ${b.objective || "(none)"}`);
			if (b.constraints) lines.push(`constraints: ${b.constraints}`);
			if (b.cycles?.length) lines.push(`WARNING dependency cycles: ${b.cycles.join(" | ")}`);
			if (!b.tasks.length) lines.push("(no tasks yet)");
			for (const t of b.tasks) {
				lines.push(
					`${t.id} [${t.status}] cx=${t.complexity ?? "-"} type=${t.taskType ?? "-"} ` +
						`model=${t.assignee ?? "auto"} deps=[${(t.dependsOn || []).join(",")}] ` +
						`files=[${(t.files || []).join(",")}]\n    ${t.title}` +
						(t.blockedReason ? `\n    blocked: ${t.blockedReason}` : "") +
						(t.resultSummary ? `\n    result: ${t.resultSummary}` : ""),
				);
			}
			return ok(lines.join("\n"), { count: b.tasks.length });
		},
	});

	pi.registerTool({
		name: "kanban_create_tasks",
		label: "Create tasks",
		description:
			"Create one or more task cards on the board. Ids are assigned for you and returned. Prefer several small independent tasks over one large one: anything you would score 8 or higher must be split first.",
		promptSnippet: "Create kanban task cards",
		promptGuidelines: [
			"Every task must be doable by a worker that sees ONLY its own card - no shared conversation.",
			"Keep complexity at 7 or below. Score 8+ is refused by the board.",
			"Tasks meant to run at the same time must not list the same file.",
			"Put real content in context: a worker cannot ask you questions.",
			"Never mention a ref (\"task a\") in description/context/acceptance prose - refs do not exist outside this call. Name the file or the real task id instead.",
		],
		parameters: Type.Object({ tasks: Type.Array(TASK) }),
		async execute(_id, params: any) {
			const tooBig = (params.tasks || []).filter((t: any) => t.complexity >= 8);
			if (tooBig.length) {
				return ok(
					`Refused. These score 8+ and must be decomposed into smaller independent tasks first: ` +
						tooBig.map((t: any) => `${t.ref} (${t.complexity})`).join(", "),
					{ refused: true },
				);
			}
			const r = await call("POST", `${base()}/tasks/bulk`, { tasks: params.tasks });
			const made = r.created.map((c: any) => `${c.id} ${c.title}`).join("\n");
			return ok(
				`Created ${r.created.length} task(s):\n${made}` +
					(r.cycles?.length ? `\nWARNING cycles: ${r.cycles.join(" | ")}` : ""),
				r,
			);
		},
	});

	pi.registerTool({
		name: "kanban_update_task",
		label: "Update task",
		description:
			"Change fields or sections of an existing task. Use this to re-scope work, fix a dependency, raise complexity after a failure, or rewrite the Context of a task whose assumptions an earlier result invalidated.",
		promptSnippet: "Update a kanban task card",
		parameters: Type.Object({
			id: Type.String({ description: "Task id, e.g. T-002" }),
			title: Type.Optional(Type.String()),
			complexity: Type.Optional(Type.Number({ description: "1-10" })),
			taskType: Type.Optional(Type.String()),
			assignee: Type.Optional(Type.String({ description: "kat, bigbang or bonsai. Omit to let complexity decide." })),
			priority: Type.Optional(Type.Number()),
			dependsOn: Type.Optional(Type.Array(Type.String())),
			files: Type.Optional(Type.Array(Type.String())),
			description: Type.Optional(Type.String()),
			context: Type.Optional(Type.String({ description: "Replaces the Context section wholesale." })),
			acceptance: Type.Optional(Type.String()),
		}),
		async execute(_id, p: any) {
			const body: any = { createdBy: "planner" };
			for (const k of ["title", "complexity", "taskType", "assignee", "priority", "dependsOn", "files"]) {
				if (p[k] !== undefined) body[k] = p[k];
			}
			const sections: any = {};
			if (p.description !== undefined) sections.Description = p.description;
			if (p.context !== undefined) sections.Context = p.context;
			if (p.acceptance !== undefined) sections.Acceptance = p.acceptance;
			if (Object.keys(sections).length) body.sections = sections;
			await call("PATCH", `${base()}/tasks/${encodeURIComponent(p.id)}`, body);
			return ok(`Updated ${p.id}.`);
		},
	});

	pi.registerTool({
		name: "kanban_set_status",
		label: "Set task status",
		description:
			"Move a task. After reading a finished worker's output, send it to \"testing\" if it needs verifying, \"done\" if it does not, or back to \"ready\" to run again.",
		promptSnippet: "Move a kanban task to another column",
		parameters: Type.Object({
			id: Type.String(),
			status: Type.String({ description: "draft, ready, testing, done or cancelled" }),
			note: Type.Optional(Type.String({ description: "Why - appended to the card's Result." })),
		}),
		async execute(_id, p: any) {
			const body: any = { status: p.status, createdBy: "planner" };
			if (p.note) body.sections = { Result: p.note };
			await call("PATCH", `${base()}/tasks/${encodeURIComponent(p.id)}`, body);
			return ok(`${p.id} -> ${p.status}`);
		},
	});

	pi.registerTool({
		name: "kanban_delete_task",
		label: "Delete task",
		description: "Delete a task card and its file. Use when a task is obsolete or was replaced by subtasks.",
		promptSnippet: "Delete a kanban task card",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, p: any) {
			await call("DELETE", `${base()}/tasks/${encodeURIComponent(p.id)}`);
			return ok(`Deleted ${p.id}.`);
		},
	});
}
