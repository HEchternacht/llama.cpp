import { resolveKey, type FreectlConfig, type ProviderConfig } from "./config.ts";

export interface FreeModel {
  /** Exposed id: `<provider>/<upstream id>`. */
  id: string;
  provider: ProviderConfig;
  upstream: string;
  name?: string;
  contextLength?: number;
  /** Total parameters in billions, parsed or assumed from the family. */
  paramsB?: number;
  score: number;
}

export interface Health {
  ok: number;
  failed: number;
  cooldownUntil: number;
  lastError?: string;
  /** Outcome of the most recent request or test. */
  lastOk?: boolean;
  /** Served only to recognised agent apps (OpenRouter app attribution headers). */
  agentOnly?: boolean;
  lastLatencyMs?: number;
  /** Smallest request body (chars) rejected as too large; larger requests skip this model. */
  tooBigChars?: number;
  /** Largest request body (chars) answered. */
  maxOkChars?: number;
}

export interface Change {
  at: number;
  id: string;
  event: "new free" | "left free list" | "became paid" | "free again";
}

/** What the catalog remembers across restarts. */
export interface CatalogState {
  /** Exposed ids of the last listing, to tell new and vanished models apart. */
  known: string[];
  /** Models that answered with a billing error: hidden until a test finds them free again. */
  paid: Record<string, { since: number; error: string }>;
  /** When each model was last tested. */
  checked: Record<string, number>;
  /** Newest first. */
  changes: Change[];
  /** End of the last check() run. */
  checkedAt?: number;
}

export const emptyState = (): CatalogState => ({ known: [], paid: {}, checked: {}, changes: [] });

export interface TestResult {
  ok: boolean;
  agentOnly?: boolean;
  ms?: number;
  content?: string;
  error?: string;
}

interface UpstreamModel {
  id: string;
  name?: string;
  description?: string;
  pricing?: Record<string, string>;
  context_length?: number;
  context_window?: number;
  max_context_length?: number;
  top_provider?: { context_length?: number };
}

/** Assumed total size (B) for families whose ids carry no parameter count. */
const FAMILY_SIZES: Array<[RegExp, number]> = [
  [/kimi-k2|qwen3[.-]?max|gpt-5|claude|gemini[\w.-]*pro|grok-[34]/, 1000],
  [/deepseek[\w.-]*(v3|v4|r1|chat|reasoner)/, 671],
  [/qwen3[\w.-]*coder/, 480],
  [/llama-4-maverick/, 400],
  [/glm-4\.7-flash/, 30],
  [/glm-4\.6v-flash/, 9],
  [/glm-[45][\w.-]*(air|flash)/, 106],
  [/glm-[45]/, 355],
  [/gemini[\w.-]*flash|gpt-4o|grok/, 200],
  [/mistral-large/, 123],
  [/llama-4-scout/, 109],
  [/minimax-m[12]/, 230],
  [/command-a/, 111],
  [/command-r-plus/, 104],
  [/command-r7b/, 7],
  [/command-r/, 35],
];

/** Active size (B) of MoE models whose ids carry only the total. */
const FAMILY_ACTIVE: Array<[RegExp, number]> = [
  [/gpt-oss-120b/, 5.1],
  [/gpt-oss-20b/, 3.6],
  [/glm-4\.7-flash/, 3],
];

/** Upstream refusal of a model that only serves recognised agent apps, e.g. OpenRouter's
 * "<model> is only available on agentic harnesses". */
export const AGENT_ONLY = /only available on agentic harness/i;

/** Upstream errors saying the model now costs money (Z.ai 1113 "Insufficient balance or no
 * resource package", OpenRouter 402 "requires more credits", ...). Not 429 texts: Groq's rate
 * limit message advertises an upgrade but the model is still free. */
export const PAID = /^HTTP 402\b|insufficient (balance|credits?|funds)|no resource package|payment required|requires? (a )?(paid|more credits)|not available (on|for|in) (the )?free/i;

/** The request is too big for this model (or its free tier): Groq 413 tokens-per-minute,
 * OrcaRouter "prompt is longer than the free tier allows", Cohere TOO_MANY_TOKENS, context
 * overflows. Says nothing about smaller requests, so no cooldown. */
export const TOO_BIG = /^HTTP 413\b|request too large|prompt is longer|too many tokens|too_many_tokens|context[ _]length|maximum context|context window|reduce the length|input is too long|too long for/i;

/** An account-wide daily quota (OpenRouter: 50 free requests/day without credits, reset at
 * 00:00 UTC): every model of the provider is out until then. */
