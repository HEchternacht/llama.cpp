import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import * as TOML from "smol-toml";
import type { LlamactlConfig, ModelConfig, PathsConfig, ProfileConfig, ResolvedKey } from "./types";

export const RESERVED_FLAGS = new Set(["--port", "--api-key", "--alias", "--model", "-m", "--host"]);
/** Additionally reserved for models/profiles only — global.args is the one
 * place --slot-save-path belongs (a per-model dir would break the flat
 * cache_dir layout cache-manager.ts assumes). */
const MODEL_LAYER_RESERVED_FLAGS = new Set([...RESERVED_FLAGS, "--slot-save-path"]);

/** Decodes one level of JSON-string-style backslash escaping (\\ -> \, \" -> "),
 * left-to-right. Lets profile/model args be pasted straight out of a JSON
 * file (e.g. the old model_args.json) without the caller pre-cleaning it;
 * a bare backslash with no matching \\ or \" is passed through unchanged. */
function jsonUnescapeOnce(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length && (s[i + 1] === "\\" || s[i + 1] === '"')) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

/** Shell-style tokenizer: whitespace splits tokens outside quotes; "..."
 * lets a token contain spaces; \" inside quotes is a literal quote that
 * doesn't close the span. */
function shellTokenize(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    let token = "";
    let inQuotes = false;
    while (i < n && (inQuotes || !/\s/.test(s[i]))) {
      const c = s[i];
      if (c === "\\" && i + 1 < n && s[i + 1] === '"') {
        token += '"';
        i += 2;
      } else if (c === '"') {
        inQuotes = !inQuotes;
        i++;
      } else {
        token += c;
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

/** A profile/model `args` field accepts either an already-tokenized array,
 * or a single command-line-style string (one level of JSON-escaping and
 * all) — the exact format model_args.json entries use, pasted verbatim. */
export function parseArgsString(s: string): string[] {
  return shellTokenize(jsonUnescapeOnce(s));
}

const CTX_SIZE_FLAGS = new Set(["-c", "--ctx-size"]);

/** Reads the effective --ctx-size/-c value out of a merged args list — this
 * is the actual context window llama-server will serve, and is what
 * OpenAI-compatible clients (pi, opencode, etc.) need to see on /v1/models
 * instead of guessing a default (they otherwise silently assume ~32k). Later
 * occurrences win, matching mergeArgs()'s override semantics. */
export function parseContextSize(args: string[]): number | undefined {
  let found: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (CTX_SIZE_FLAGS.has(args[i]) && i + 1 < args.length) {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n) && n > 0) found = n;
    }
  }
  return found;
}

function normalizeArgsField(x: unknown): string[] {
  if (x == null) return [];
  if (typeof x === "string") return parseArgsString(x);
  if (Array.isArray(x)) return x as string[];
  throw new Error(`args must be a string or an array of strings, got ${typeof x}`);
}

/** Drops any reserved flag (and its value, if the next token isn't itself a
 * flag) — reserved flags are injected by llamactl itself, so a pasted
 * model_args.json-style string naming them (--api-key, --alias, ...) is
 * silently cleaned up rather than rejected. */
