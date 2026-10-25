import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { parseContextSize, type ConfigStore } from "./config";
import { CacheManager } from "./cache-manager";
import { PrefixCacheManager } from "./prefix-cache";
import { Stats } from "./stats";
import type { ChildHandle, ModelKey, ModelListEntry, ModelStatus, ResolvedKey } from "./types";
import { keyToId } from "./types";

const POLL_INTERVAL_MS = 300;

export class ProcessManager {
  private residents = new Map<string, ChildHandle>();
  private loading = new Map<string, Promise<ChildHandle>>();
  private loadProgress = new Map<string, number>();
  private usedPorts = new Set<number>();

  constructor(
    private config: ConfigStore,
    private cache: CacheManager,
    private prefixCache: PrefixCacheManager,
    private stats: Stats,
    private home: string,
  ) {}

  /** Every loadable unit is a profile — a bare model is never listed as
   * directly loadable, since llamactl always loads a profile of a model. */
  list(): ModelListEntry[] {
    const cfg = this.config.get();
    const out: ModelListEntry[] = [];
    for (const [modelId, m] of Object.entries(cfg.models)) {
      for (const [profileId, p] of Object.entries(cfg.profiles)) {
        if (p.model === modelId) out.push(this.entryFor({ model: modelId, profile: profileId }, m.display_name));
      }
    }
    return out;
  }

  private entryFor(key: ModelKey, displayName: string): ModelListEntry {
    const id = keyToId(key);
    const resident = this.residents.get(id);
    const status: ModelStatus = resident ? resident.state : this.loading.has(id) ? "loading" : "unloaded";
    const lastCacheSavedAt = this.cache.lastSavedAt(key.model, key.profile);
    const cacheSizeBytes = this.cache.sizeOf(key.model, key.profile);
    let context_length: number | undefined;
    try {
      context_length = parseContextSize(this.config.resolve(key.model, key.profile).args);
    } catch {
      /* unresolvable (dangling profile reference) — leave undefined */
    }
    return {
      id,
      model: key.model,
      profile: key.profile,
      display_name: displayName,
      status: { value: status, progress: this.loadProgress.get(id) },
      pid: resident?.pid,
      port: resident?.port,
      startedAt: resident?.startedAt,
      lastCacheSavedAt,
      cacheSizeBytes,
      context_length,
      meta: context_length ? { n_ctx: context_length } : undefined,
    };
  }

  getResident(id: string): ChildHandle | undefined {
    return this.residents.get(id);
  }

  findResidentByKey(key: ModelKey): ChildHandle | undefined {
    return this.residents.get(keyToId(key));
  }

