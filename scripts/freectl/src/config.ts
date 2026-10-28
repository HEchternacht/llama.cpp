import { readFileSync, writeFileSync } from "node:fs";

export interface ProviderConfig {
  /** Prefix of the exposed model ids: `<name>/<upstream id>`. */
  name: string;
  /** OpenAI-compatible base URL, ending in /v1. */
  baseUrl: string;
  /** Literal key, or `env:NAME` to read it from the environment. */
  apiKey: string;
  /** Overrides the global free_pattern for this provider; ".*" = every model
   * (providers whose free tier covers the whole catalog, e.g. Groq). */
  freePattern?: string;
  /** Upstream ids exposed even without the free pattern. */
  include?: string[];
  /** Upstream ids never exposed. */
  exclude?: string[];
  enabled?: boolean;
}

export interface FreectlConfig {
  port: number;
  api_key: string;
  /** Case-insensitive regex an upstream model id must match to count as free. */
  free_pattern: string;
  /** Case-insensitive regex of non-chat models dropped everywhere (guards, speech, embeddings, ...). */
  exclude_pattern: string;
  /** Models with a known context window below this are dropped (non-chat / toy models). */
  min_context: number;
  /** Re-list every provider's /models this often. */
  refresh_minutes: number;
  /** Each check (every refresh_minutes) re-tests models last tested longer ago than this;
   * finds models that became paid or free again. 0 = no tests, only re-listing. */
  check_hours: number;
  /** A failed model is skipped by the `default` cascade for this long. */
  cooldown_seconds: number;
  /** Give up on an upstream that sent no response headers within this time. */
  first_byte_timeout_seconds: number;
  /** At most this many models are tried per `default` request. */
  max_attempts: number;
  /** Exposed ids (`provider/id`) or upstream ids, strongest first; these
   * always rank above the heuristic order, in this order. */
  priority: string[];
  /** Exposed or upstream ids left out of the `default` cascade. */
  cascade_exclude: string[];
  /** Context window reported for `default`; 0 = the smallest known window of
   * the cascade's models (a fall-back may land on any of them). */
  default_context_length: number;
  /** `default` requests running at the same time start on different providers. */
  prefer_different_providers: boolean;
  providers: ProviderConfig[];
}

const DEFAULTS: Omit<FreectlConfig, "providers"> = {
  port: 8090,
  api_key: "test",
  free_pattern: "free",
  exclude_pattern: "guard|safety|whisper|tts|orpheus|embed|rerank|moderation|verify|transcri|speech|audio|image-gen|dall-e",
  min_context: 8192,
  refresh_minutes: 30,
  check_hours: 24,
  cooldown_seconds: 120,
  first_byte_timeout_seconds: 90,
  max_attempts: 8,
  priority: [],
  cascade_exclude: [],
  default_context_length: 0,
  prefer_different_providers: true,
};

export function loadConfig(path: string): FreectlConfig {
  return normalizeConfig(JSON.parse(readFileSync(path, "utf-8")) as Partial<FreectlConfig>);
}

/** Fills defaults and validates; throws on a malformed config. */
export function normalizeConfig(raw: Partial<FreectlConfig>): FreectlConfig {
  const cfg = { ...DEFAULTS, ...raw, providers: raw.providers ?? [] } as FreectlConfig;
  for (const p of cfg.providers) {
    if (!p.name || !p.baseUrl) throw new Error(`provider entry needs "name" and "baseUrl": ${JSON.stringify(p)}`);
    p.baseUrl = p.baseUrl.replace(/\/+$/, "");
    if (p.freePattern) new RegExp(p.freePattern);
  }
  if (cfg.providers.some((p, i) => cfg.providers.findIndex((q) => q.name === p.name) !== i)) throw new Error("provider names must be unique");
  new RegExp(cfg.free_pattern);
  new RegExp(cfg.exclude_pattern);
  return cfg;
}

export function resolveKey(key: string): string {
  return key.startsWith("env:") ? process.env[key.slice(4)] ?? "" : key;
}

export function saveConfig(path: string, cfg: FreectlConfig): void {
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}