function stripReservedFlags(args: string[], reserved: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (reserved.has(args[i])) {
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

const DEFAULT_CONFIG: LlamactlConfig = {
  version: 1,
  paths: {
    cache_dir: "C:\\cmodels\\llamactl-cache",
    llama_server_exe: "",
    models_dir: "C:\\cmodels",
  },
  global: {
    env: {},
    args: [],
    api_key: "changeme",
    health_timeout_ms: 30000,
    load_drain_timeout_ms: 10000,
    max_resident: 1,
    max_cache_slots_per_model: 3,
    port_range: [8081, 8099],
  },
  models: {},
  profiles: {},
};

function isNonAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(s);
}

/** Paths passed as CLI argument *values* to the spawned llama-server.exe must
 * be ASCII-only (llama.cpp mis-decodes non-ASCII bytes in flag values). The
 * exe path itself (argv[0]) is exempt — Node resolves/spawns it directly. */
export function assertAsciiPath(label: string, p: string): void {
  if (isNonAscii(p)) {
    throw new Error(
      `Config error: ${label} contains non-ASCII characters ("${p}"). ` +
        `llama-server mis-decodes non-ASCII path arguments; move this path under an ASCII-only directory.`,
    );
  }
}

export class ConfigStore {
  private cfg: LlamactlConfig;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.cfg = this.load();
  }

  private load(): LlamactlConfig {
    if (!existsSync(this.filePath)) {
      throw new Error(`Config file not found: ${this.filePath}`);
    }
    const raw = readFileSync(this.filePath, "utf-8");
    const parsed = TOML.parse(raw) as unknown as LlamactlConfig;
    const merged: LlamactlConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      paths: { ...DEFAULT_CONFIG.paths, ...parsed.paths },
      global: { ...DEFAULT_CONFIG.global, ...parsed.global },
      models: parsed.models ?? {},
      profiles: parsed.profiles ?? {},
    };
    this.normalizeConfig(merged);
    this.validate(merged);
    return merged;
  }

  /** Accepts `args` as either an already-tokenized array or a single
   * command-line-style string (model_args.json's format, pasted verbatim —
   * JSON-escaping and all), and strips reserved flags llamactl injects
   * itself so pasted strings don't need pre-cleaning. */
  private normalizeConfig(cfg: LlamactlConfig): void {
    cfg.global.args = stripReservedFlags(normalizeArgsField(cfg.global.args), RESERVED_FLAGS);
    for (const m of Object.values(cfg.models)) {
      m.args = stripReservedFlags(normalizeArgsField(m.args), MODEL_LAYER_RESERVED_FLAGS);
    }
    for (const p of Object.values(cfg.profiles)) {
      p.args = stripReservedFlags(normalizeArgsField(p.args), MODEL_LAYER_RESERVED_FLAGS);
    }
  }

  reload(): void {
    this.cfg = this.load();
  }

  get(): LlamactlConfig {
    return this.cfg;
  }

  /** Reserved-flag stripping happens in normalizeConfig(); this only checks
   * what normalization can't fix. */
  private validate(cfg: LlamactlConfig): void {
    assertAsciiPath("paths.cache_dir", cfg.paths.cache_dir);
    assertAsciiPath("paths.models_dir", cfg.paths.models_dir);
    for (const [id, m] of Object.entries(cfg.models)) {
      assertAsciiPath(`models.${id}.model_path`, m.model_path);
    }
    for (const [id, p] of Object.entries(cfg.profiles)) {
      if (!cfg.models[p.model]) {
        throw new Error(`Config error: profiles.${id} references unknown model "${p.model}"`);
      }
    }
  }

  /** Resolve the effective model_path + merged args/env for a model[:profile] id. */
  resolve(modelId: string, profileId?: string): { modelConfig: ModelConfig; args: string[]; env: Record<string, string> } {
    const m = this.cfg.models[modelId];
    if (!m) throw new Error(`Unknown model "${modelId}"`);
    let args = [...this.cfg.global.args, ...m.args];
    let env = { ...this.cfg.global.env, ...(m.env ?? {}) };
    if (profileId) {
      const p = this.cfg.profiles[profileId];
      if (!p) throw new Error(`Unknown profile "${profileId}"`);
      if (p.model !== modelId) throw new Error(`Profile "${profileId}" does not belong to model "${modelId}"`);
      args = mergeArgs(args, p.args);
      env = { ...env, ...(p.env ?? {}) };
    }
    return { modelConfig: m, args, env };
  }

  /** llamactl always loads a profile, never a bare model. If `profileId` is
   * omitted, the model's only profile is used; it's an error to omit it when
   * a model has zero or more than one profile. */
  resolveLoadKey(modelId: string, profileId?: string): ResolvedKey {
    if (!this.cfg.models[modelId]) throw new Error(`Unknown model "${modelId}"`);
    if (profileId) {
      const p = this.cfg.profiles[profileId];
      if (!p) throw new Error(`Unknown profile "${profileId}"`);
      if (p.model !== modelId) throw new Error(`Profile "${profileId}" does not belong to model "${modelId}"`);
      return { model: modelId, profile: profileId };
    }
    const ids = Object.entries(this.cfg.profiles)
      .filter(([, p]) => p.model === modelId)
      .map(([id]) => id);
    if (ids.length === 0) throw new Error(`Model "${modelId}" has no profiles configured — add one before loading it`);
    if (ids.length > 1) throw new Error(`Model "${modelId}" has multiple profiles (${ids.join(", ")}) — specify which one`);
    return { model: modelId, profile: ids[0] };
  }

  /** Scans paths.models_dir for .gguf files not already referenced by any
   * model's model_path, and registers each as a new model + a single
   * "<id>-default" profile (empty args). Multi-part GGUF shards
   * ("...-00002-of-00003.gguf") are skipped except the first shard, which
   * llama.cpp loads as the entry point for the whole set. Existing models
   * (and their args/profiles) are left untouched. Returns the new model ids. */
  discoverModels(): string[] {
    if (!existsSync(this.cfg.paths.models_dir)) return [];
    const known = new Set(Object.values(this.cfg.models).map((m) => m.model_path.toLowerCase()));
    const shardRe = /-(\d{5})-of-(\d{5})$/i;
    const added: string[] = [];
    const next: LlamactlConfig = structuredCloneConfig(this.cfg);
    for (const entry of readdirSync(this.cfg.paths.models_dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf")) continue;
      const fullPath = path.join(this.cfg.paths.models_dir, entry.name);
      if (known.has(fullPath.toLowerCase())) continue;
      const base = entry.name.slice(0, -".gguf".length);
      const shardMatch = base.match(shardRe);
      if (shardMatch && shardMatch[1] !== "00001") continue; // only the first shard is a load target
      const cleanBase = (shardMatch ? base.slice(0, shardMatch.index) : base).replace(/\s*\(\d+\)$/, "");
      const id = uniqueModelId(sanitizeId(cleanBase), next.models);
      next.models[id] = { display_name: cleanBase, model_path: fullPath, args: [] };
      next.profiles[`${id}-default`] = { model: id, args: [] };
      known.add(fullPath.toLowerCase());
      added.push(id);
    }
    if (added.length) {
      this.normalizeConfig(next);
      this.validate(next);
      this.writeAtomic(next);
      this.cfg = next;
    }
    return added;
  }

  maxCacheSlots(modelId: string): number {
    return this.cfg.models[modelId]?.max_cache_slots ?? this.cfg.global.max_cache_slots_per_model;
  }

  /** Atomically patch a layer (global/paths/models/:id/profiles/:id) and write back to disk. */
  patch(layer: "global", patch: Partial<LlamactlConfig["global"]>): void;
  patch(layer: "paths", patch: Partial<PathsConfig>): void;
  patch(layer: "models", id: string, patch: Partial<ModelConfig>): void;
  patch(layer: "profiles", id: string, patch: Partial<ProfileConfig>): void;
  patch(layer: "global" | "paths" | "models" | "profiles", idOrPatch: unknown, maybePatch?: unknown): void {
    const next: LlamactlConfig = structuredCloneConfig(this.cfg);
    if (layer === "global") {
      Object.assign(next.global, idOrPatch as Partial<LlamactlConfig["global"]>);
    } else if (layer === "paths") {
      Object.assign(next.paths, idOrPatch as Partial<PathsConfig>);
    } else if (layer === "models") {
      const id = idOrPatch as string;
      next.models[id] = { ...(next.models[id] ?? ({} as ModelConfig)), ...(maybePatch as Partial<ModelConfig>) };
    } else {
      const id = idOrPatch as string;
      next.profiles[id] = { ...(next.profiles[id] ?? ({} as ProfileConfig)), ...(maybePatch as Partial<ProfileConfig>) };
    }
    this.normalizeConfig(next);
    this.validate(next);
    this.writeAtomic(next);
    this.cfg = next;
  }

  /** The profile currently flagged load_on_startup, if any ("default startup model" in Settings). */
  startupProfile(): string | null {
    const found = Object.entries(this.cfg.profiles).find(([, p]) => p.load_on_startup);
    return found?.[0] ?? null;
  }

  /** Sets which single profile (or none) auto-loads on startup, clearing any previous one. */
  setStartupProfile(profileId: string | null): void {
    const next: LlamactlConfig = structuredCloneConfig(this.cfg);
    if (profileId && !next.profiles[profileId]) throw new Error(`Unknown profile "${profileId}"`);
    for (const p of Object.values(next.profiles)) p.load_on_startup = false;
    if (profileId) next.profiles[profileId].load_on_startup = true;
    this.validate(next);
    this.writeAtomic(next);
    this.cfg = next;
  }

  deleteProfile(id: string): void {
    const next: LlamactlConfig = structuredCloneConfig(this.cfg);
    delete next.profiles[id];
    this.writeAtomic(next);
    this.cfg = next;
  }

  /** Deletes a model and any profiles that belong to it. */
  deleteModel(id: string): void {
    const next: LlamactlConfig = structuredCloneConfig(this.cfg);
    delete next.models[id];
    for (const [profileId, p] of Object.entries(next.profiles)) {
      if (p.model === id) delete next.profiles[profileId];
    }
    this.writeAtomic(next);
    this.cfg = next;
  }

  private writeAtomic(cfg: LlamactlConfig): void {
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, TOML.stringify(cfg as unknown as TOML.TomlPrimitive), "utf-8");
    renameSync(tmp, this.filePath);
  }
}

function structuredCloneConfig(cfg: LlamactlConfig): LlamactlConfig {
  return JSON.parse(JSON.stringify(cfg));
}

function sanitizeId(s: string): string {
  const id = s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || "model";
}

function uniqueModelId(base: string, existing: Record<string, unknown>): string {
  if (!existing[base]) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing[candidate]) return candidate;
  }
}

/** Later args win on conflicting flags: if an arg in `override` is a `--flag`
 * that also appears in `base`, drop the base flag (and its value, if any)
 * before appending the override's flag/value pair(s). */
function mergeArgs(base: string[], override: string[]): string[] {
  const overrideFlags = new Set(override.filter((a) => a.startsWith("--")));
  const kept: string[] = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[i];
    if (a.startsWith("--") && overrideFlags.has(a)) {
      // skip this flag and its value (next token, if it isn't itself a flag)
      if (i + 1 < base.length && !base[i + 1].startsWith("--")) i++;
      continue;
    }
    kept.push(a);
  }
  return [...kept, ...override];
}

export function resolveHome(): string {
  if (process.env.LLAMACTL_HOME) return process.env.LLAMACTL_HOME;
  return path.resolve(__dirname, "..");
}
