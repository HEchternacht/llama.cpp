import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, normalizeConfig, resolveKey, saveConfig, type FreectlConfig } from "./config.ts";
import { Catalog, emptyState, errorOf, swarmKey, type CatalogState, type FreeModel } from "./catalog.ts";

const HOME = process.env.FREECTL_HOME ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(HOME, "config", "freectl.json");
const STATE_PATH = path.join(HOME, "config", "freectl-state.json");
const WEB_DIR = path.join(HOME, "web");
const cfg = loadConfig(CONFIG_PATH);

function loadState(): CatalogState {
  try {
    return { ...emptyState(), ...(JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Partial<CatalogState>) };
  } catch {
    return emptyState();
  }
}

const catalog = new Catalog(cfg, loadState(), (s) => writeFileSync(STATE_PATH, JSON.stringify(s)));

/** Ids that select the cascading fail-over model. */
const DEFAULT_IDS = new Set(["default", "freectl/default"]);
/** Ids of the cascade that runs each conversation on its own provider (parallel sub-agents). */
const SWARM_IDS = new Set(["swarm", "freectl/swarm"]);

class AttemptError extends Error {}

/** App attribution headers passed through to upstreams: OpenRouter serves some free models
 * (e.g. Inkling) only to recognised agent apps, identified by these. */
const ATTRIBUTION = ["http-referer", "x-title", "x-openrouter-title", "x-openrouter-categories"];

function attributionOf(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of ATTRIBUTION) {
    const v = req.headers[h];
    if (typeof v === "string") out[h] = v;
  }
  return out;
}

