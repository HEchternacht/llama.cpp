import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ConfigStore } from "./config";
import type { ResolvedKey } from "./types";

const POLL_MS = 3000;
const MIN_CANDIDATE_TOKENS = 512;
// never cache past the first user turn
const USER_TURN_MARKERS = ["<|im_start|>user", "<|user|>", "<|User|>", "[INST]", "<start_of_turn>user", "<|start_header_id|>user"];

interface PrefixMeta {
  last_prompt_tokens?: number[];
  prefix_tokens?: number[];
}

/** Ports llama_launcher.py's "prefix cache": a persistent, continuously
 * self-correcting cache of the longest static prompt prefix (system prompt +
 * tool schemas) seen across requests — unlike cache-manager.ts's swap cache
 * (one full-state snapshot taken at unload, restored on the next load of the
 * *same* model), this saves prefill time on *every* big-agent-tool-context
 * request to a loaded model, by keeping slot 0 pre-loaded with whatever
 * prefix has proven stable across turns/sessions. Scoped to parallel=1
 * models for the same reason cache-manager.ts is (slot 0 is unambiguous). */
export class PrefixCacheManager {
  private watchers = new Map<string, NodeJS.Timeout>();

  constructor(private config: ConfigStore) {}

  private dir(): string {
    const dir = this.config.get().paths.cache_dir;
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private paths(key: ResolvedKey): { bin: string; meta: string; filename: string } {
    const filename = `${sanitize(key.model)}__${sanitize(key.profile)}__prefix.bin`;
    const dir = this.dir();
    return { bin: path.join(dir, filename), meta: path.join(dir, filename.replace(/\.bin$/, ".meta.json")), filename };
  }

  /** Restores the saved prefix into slot 0, if one exists. Returns whether
   * anything was restored (so the caller can skip a prefix-restore when a
   * fuller swap-cache snapshot already covers it). */
  async restore(key: ResolvedKey, port: number): Promise<boolean> {
    const { bin, filename } = this.paths(key);
    if (!existsSync(bin)) return false;
    const res = await fetch(`http://127.0.0.1:${port}/slots/0?action=restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename }),
    });
    if (!res.ok) throw new Error(`prefix restore failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    return true;
  }

  /** Starts (or restarts) the background watcher that rebuilds the saved
   * prefix as the live session's prompts reveal a stable common prefix. */
  startWatcher(key: ResolvedKey, port: number): void {
    const id = `${key.model}:${key.profile}`;
    this.stopWatcher(id);
    const { bin, meta: metaPath, filename } = this.paths(key);

    let meta: PrefixMeta = {};
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      } catch {
        meta = {};
      }
    }
    let lastPromptTokens = meta.last_prompt_tokens ?? [];
    let prefixTokens = existsSync(bin) ? meta.prefix_tokens ?? [] : [];
    let seenPrompt: string | undefined;
    let building = false;

    const http = async (p: string, payload?: unknown, timeoutMs = 120_000): Promise<unknown> => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(`http://127.0.0.1:${port}${p}`, {
          method: payload !== undefined ? "POST" : "GET",
          headers: payload !== undefined ? { "content-type": "application/json" } : undefined,
          body: payload !== undefined ? JSON.stringify(payload) : undefined,
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(t);
      }
    };

    const tick = async (): Promise<void> => {
      if (building) return;
      let slots: { id_task?: number; is_processing?: boolean; prompt?: string }[];
      try {
        slots = (await http("/slots")) as typeof slots;
      } catch {
        return;
      }
      const s = slots?.[0];
      if (!s || s.id_task === undefined || s.id_task === -1 || s.is_processing || !s.prompt) return;
      if (s.prompt === seenPrompt) return;
      seenPrompt = s.prompt;

      let newTokens: number[];
      try {
        newTokens = ((await http("/tokenize", { content: seenPrompt })) as { tokens: number[] }).tokens;
      } catch {
        return;
      }

      if (newTokens.length > lastPromptTokens.length) {
        lastPromptTokens = newTokens;
        meta.last_prompt_tokens = lastPromptTokens;
        try {
          writeFileSync(metaPath, JSON.stringify(meta));
        } catch {
          /* best effort */
        }
      }

      let cand = newTokens.slice(0, lcp(newTokens, lastPromptTokens));

      const pos = Math.min(
        ...USER_TURN_MARKERS.map((m) => seenPrompt!.indexOf(m)).filter((p) => p !== -1),
        Infinity,
      );
      if (pos > 0 && pos !== Infinity) {
        try {
          const head = ((await http("/tokenize", { content: seenPrompt.slice(0, pos) })) as { tokens: number[] }).tokens;
          cand = cand.slice(0, lcp(newTokens, head));
        } catch {
          /* keep cand as-is */
        }
      }

      const valid = prefixTokens.length > 0 && arraysEqual(newTokens.slice(0, prefixTokens.length), prefixTokens);
      const stale = prefixTokens.length > 0 && !valid && newTokens.length * 4 >= prefixTokens.length * 3;

      if ((prefixTokens.length === 0 || stale) && cand.length >= MIN_CANDIDATE_TOKENS) {
        building = true;
        try {
          await http("/completion", { prompt: cand, n_predict: 0, cache_prompt: true }, 600_000);
          await http("/slots/0?action=save", { filename });
          prefixTokens = cand;
          meta.prefix_tokens = cand;
          writeFileSync(metaPath, JSON.stringify(meta));
        } catch {
          /* try again next tick */
        } finally {
          building = false;
        }
      }
    };

    this.watchers.set(id, setInterval(() => void tick(), POLL_MS));
  }

  stopWatcher(id: string): void {
    const t = this.watchers.get(id);
    if (t) {
      clearInterval(t);
      this.watchers.delete(id);
    }
  }
}

function lcp(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function arraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