  async load(key: ModelKey): Promise<ChildHandle> {
    const id = keyToId(key);
    const existing = this.residents.get(id);
    if (existing && existing.state === "loaded") {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const inflight = this.loading.get(id);
    if (inflight) return inflight;

    const promise = this.doLoad(key, id);
    this.loading.set(id, promise);
    try {
      return await promise;
    } finally {
      this.loading.delete(id);
      this.loadProgress.delete(id);
    }
  }

  private async doLoad(key: ModelKey, id: string): Promise<ChildHandle> {
    const cfg = this.config.get();
    await this.evictIfNeeded(id);

    const { modelConfig, args, env } = this.config.resolve(key.model, key.profile);
    const profileCfg = key.profile ? this.config.get().profiles[key.profile] : undefined;
    const port = this.allocatePort();
    const sessionRowId = this.stats.startSession(key.model, key.profile, port);

    mkdirSync(path.join(this.home, "logs", "children"), { recursive: true });
    const logPath = path.join(this.home, "logs", "children", `${sanitize(id)}-${Date.now()}.log`);
    const logStream = createWriteStream(logPath, { flags: "a" });

    const fullArgs = [
      "--model", modelConfig.model_path,
      ...args,
      "--port", String(port),
      "--host", "127.0.0.1",
    ];
    // Children are unauthenticated/localhost-only by design (llamactl owns auth
    // at its own API layer). Strip any inherited LLAMA_API_KEY (this machine's
    // shell environment sets it to the literal string "None") so the child
    // doesn't demand a bearer token the proxy never sends it.
    const childEnv = { ...process.env, ...env };
    delete childEnv.LLAMA_API_KEY;
    // The prefix-cache watcher reads prompt text off /slots, which needs this.
    if (profileCfg?.prefix_cache_rebuild) childEnv.LLAMA_SERVER_SLOTS_DEBUG = "1";
    else delete childEnv.LLAMA_SERVER_SLOTS_DEBUG;
    const proc = spawn(cfg.paths.llama_server_exe, fullArgs, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    proc.stdout?.pipe(logStream);
    proc.stderr?.pipe(logStream);

    const handle: ChildHandle = {
      key,
      id,
      pid: proc.pid ?? -1,
      port,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      sessionRowId,
      state: "loading",
      proc,
    };
    this.residents.set(id, handle);
    this.usedPorts.add(port);

    // "close" (not "exit") so stdout/stderr have finished flushing to logPath
    // before we tail it — the whole point is to surface llama-server's own
    // error line (OOM, missing file, bad arg) instead of just an exit code.
    proc.on("close", (code, signal) => {
      this.usedPorts.delete(port);
      this.prefixCache.stopWatcher(id);
      if (this.residents.get(id) === handle && handle.state !== "unloading") {
        const tail = tailLogSync(logPath, 15);
        const summary = tail.length ? ` — last log lines:\n${tail.join("\n")}` : "";
        this.stats.logError(
          key.model,
          key.profile,
          "crashed",
          `child exited unexpectedly (code=${code}, signal=${signal})${summary}`,
          tail.length ? { logPath, tail } : undefined,
        );
        this.residents.delete(id);
      }
      this.stats.endSession(sessionRowId, handle.state === "unloading" ? "unload_requested" : "crashed");
    });

    try {
      await this.waitHealthy(port, cfg.global.health_timeout_ms, id);
    } catch (e) {
      this.stats.logError(key.model, key.profile, "health_timeout", String(e));
      try {
        proc.kill();
      } catch {
        /* best effort */
      }
      this.residents.delete(id);
      throw e;
    }

    const swapRestored = await this.cache.restore(key, port).catch((e) => {
      this.stats.logError(key.model, key.profile, "cache_restore_failed", String(e));
      return false;
    });
    // Only fall back to the prefix cache when there's no fuller swap-cache
    // snapshot to resume from — swap-cache already includes whatever prefix
    // was there, so restoring both would just be a wasted extra round trip.
    if (!swapRestored && profileCfg?.prefix_cache_restore !== false) {
      await this.prefixCache.restore(key as ResolvedKey, port).catch((e) => {
        this.stats.logError(key.model, key.profile, "prefix_cache_restore_failed", String(e));
      });
    }
    if (profileCfg?.prefix_cache_rebuild) {
      this.prefixCache.startWatcher(key as ResolvedKey, port);
    }

    handle.state = "loaded";
    return handle;
  }

  private async waitHealthy(port: number, timeoutMs: number, id: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return;
      } catch {
        /* keep polling */
      }
      this.loadProgress.set(id, Math.min(0.95, (Date.now() - (deadline - timeoutMs)) / timeoutMs));
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`health check timed out after ${timeoutMs}ms`);
  }

  private async evictIfNeeded(incomingId: string): Promise<void> {
    const cfg = this.config.get();
    const loadedResidents = [...this.residents.values()].filter((h) => h.state === "loaded" && h.id !== incomingId);
    if (loadedResidents.length < cfg.global.max_resident) return;
    loadedResidents.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const toEvict = loadedResidents.slice(0, loadedResidents.length - cfg.global.max_resident + 1);
    for (const h of toEvict) {
      await this.unload(h.key).catch((e) => this.stats.logError(h.key.model, h.key.profile, "proxy_error", `eviction unload failed: ${e}`));
    }
  }

  async unload(key: ModelKey): Promise<void> {
    const id = keyToId(key);
    const handle = this.residents.get(id);
    if (!handle) return;
    handle.state = "unloading";
    this.prefixCache.stopWatcher(id);

    await this.cache.save(key, handle.port).catch((e) => {
      this.stats.logError(key.model, key.profile, "cache_save_failed", String(e));
    });

    const cfg = this.config.get();
    const exited = new Promise<void>((resolve) => handle.proc.once("exit", () => resolve()));
    try {
      handle.proc.kill();
    } catch {
      /* already dead */
    }
    const timedOut = await Promise.race([exited.then(() => false), sleep(cfg.global.load_drain_timeout_ms).then(() => true)]);
    if (timedOut) {
      forceKill(handle.pid);
      await exited;
    }
    this.residents.delete(id);
  }

  private allocatePort(): number {
    const [lo, hi] = this.config.get().global.port_range;
    for (let p = lo; p <= hi; p++) {
      if (!this.usedPorts.has(p)) return p;
    }
    throw new Error(`No free port in range ${lo}-${hi}`);
  }

  async shutdownAll(): Promise<void> {
    const keys = [...this.residents.values()].map((h) => h.key);
    for (const k of keys) await this.unload(k);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function tailLogSync(logPath: string, n: number): string[] {
  try {
    const lines = readFileSync(logPath, "utf-8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

function forceKill(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
}