function log(msg: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function modelEntry(id: string, owner: string, ctx: number | undefined, name?: string) {
  // context_length for OpenAI-style clients, meta.n_ctx for pi-based ones (little-coder)
  return { id, object: "model", owned_by: owner, name, context_length: ctx, meta: ctx ? { n_ctx: ctx } : undefined };
}

/** Sets `model` of a JSON response object to `id`; anything else is returned unchanged. */
function relabel(json: string, id: string): string {
  try {
    const obj = JSON.parse(json) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return JSON.stringify({ ...obj, model: id });
  } catch {
    /* not JSON */
  }
  return json;
}

/**
 * One upstream try. Resolves once the response is known to be good and has been
 * (or, for streams, is being) relayed to the client; throws AttemptError when the
 * next model may be tried instead, i.e. before any byte reached the client.
 */
async function attempt(m: FreeModel, body: Record<string, unknown>, endpoint: string, res: http.ServerResponse, extra: Record<string, string>): Promise<void> {
  const ctrl = new AbortController();
  // a client that hangs up aborts the upstream request ("close" on req fires once the body is read)
  const onClose = () => {
    if (!res.writableFinished) ctrl.abort();
  };
  res.on("close", onClose);
  const timer = setTimeout(() => ctrl.abort(new AttemptError("first byte timeout")), cfg.first_byte_timeout_seconds * 1000);
  const t0 = Date.now();
  catalog.track(m.provider.name, 1);
  try {
    let up: Response;
    try {
      up = await fetch(`${m.provider.baseUrl}${endpoint}`, {
        method: "POST",
        headers: { ...extra, "content-type": "application/json", authorization: `Bearer ${resolveKey(m.provider.apiKey)}` },
        body: JSON.stringify({ ...body, model: m.upstream }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new AttemptError(ctrl.signal.reason instanceof AttemptError ? ctrl.signal.reason.message : String(e));
    }
    if (!up.ok || !up.body) {
      const text = await up.text().catch(() => "");
      throw new AttemptError(`HTTP ${up.status} ${errorOf(text) ?? text.slice(0, 300)}`);
    }

    const streamed = (up.headers.get("content-type") ?? "").includes("text/event-stream");
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let head = "";
    // hold the response back until its first event (or the whole JSON body) shows it is not an error
    for (;;) {
      const { done, value } = await reader.read().catch((e) => {
        throw new AttemptError(String(e));
      });
      if (value) head += dec.decode(value, { stream: true });
      if (done) break;
      if (streamed && /^data:.*\n/m.test(head)) break;
    }
    clearTimeout(timer);
    const first = streamed ? (head.match(/^data:(.*)$/m)?.[1] ?? "").trim() : head;
    const err = errorOf(first) ?? (head.trim() === "" ? "empty response" : undefined);
    if (err) throw new AttemptError(err);

    catalog.report(m.id, true, Date.now() - t0, undefined, JSON.stringify(body).length);
    res.writeHead(200, {
      "content-type": up.headers.get("content-type") ?? "application/json",
      "cache-control": "no-cache",
      "x-freectl-model": m.id,
    });
    // the `model` field names the model that answered (pi shows it as the message's responseModel)
    if (!streamed) {
      res.end(relabel(head, m.id));
      return;
    }
    let pending = head;
    const flush = (final: boolean) => {
      const cut = final ? pending.length : pending.lastIndexOf("\n") + 1;
      if (cut > 0) res.write(pending.slice(0, cut).replace(/^data: ?(\{.*\})(\r?)$/gm, (_, j: string, cr: string) => `data: ${relabel(j, m.id)}${cr}`));
      pending = pending.slice(cut);
    };
    flush(false);
    for (;;) {
      // past this point a failure can only end the response: bytes already went out
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (value) pending += dec.decode(value, { stream: true });
      if (done) break;
      flush(false);
    }
    pending += dec.decode();
    flush(true);
    res.end();
  } finally {
    catalog.track(m.provider.name, -1);
    clearTimeout(timer);
    res.off("close", onClose);
  }
}

async function handleCompletion(req: http.IncomingMessage, res: http.ServerResponse, endpoint: string): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, { error: { message: "invalid JSON body" } });
  }
  const want = String(body.model ?? "default");
  const isSwarm = SWARM_IDS.has(want);
  const isDefault = DEFAULT_IDS.has(want) || isSwarm;
  const key = isSwarm ? swarmKey(body) : "";
  const order = isSwarm ? catalog.swarmOrder(key) : undefined;
  const single = isDefault ? undefined : catalog.find(want);
  if (!isDefault && !single) return sendJson(res, 404, { error: { message: `unknown model "${want}" — see GET /v1/models` } });

  // the next model is picked at every step, so a fall-back sees the providers' current load
  const tried = new Set<string>();
  const extra = attributionOf(req);
  // agent-only models are skipped for callers that don't identify as an app
  // models that already rejected a request this big are skipped (no cooldown: smaller ones still fit)
  const chars = JSON.stringify(body).length;
  const usable = (m: FreeModel) =>
    !tried.has(m.id) && !catalog.tooBig(m.id, chars) && (Object.keys(extra).length > 0 || !catalog.health.get(m.id)?.agentOnly);
  const next = (): FreeModel | undefined =>
    isDefault ? (tried.size < cfg.max_attempts ? pick(order ?? catalog.cascade(Infinity)) : undefined) : tried.size ? undefined : single;
  // ready models first; cooling ones only as a last resort
  function pick(list: FreeModel[]) {
    return list.find((m) => usable(m) && catalog.ready(m.id)) ?? list.find(usable);
  }
  const failures: string[] = [];
  for (let m = next(); m; m = next()) {
    tried.add(m.id);
    if (res.destroyed) return;
    try {
      await attempt(m, body, endpoint, res, extra);
      if (isSwarm) catalog.swarmAssign(key, m.provider.name);
      log(`${want} -> ${m.id} ok${failures.length ? ` after ${failures.length} fall-back(s)` : ""}`);
      return;
    } catch (e) {
      if (!(e instanceof AttemptError)) throw e;
      catalog.report(m.id, false, 0, e.message, chars);
      failures.push(`${m.id}: ${e.message}`);
      log(`${want} -> ${m.id} failed: ${e.message.slice(0, 200)}`);
    }
  }
  sendJson(res, 502, { error: { message: `all ${tried.size} model(s) failed`, attempts: failures } });
}

function status() {
  const now = Date.now();
  return {
    refreshedAt: new Date(catalog.refreshedAt).toISOString(),
    checkedAt: catalog.state.checkedAt ? new Date(catalog.state.checkedAt).toISOString() : undefined,
    paid: Object.entries(catalog.state.paid).map(([id, p]) => ({ id, ...p })),
    changes: catalog.state.changes.slice(0, 50),
    providerErrors: Object.fromEntries(catalog.errors),
    swarmLoad: catalog.swarmLoad(),
    providers: cfg.providers.map((p) => ({
      name: p.name,
      enabled: p.enabled !== false,
      models: catalog.models.filter((m) => m.provider.name === p.name).length,
      skipped: catalog.skipped.get(p.name) ?? [],
      error: catalog.errors.get(p.name),
    })),
    cascade: catalog.cascade().map((m) => m.id),
    models: catalog.models.map((m) => {
      const h = catalog.health.get(m.id);
      return {
        id: m.id,
        score: Number(m.score.toFixed(2)),
        paramsB: m.paramsB,
        contextLength: m.contextLength,
        ok: h?.ok ?? 0,
        failed: h?.failed ?? 0,
        coolingDownSeconds: h && h.cooldownUntil > now ? Math.round((h.cooldownUntil - now) / 1000) : 0,
        lastLatencyMs: h?.lastLatencyMs,
        lastError: h?.lastError,
        lastOk: h?.lastOk,
        agentOnly: h?.agentOnly ?? false,
        name: m.name,
        provider: m.provider.name,
        prioritized: cfg.priority.includes(m.id) || cfg.priority.includes(m.upstream),
        inDefault: !cfg.cascade_exclude.includes(m.id) && !cfg.cascade_exclude.includes(m.upstream),
      };
    }),
  };
}

/** Literal keys go to the UI masked; a masked key sent back means "unchanged". */
function maskKey(k: string): string {
  return k.startsWith("env:") ? k : k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : "…";
}

function publicConfig(): FreectlConfig {
  return { ...cfg, providers: cfg.providers.map((p) => ({ ...p, apiKey: maskKey(p.apiKey) })) };
}

async function updateConfig(raw: Partial<FreectlConfig>): Promise<void> {
  for (const p of raw.providers ?? []) {
    const old = cfg.providers.find((q) => q.name === p.name);
    // a masked key means "unchanged"; so does any non-latin1 text (a mangled mask can't be a valid header)
    if (old && (p.apiKey === maskKey(old.apiKey) || /[^\x00-\xff]/.test(p.apiKey))) p.apiKey = old.apiKey;
  }
  const next = normalizeConfig(raw);
  saveConfig(CONFIG_PATH, next);
  // the catalog holds this same object; port / refresh_minutes apply on restart
  Object.assign(cfg, next);
  await catalog.refresh();
}

/** One short completion against a single model, for the UI's Test button. */
async function testModel(id: string) {
  const m = catalog.find(id);
  return m ? catalog.test(m) : { ok: false, error: "unknown model" };
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

async function serveStatic(res: http.ServerResponse, rel: string): Promise<void> {
  const file = path.join(WEB_DIR, path.normalize(rel || "index.html"));
  if (!file.startsWith(WEB_DIR)) return sendJson(res, 403, { error: { message: "forbidden" } });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: { message: "not found" } });
  }
}

