// freectl on Cloudflare Workers. The Worker serves the UI (static assets under /ui/) and hands
// every API call to one Durable Object, which holds the config (in its storage), the catalog,
// model health and in-flight counts — the same state the Node server keeps in memory.
// Auth: /v1/* takes the config's api_key, /freectl/* (the UI) takes the UI_PASSWORD secret.

import { DurableObject } from "cloudflare:workers";
import { normalizeConfig, resolveKey, type FreectlConfig } from "../../src/config.ts";
import { Catalog, emptyState, errorOf, swarmKey, type CatalogState, type FreeModel } from "../../src/catalog.ts";

interface Env {
  FREECTL: DurableObjectNamespace<Freectl>;
  ASSETS: Fetcher;
  UI_PASSWORD: string;
}

const DEFAULT_IDS = new Set(["default", "freectl/default"]);
/** Ids of the cascade that runs each conversation on its own provider (parallel sub-agents). */
const SWARM_IDS = new Set(["swarm", "freectl/swarm"]);
const ATTRIBUTION = ["http-referer", "x-title", "x-openrouter-title", "x-openrouter-categories"];

class AttemptError extends Error {}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function modelEntry(id: string, owner: string, ctx: number | undefined, name?: string) {
  return { id, object: "model", owned_by: owner, name, context_length: ctx, meta: ctx ? { n_ctx: ctx } : undefined };
}

function relabel(json: string, id: string): string {
  try {
    const obj = JSON.parse(json) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return JSON.stringify({ ...obj, model: id });
  } catch {
    /* not JSON */
  }
  return json;
}

function maskKey(k: string): string {
  return k.startsWith("env:") ? k : k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : "…";
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true });
    if (url.pathname === "/") return Response.redirect(new URL("/ui/", url).toString(), 302);
    if (req.method === "GET" && url.pathname.startsWith("/ui/")) return env.ASSETS.fetch(new Request(new URL(url.pathname.slice(3), url), req));
    return env.FREECTL.get(env.FREECTL.idFromName("main")).fetch(req);
  },
  // cron (wrangler.jsonc): re-list + re-test, so new / paid / vanished models are found without traffic
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await env.FREECTL.get(env.FREECTL.idFromName("main")).fetch("https://freectl/freectl/check", {
      method: "POST",
      headers: { authorization: `Bearer ${env.UI_PASSWORD}` },
    });
  },
};

