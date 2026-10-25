export type ModelStatus = "unloaded" | "loading" | "loaded" | "unloading" | "error";

export interface GlobalConfig {
  env: Record<string, string>;
  args: string[];
  api_key: string;
  health_timeout_ms: number;
  load_drain_timeout_ms: number;
  max_resident: number;
  max_cache_slots_per_model: number;
  port_range: [number, number];
}

export interface PathsConfig {
  cache_dir: string;
  llama_server_exe: string;
  /** Folder scanned for .gguf files to auto-register as models. */
  models_dir: string;
}

export interface ModelConfig {
  display_name: string;
  model_path: string;
  args: string[];
  env?: Record<string, string>;
  max_cache_slots?: number;
}

/** The actually-loadable unit: llamactl always loads a profile of a model,
 * never the bare model. */
export interface ProfileConfig {
  model: string;
  args: string[];
  env?: Record<string, string>;
  load_on_startup?: boolean;
  /** Ports llama_launcher.py's "prefix cache": a persistent, continuously
   * self-correcting cache of the longest static prompt prefix (system
   * prompt + tool schemas), independent of the swap-cache below — it saves
   * prefill time on every big-agent-tool-context request, not just on
   * model-swap resume. Defaults true (restore) / false (rebuild), same as
   * the old launcher's default (restore unless --norestore; rebuild only
   * with --getcache). */
  prefix_cache_restore?: boolean;
  prefix_cache_rebuild?: boolean;
}

export interface LlamactlConfig {
  version: number;
  paths: PathsConfig;
  global: GlobalConfig;
  models: Record<string, ModelConfig>;
  profiles: Record<string, ProfileConfig>;
}

/** Composite key identifying a model, or a model+profile combination. */
export interface ModelKey {
  model: string;
  profile?: string;
}

/** A ModelKey that's guaranteed to name a profile — what every load/unload
 * actually operates on. */
export interface ResolvedKey {
  model: string;
  profile: string;
}

export function keyToId(key: ModelKey): string {
  return key.profile ? `${key.model}:${key.profile}` : key.model;
}

export function idToKey(id: string): ModelKey {
  const idx = id.indexOf(":");
  if (idx === -1) return { model: id };
  return { model: id.slice(0, idx), profile: id.slice(idx + 1) };
}

export interface ChildHandle {
  key: ModelKey;
  id: string;
  pid: number;
  port: number;
  startedAt: number;
  lastUsedAt: number;
  sessionRowId: number;
  state: ModelStatus;
  proc: import("node:child_process").ChildProcess;
}

export interface ModelListEntry {
  id: string;
  model: string;
  profile?: string;
  display_name: string;
  status: { value: ModelStatus; progress?: number };
  pid?: number;
  port?: number;
  startedAt?: number;
  lastCacheSavedAt?: number;
  cacheSizeBytes?: number;
  /** The effective --ctx-size/-c this profile will launch with — exposed so
   * OpenAI-compatible clients (pi, opencode, ...) can read the real context
   * window from /v1/models instead of guessing a default. */
  context_length?: number;
  /** Same window in llama-server router shape (`meta.n_ctx`), which pi-based
   * clients (little-coder) read from /v1/models. */
  meta?: { n_ctx: number };
}