const DAILY_QUOTA = /free-models-per-day/i;

/** Cooldown after a 401 / 403 / 404. */
const PERMANENT_COOLDOWN_MS = 30 * 60_000;

/** Models tested per check run (Workers free plan: 50 outbound requests per invocation). */
const CHECK_LIMIT = 30;
const CHECK_CONCURRENCY = 4;

/** Error text of an upstream JSON body, if it is one. */
export function errorOf(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as { error?: unknown; choices?: unknown[] };
    if (j.error) return typeof j.error === "string" ? j.error : JSON.stringify(j.error).slice(0, 300);
    if (Array.isArray(j.choices) && j.choices.length === 0) return "empty choices";
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** What identifies one conversation for the `swarm` model: its first user message (the same on
 * every turn of an agent, different between sub-agents with different tasks). */
export function swarmKey(body: Record<string, unknown>): string {
  const first = (body.messages as Array<{ role?: string; content?: unknown }> | undefined)?.find((m) => m.role === "user");
  return JSON.stringify(first?.content ?? body.prompt ?? "").slice(0, 4000);
}

/** A `swarm` conversation idle this long frees its provider slot. */
const SWARM_TTL_MS = 10 * 60_000;

/** A listed price above zero (OpenRouter, Groq list prices per token). */
function priced(u: UpstreamModel): boolean {
  return !!u.pricing && ["prompt", "completion"].some((k) => Number(u.pricing?.[k]) > 0);
}

const providerOf = (id: string) => id.slice(0, id.indexOf("/"));

/** Weaker variants of a family. */
const LIGHT = /(flash|mini|lite|nano|small|tiny|air|haiku)/;
/** Meta-models that route on their own: unknown strength, kept as last resort. */
const META = /(^|\/)(auto|free|router|fusion[\w-]*)$/;

export function scoreModel(m: Omit<FreeModel, "score" | "paramsB">, description = ""): { score: number; paramsB?: number } {
  const idName = `${m.upstream} ${m.name ?? ""}`.toLowerCase();
  const desc = description.toLowerCase();

  let total: number | undefined;
  let active: number | undefined;
  for (const x of idName.matchAll(/(?<![a-z])a?(\d+(?:\.\d+)?)\s*([bt])(?![a-z])/g)) {
    const v = parseFloat(x[1]) * (x[2] === "t" ? 1000 : 1);
    if (x[0].startsWith("a")) active = v;
    else total = Math.max(total ?? 0, v);
  }
  // descriptions mention token counts too, so only trust "<n>B total / params / parameters"
  for (const x of desc.matchAll(/(\d+(?:\.\d+)?)\s*b\s*(total|param)/g)) total = Math.max(total ?? 0, parseFloat(x[1]));
  const act = desc.match(/(\d+(?:\.\d+)?)\s*b\s*activ/);
  if (act) active = parseFloat(act[1]);
  if (total === undefined) total = FAMILY_SIZES.find(([re]) => re.test(idName))?.[1];
  if (active === undefined) active = FAMILY_ACTIVE.find(([re]) => re.test(idName))?.[1];

  if (META.test(m.upstream.toLowerCase())) return { score: -100, paramsB: total };
  if (total === undefined) return { score: 0 };
  // MoE: total size carries knowledge, active size carries per-token compute
  let score = Math.log2(total) + 0.5 * Math.log2(active ?? total);
  if (LIGHT.test(idName)) score -= 1;
  return { score, paramsB: total };
}

function contextOf(u: UpstreamModel): number | undefined {
  const n = u.context_length ?? u.context_window ?? u.max_context_length ?? u.top_provider?.context_length;
  if (n) return n;
  const m = (u.description ?? "").match(/(\d+(?:\.\d+)?)\s*([km])(?:[- ]?tokens?)?\s+context/i);
  return m ? Math.round(parseFloat(m[1]) * (m[2].toLowerCase() === "m" ? 1_048_576 : 1024)) : undefined;
}

export class Catalog {
  models: FreeModel[] = [];
  health = new Map<string, Health>();
  errors = new Map<string, string>();
  refreshedAt = 0;
  private cfg: FreectlConfig;
  /** Models seen upstream but filtered out, per provider (shown in the UI). */
  skipped = new Map<string, string[]>();
  /** Listed models hidden as paid; tested again by check(). */
  paidListed: FreeModel[] = [];
  state: CatalogState;
  private onSave?: (s: CatalogState) => unknown;

  constructor(cfg: FreectlConfig, state = emptyState(), onSave?: (s: CatalogState) => unknown) {
    this.cfg = cfg;
    this.state = state;
    this.onSave = onSave;
  }

  private save(): void {
    void Promise.resolve()
      .then(() => this.onSave?.(this.state))
      .catch((e) => console.log(`saving catalog state failed: ${e}`));
  }

  private log(id: string, event: Change["event"]): void {
    console.log(`${event}: ${id}`);
    this.state.changes.unshift({ at: Date.now(), id, event });
    this.state.changes.length = Math.min(this.state.changes.length, 100);
  }

  async refresh(): Promise<void> {
    const excluded = this.cfg.exclude_pattern ? new RegExp(this.cfg.exclude_pattern, "i") : undefined;
    const found: FreeModel[] = [];
    /** Providers that answered this time: only their models can be "gone". */
    const listedOk = new Set<string>();
    await Promise.all(
      this.cfg.providers
        .filter((p) => p.enabled !== false)
        .map(async (p) => {
          const pattern = new RegExp(p.freePattern || this.cfg.free_pattern, "i");
          try {
            const res = await fetch(`${p.baseUrl}/models`, {
              headers: { authorization: `Bearer ${resolveKey(p.apiKey)}` },
              signal: AbortSignal.timeout(30_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = (await res.json()) as { data?: UpstreamModel[] };
            const skipped: string[] = [];
            // included ids the provider does not list (e.g. Z.ai's free *-flash models) are served anyway
            const listed = new Set((body.data ?? []).map((u) => u.id));
            const unlisted = (p.include ?? []).filter((id) => !listed.has(id)).map((id): UpstreamModel => ({ id }));
            for (const u of [...(body.data ?? []), ...unlisted]) {
              if (p.exclude?.includes(u.id)) continue;
              const ctx = contextOf(u);
              if (!p.include?.includes(u.id)) {
                if (!pattern.test(u.id) || excluded?.test(u.id) || (ctx && ctx < this.cfg.min_context)) {
                  skipped.push(u.id);
                  continue;
                }
                // a "free"-named model the provider prices is not free (providers with their own
                // freePattern, e.g. Groq's free tier, list prices for paying accounts)
                if (!p.freePattern && priced(u)) {
                  skipped.push(`${u.id} (priced)`);
                  continue;
                }
              }
              const base = { id: `${p.name}/${u.id}`, provider: p, upstream: u.id, name: u.name, contextLength: ctx };
              found.push({ ...base, ...scoreModel(base, u.description) });
            }
            this.skipped.set(p.name, skipped);
            this.errors.delete(p.name);
            listedOk.add(p.name);
          } catch (e) {
            // keep the provider's previous models rather than dropping them on a transient failure
            this.errors.set(p.name, String(e));
            found.push(...[...this.models, ...this.paidListed].filter((m) => m.provider.name === p.name));
          }
        }),
    );
    const { paid } = this.state;
    const listed = new Set(found.map((m) => m.id));
    // a paid model its provider no longer lists is forgotten
    for (const id of Object.keys(paid)) if (!listed.has(id) && listedOk.has(providerOf(id))) delete paid[id];
    this.paidListed = found.filter((m) => paid[m.id]);
    const models = found.filter((m) => !paid[m.id]);
    // diff against the previous listing (none on the very first run: everything would be "new")
    if (this.state.known.length) {
      const before = new Set(this.state.known);
      for (const m of models) if (!before.has(m.id)) this.log(m.id, "new free");
      for (const id of before) if (!listed.has(id) && listedOk.has(providerOf(id))) this.log(id, "left free list");
    }
    this.state.known = [...listed];
    this.models = this.rank(models);
    this.refreshedAt = Date.now();
    this.save();
  }

  /** Re-lists, then tests the models (paid ones included) whose last test is older than
   * check_hours, oldest first, at most CHECK_LIMIT per run. Tests mark billing errors as paid
   * and bring paid models that answer back (see report). */
  async check(): Promise<void> {
    await this.refresh();
    if (this.cfg.check_hours <= 0) return;
    const { checked } = this.state;
    const now = Date.now();
    const stale = now - this.cfg.check_hours * 3_600_000;
    const queue = [...this.paidListed, ...this.models]
      .filter((m) => (checked[m.id] ?? 0) < stale && (this.health.get(m.id)?.cooldownUntil ?? 0) <= now)
      .sort((a, b) => (checked[a.id] ?? 0) - (checked[b.id] ?? 0))
      .slice(0, CHECK_LIMIT);
    await Promise.all(
      Array.from({ length: CHECK_CONCURRENCY }, async () => {
        for (let m = queue.shift(); m; m = queue.shift()) await this.test(m);
      }),
    );
    this.state.checkedAt = Date.now();
    this.save();
  }

  /** One short completion against a single model (UI Test button, check runs). */
  async test(m: FreeModel): Promise<TestResult> {
    const t0 = Date.now();
    this.state.checked[m.id] = t0;
    try {
      const up = await fetch(`${m.provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${resolveKey(m.provider.apiKey)}` },
        body: JSON.stringify({ model: m.upstream, max_tokens: 512, messages: [{ role: "user", content: "Reply with exactly: OK" }] }),
        signal: AbortSignal.timeout(this.cfg.first_byte_timeout_seconds * 1000),
      });
      const text = await up.text();
      const err = up.ok ? errorOf(text) : `HTTP ${up.status} ${errorOf(text) ?? text.slice(0, 300)}`;
      this.report(m.id, !err, Date.now() - t0, err);
      if (err) return { ok: false, agentOnly: AGENT_ONLY.test(err), ms: Date.now() - t0, error: err };
      const msg = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message;
      return { ok: true, ms: Date.now() - t0, content: msg?.content ?? "" };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: String(e) };
    }
  }

  /** priority list first (in its order), then heuristic score, then context window. */
  private rank(models: FreeModel[]): FreeModel[] {
    const prio = (m: FreeModel) => {
      const i = this.cfg.priority.findIndex((p) => p === m.id || p === m.upstream);
      return i < 0 ? Infinity : i;
    };
    return models.sort((a, b) => prio(a) - prio(b) || b.score - a.score || (b.contextLength ?? 0) - (a.contextLength ?? 0) || a.id.localeCompare(b.id));
  }

  find(id: string): FreeModel | undefined {
    const all = [...this.models, ...this.paidListed];
    return all.find((m) => m.id === id) ?? all.find((m) => m.upstream === id);
  }

  /** The `default` fall-back order: ranked models, excluded ones dropped, cooling-down ones last. */
  cascade(limit = this.cfg.max_attempts): FreeModel[] {
    const now = Date.now();
    const ex = this.cfg.cascade_exclude;
    const list = this.models.filter((m) => !ex.includes(m.id) && !ex.includes(m.upstream));
    const ready = list.filter((m) => (this.health.get(m.id)?.cooldownUntil ?? 0) <= now);
    const cooling = list.filter((m) => (this.health.get(m.id)?.cooldownUntil ?? 0) > now);
    if (this.cfg.prefer_different_providers) {
      // parallel requests spread over providers (separate rate limits): providers with fewer
      // requests in flight first, rank order kept within the same load (stable sort)
      const busy = (m: FreeModel) => this.inFlight.get(m.provider.name) ?? 0;
      ready.sort((a, b) => busy(a) - busy(b));
    }
    return [...ready, ...cooling].slice(0, limit);
  }

  /** `swarm` conversation key → its provider. */
  private affinity = new Map<string, { provider: string; at: number }>();

  /** The `swarm` model's order for one conversation: its provider's ready models (rank order),
   * then the other providers least-loaded first — load = live `swarm` conversations + requests in
   * flight, ties to the provider whose best model ranks higher — then cooling models. A new
   * conversation gets the least-loaded provider, so parallel sub-agents run one per provider and
   * fall-backs keep spreading instead of piling onto the strongest model. */
  swarmOrder(key: string): FreeModel[] {
    const now = Date.now();
    for (const [k, a] of this.affinity) if (now - a.at > SWARM_TTL_MS) this.affinity.delete(k);
    const ex = this.cfg.cascade_exclude;
    const list = this.models.filter((m) => !ex.includes(m.id) && !ex.includes(m.upstream));
    const ready = list.filter((m) => this.ready(m.id));
    const live = this.swarmLoad();
    const load = (p: string) => (live[p] ?? 0) + (this.inFlight.get(p) ?? 0);
    // providers in the rank order of their best ready model, then least loaded first (stable sort)
    const providers = [...new Set(ready.map((m) => m.provider.name))].sort((x, y) => load(x) - load(y));
    let a = this.affinity.get(key);
    if (!a || !providers.includes(a.provider)) {
      if (!providers.length) return list;
      a = { provider: providers[0], at: now };
      this.affinity.set(key, a);
    }
    a.at = now;
    const own = a.provider;
    const of = (p: string) => ready.filter((m) => m.provider.name === p);
    return [...of(own), ...providers.filter((p) => p !== own).flatMap(of), ...list.filter((m) => !ready.includes(m))];
  }

  /** A `swarm` conversation that a fall-back answered from another provider moves there. */
  swarmAssign(key: string, provider: string): void {
    this.affinity.set(key, { provider, at: Date.now() });
  }

  /** Live `swarm` conversations per provider. */
  swarmLoad(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const a of this.affinity.values()) out[a.provider] = (out[a.provider] ?? 0) + 1;
    return out;
  }

  /** Requests currently running per provider. */
  inFlight = new Map<string, number>();

  track(provider: string, delta: 1 | -1): void {
    this.inFlight.set(provider, (this.inFlight.get(provider) ?? 0) + delta);
  }

  defaultContext(): number | undefined {
    if (this.cfg.default_context_length > 0) return this.cfg.default_context_length;
    const known = this.cascade()
      .map((m) => m.contextLength)
      .filter((n): n is number => !!n);
    return known.length ? Math.min(...known) : undefined;
  }

  /** Not cooling down right now. A fall-back re-checks this: one failure (e.g. a provider's daily
   * quota) can cool other models after the request's order was taken. */
  ready(id: string): boolean {
    return (this.health.get(id)?.cooldownUntil ?? 0) <= Date.now();
  }

  /** Whether a request body of `chars` is known to be too large for the model. */
  tooBig(id: string, chars: number): boolean {
    return chars >= (this.health.get(id)?.tooBigChars ?? Infinity);
  }

  /** `chars`: size of the request body, for too-large tracking. */
  report(id: string, ok: boolean, latencyMs: number, error?: string, chars?: number): void {
    const h = this.health.get(id) ?? { ok: 0, failed: 0, cooldownUntil: 0 };
    // live traffic counts as a test: check() leaves models in use alone (saves free quotas)
    this.state.checked[id] = Date.now();
    const paidModel = this.paidListed.find((m) => m.id === id);
    if (ok && paidModel) {
      delete this.state.paid[id];
      this.paidListed = this.paidListed.filter((m) => m !== paidModel);
      this.models = this.rank([...this.models, paidModel]);
      this.log(id, "free again");
      this.save();
    }
    if (!ok && error && PAID.test(error)) {
      // out of the free list until a test succeeds again
      h.failed++;
      h.lastOk = false;
      h.lastError = error;
      if (!this.state.paid[id]) {
        this.state.paid[id] = { since: Date.now(), error };
        const m = this.models.find((x) => x.id === id);
        if (m) {
          this.models = this.models.filter((x) => x !== m);
          this.paidListed.push(m);
        }
        this.log(id, "became paid");
        this.save();
      }
    } else if (!ok && error && TOO_BIG.test(error)) {
      // only this size and up: smaller requests still go to the model, without a cooldown
      h.lastError = error;
      if (chars) h.tooBigChars = Math.min(h.tooBigChars ?? Infinity, chars);
    } else if (!ok && error && AGENT_ONLY.test(error)) {
      // the model works, just not for this caller: no failure, no cooldown
      h.agentOnly = true;
      h.lastError = error;
    } else if (ok) {
      h.ok++;
      h.lastOk = true;
      h.cooldownUntil = 0;
      h.lastLatencyMs = latencyMs;
      if (chars) {
        h.maxOkChars = Math.max(h.maxOkChars ?? 0, chars);
        // a bigger request got through (limit raised, or the rejection was per-minute): forget it
        if (h.tooBigChars !== undefined && chars >= h.tooBigChars) h.tooBigChars = undefined;
      }
    } else {
      h.failed++;
      h.lastOk = false;
      // auth / not-found / access errors don't heal in seconds: keep those models out much longer
      const permanent = /^HTTP (401|403|404)\b/.test(error ?? "");
      h.cooldownUntil = Date.now() + (permanent ? PERMANENT_COOLDOWN_MS : this.cfg.cooldown_seconds * 1000);
      h.lastError = error;
      if (DAILY_QUOTA.test(error ?? "")) {
        const reset = new Date().setUTCHours(24, 0, 0, 0);
        h.cooldownUntil = reset;
        for (const m of this.models) {
          if (m.id === id || providerOf(m.id) !== providerOf(id)) continue;
          const o = this.health.get(m.id) ?? { ok: 0, failed: 0, cooldownUntil: 0 };
          o.cooldownUntil = Math.max(o.cooldownUntil, reset);
          o.lastError = error;
          this.health.set(m.id, o);
        }
      }
    }
    this.health.set(id, h);
  }
}