function handleJson(req: http.IncomingMessage, res: http.ServerResponse, fn: (body: never) => Promise<unknown>): void {
  readBody(req)
    .then((text) => fn(JSON.parse(text || "{}") as never))
    .then((out) => sendJson(res, 200, out))
    .catch((e) => sendJson(res, 400, { error: { message: String(e instanceof Error ? e.message : e) } }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") return sendJson(res, 200, { ok: true });
  // the UI page itself is public; its API calls carry the key
  if (url.pathname === "/") {
    res.writeHead(302, { location: "/ui/" });
    return res.end();
  }
  if (req.method === "GET" && url.pathname.startsWith("/ui/")) return void serveStatic(res, url.pathname.slice(4));
  if (req.headers.authorization !== `Bearer ${cfg.api_key}`) return sendJson(res, 401, { error: { message: "unauthorized" } });

  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /v1/models") {
    return sendJson(res, 200, {
      object: "list",
      data: [
        modelEntry("default", "freectl", catalog.defaultContext(), "freectl default (cascading fall-back)"),
        modelEntry("swarm", "freectl", catalog.defaultContext(), "freectl swarm (each conversation on its own provider, cascading fall-back)"),
        ...catalog.models.map((m) => modelEntry(m.id, m.provider.name, m.contextLength, m.name)),
      ],
    });
  }
  if (route === "POST /v1/chat/completions" || route === "POST /v1/completions") {
    handleCompletion(req, res, url.pathname.slice(3)).catch((e) => {
      log(`internal error: ${e}`);
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(e) } });
      else res.end();
    });
    return;
  }
  if (route === "GET /freectl/status") return sendJson(res, 200, status());
  if (route === "POST /freectl/refresh") {
    catalog.refresh().then(() => sendJson(res, 200, status()));
    return;
  }
  if (route === "POST /freectl/check") {
    catalog.check().then(() => sendJson(res, 200, status()));
    return;
  }
  if (route === "GET /freectl/config") return sendJson(res, 200, publicConfig());
  if (route === "PUT /freectl/config") return handleJson(req, res, async (body: Partial<FreectlConfig>) => (await updateConfig(body), status()));
  if (route === "POST /freectl/test") return handleJson(req, res, (body: { id: string }) => testModel(body.id));
  sendJson(res, 404, { error: { message: `no route ${route}` } });
});

await catalog.refresh();
log(`${catalog.models.length} free model(s) from ${cfg.providers.length} provider(s); cascade: ${catalog.cascade().map((m) => m.id).join(" > ")}`);
for (const [p, e] of catalog.errors) log(`provider ${p} failed to list models: ${e}`);
// re-list + re-test now and every refresh_minutes: new free models join, paid / vanished ones leave
const check = () => catalog.check().catch((e) => log(`check failed: ${e}`));
void check();
setInterval(check, cfg.refresh_minutes * 60_000);
server.listen(cfg.port, "127.0.0.1", () => log(`freectl listening on http://127.0.0.1:${cfg.port}`));