export class Freectl extends DurableObject<Env> {
  cfg!: FreectlConfig;
  catalog!: Catalog;
  refreshing?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.cfg = normalizeConfig((await ctx.storage.get<Partial<FreectlConfig>>("config")) ?? {});
      const state = { ...emptyState(), ...(await ctx.storage.get<Partial<CatalogState>>("state")) };
      this.catalog = new Catalog(this.cfg, state, (s) => ctx.storage.put("state", s));
    });
  }

  /** Re-lists the providers when stale; the first listing after a cold start is awaited. */
  private async fresh(): Promise<void> {
    if (Date.now() - this.catalog.refreshedAt < this.cfg.refresh_minutes * 60_000) return;
    this.refreshing ??= this.catalog.refresh().finally(() => (this.refreshing = undefined));
    if (!this.catalog.refreshedAt) await this.refreshing;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    const auth = req.headers.get("authorization");
    const isUi = url.pathname.startsWith("/freectl/");
    if (auth !== `Bearer ${isUi ? this.env.UI_PASSWORD : this.cfg.api_key}` || (isUi && !this.env.UI_PASSWORD)) return json(401, { error: { message: "unauthorized" } });
    await this.fresh();

    try {
      if (route === "GET /v1/models") {
        return json(200, {
          object: "list",
          data: [
            modelEntry("default", "freectl", this.catalog.defaultContext(), "freectl default (cascading fall-back)"),
            modelEntry("swarm", "freectl", this.catalog.defaultContext(), "freectl swarm (each conversation on its own provider, cascading fall-back)"),
            ...this.catalog.models.map((m) => modelEntry(m.id, m.provider.name, m.contextLength, m.name)),
          ],
        });
      }
      if (route === "POST /v1/chat/completions" || route === "POST /v1/completions") return await this.handleCompletion(req, url.pathname.slice(3));
      if (route === "GET /freectl/status") return json(200, this.status());
      if (route === "POST /freectl/refresh") return (await this.catalog.refresh(), json(200, this.status()));
      if (route === "POST /freectl/check") return (await this.catalog.check(), json(200, this.status()));
      if (route === "GET /freectl/config") return json(200, this.publicConfig());
      if (route === "PUT /freectl/config") return (await this.updateConfig((await req.json()) as Partial<FreectlConfig>), json(200, this.status()));
      if (route === "POST /freectl/test") return json(200, await this.testModel(((await req.json()) as { id: string }).id));
    } catch (e) {
      return json(400, { error: { message: String(e instanceof Error ? e.message : e) } });
    }
    return json(404, { error: { message: `no route ${route}` } });
  }

  /** One upstream try: the response once it is known to be good; AttemptError lets the next model try. */
  private async attempt(m: FreeModel, body: Record<string, unknown>, endpoint: string, extra: Record<string, string>): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new AttemptError("first byte timeout")), this.cfg.first_byte_timeout_seconds * 1000);
    const t0 = Date.now();
    this.catalog.track(m.provider.name, 1);
    let handedOff = false;
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

      this.catalog.report(m.id, true, Date.now() - t0, undefined, JSON.stringify(body).length);
      const headers = { "content-type": up.headers.get("content-type") ?? "application/json", "cache-control": "no-cache", "x-freectl-model": m.id };
      if (!streamed) return new Response(relabel(head, m.id), { headers });

      // stream the rest; `model` is swapped by text substitution, not JSON parsing, to keep CPU per request low
      const model = `"model":${JSON.stringify(m.id)}`;
      const swap = (s: string) => s.replace(/^(data: ?\{.*?)"model":\s*"(?:[^"\\]|\\.)*"/gm, (_, pre: string) => pre + model);
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      handedOff = true;
      const pump = async () => {
        let pending = head;
        try {
          for (;;) {
            const cut = pending.lastIndexOf("\n") + 1;
            if (cut > 0) await writer.write(enc.encode(swap(pending.slice(0, cut))));
            pending = pending.slice(cut);
            const { done, value } = await reader.read();
            if (value) pending += dec.decode(value, { stream: true });
            if (done) break;
          }
          pending += dec.decode();
          if (pending) await writer.write(enc.encode(swap(pending)));
          await writer.close();
        } catch {
          // client hung up or upstream broke mid-stream: nothing left to fall back to
          reader.cancel().catch(() => {});
          writer.abort().catch(() => {});
        } finally {
          this.catalog.track(m.provider.name, -1);
        }
      };
      void pump();
      return new Response(readable, { headers });
    } finally {
      clearTimeout(timer);
      if (!handedOff) this.catalog.track(m.provider.name, -1);
    }
  }

  private async handleCompletion(req: Request, endpoint: string): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: { message: "invalid JSON body" } });
    }
    const want = String(body.model ?? "default");
    const isSwarm = SWARM_IDS.has(want);
    const isDefault = DEFAULT_IDS.has(want) || isSwarm;
    const key = isSwarm ? swarmKey(body) : "";
    const order = isSwarm ? this.catalog.swarmOrder(key) : undefined;
    const single = isDefault ? undefined : this.catalog.find(want);
    if (!isDefault && !single) return json(404, { error: { message: `unknown model "${want}" — see GET /v1/models` } });

    const tried = new Set<string>();
    const extra: Record<string, string> = {};
    for (const h of ATTRIBUTION) {
      const v = req.headers.get(h);
      if (v) extra[h] = v;
    }
    // models that already rejected a request this big are skipped (no cooldown: smaller ones still fit)
    const chars = JSON.stringify(body).length;
    const usable = (m: FreeModel) =>
      !tried.has(m.id) && !this.catalog.tooBig(m.id, chars) && (Object.keys(extra).length > 0 || !this.catalog.health.get(m.id)?.agentOnly);
    const next = (): FreeModel | undefined =>
      isDefault ? (tried.size < this.cfg.max_attempts ? pick(order ?? this.catalog.cascade(Infinity)) : undefined) : tried.size ? undefined : single;
    // ready models first; cooling ones only as a last resort
    const pick = (list: FreeModel[]) => list.find((m) => usable(m) && this.catalog.ready(m.id)) ?? list.find(usable);
    const failures: string[] = [];
    for (let m = next(); m; m = next()) {
      tried.add(m.id);
      try {
        const res = await this.attempt(m, body, endpoint, extra);
        if (isSwarm) this.catalog.swarmAssign(key, m.provider.name);
        console.log(`${want} -> ${m.id} ok${failures.length ? ` after ${failures.length} fall-back(s)` : ""}`);
        return res;
      } catch (e) {
        if (!(e instanceof AttemptError)) throw e;
        this.catalog.report(m.id, false, 0, e.message, chars);
        failures.push(`${m.id}: ${e.message}`);
        console.log(`${want} -> ${m.id} failed: ${e.message.slice(0, 200)}`);
      }
    }
    return json(502, { error: { message: `all ${tried.size} model(s) failed`, attempts: failures } });
  }

  private status() {
    const now = Date.now();
    const { cfg, catalog } = this;
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

  private publicConfig(): FreectlConfig {
    return { ...this.cfg, providers: this.cfg.providers.map((p) => ({ ...p, apiKey: maskKey(p.apiKey) })) };
  }

  private async updateConfig(raw: Partial<FreectlConfig>): Promise<void> {
    for (const p of raw.providers ?? []) {
      const old = this.cfg.providers.find((q) => q.name === p.name);
      if (old && (p.apiKey === maskKey(old.apiKey) || /[^\x00-\xff]/.test(p.apiKey))) p.apiKey = old.apiKey;
    }
    const next = normalizeConfig(raw);
    await this.ctx.storage.put("config", next);
    Object.assign(this.cfg, next);
    await this.catalog.refresh();
  }

  private async testModel(id: string) {
    const m = this.catalog.find(id);
    return m ? this.catalog.test(m) : { ok: false, error: "unknown model" };
  }
}
