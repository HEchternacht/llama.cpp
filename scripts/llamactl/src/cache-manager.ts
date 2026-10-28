import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import type { ConfigStore } from "./config";
import type { ModelKey } from "./types";

/** Cache save/restore is only meaningful for parallel=1 models, where slot 0
 * is unambiguous. For parallel>1 models (e.g. bonsai) this is a documented
 * known limitation — save/restore is skipped, not attempted against the
 * wrong slot. */
function isSingleSlot(args: string[]): boolean {
  const idx = args.indexOf("--parallel");
  if (idx === -1) return true;
  const val = args[idx + 1];
  return val === undefined || val === "1";
}

export class CacheManager {
  constructor(
    private db: Database.Database,
    private config: ConfigStore,
  ) {}

  /** Flat dir — must match the static --slot-save-path in global.args (same dir for every model;
   * filenames are already model-prefixed so there's no collision). */
  private dirFor(_modelId: string): string {
    const dir = this.config.get().paths.cache_dir;
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  lastSavedAt(modelId: string, profileId?: string): number | undefined {
    const row = this.db
      .prepare("SELECT saved_at FROM cache_slots WHERE model_id = ? AND profile_id IS ? ORDER BY saved_at DESC LIMIT 1")
      .get(modelId, profileId ?? null) as { saved_at: number } | undefined;
    return row?.saved_at;
  }

  async save(key: ModelKey, port: number): Promise<void> {
    const { args } = this.config.resolve(key.model, key.profile);
    if (!isSingleSlot(args)) return; // known limitation: parallel>1 not cached

    const filename = `${sanitize(key.model)}${key.profile ? "__" + sanitize(key.profile) : ""}__${Date.now()}.bin`;
    const res = await fetch(`http://127.0.0.1:${port}/slots/0?action=save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename }),
    });
    if (!res.ok) throw new Error(`slot save failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    const body = (await res.json().catch(() => ({}))) as { n_saved?: number };

    const dir = this.dirFor(key.model);
    writeFileSync(
      path.join(dir, filename.replace(/\.bin$/, ".meta.json")),
      JSON.stringify({ filename, savedAt: Date.now(), nTokens: body.n_saved ?? null }, null, 2),
    );

    this.db
      .prepare("INSERT INTO cache_slots (model_id, profile_id, filename, saved_at, n_tokens) VALUES (?, ?, ?, ?, ?)")
      .run(key.model, key.profile ?? null, filename, Date.now(), body.n_saved ?? null);

    this.evictExcess(key.model, key.profile);
  }

  /** Returns whether a swap-cache snapshot was actually restored, so the
   * caller can fall back to the prefix cache when there's none. */
  async restore(key: ModelKey, port: number): Promise<boolean> {
    const { args } = this.config.resolve(key.model, key.profile);
    if (!isSingleSlot(args)) return false;

    const row = this.db
      .prepare("SELECT filename FROM cache_slots WHERE model_id = ? AND profile_id IS ? ORDER BY saved_at DESC LIMIT 1")
      .get(key.model, key.profile ?? null) as { filename: string } | undefined;
    if (!row) return false;

    const binPath = path.join(this.dirFor(key.model), row.filename);
    if (!existsSync(binPath)) {
      this.db.prepare("DELETE FROM cache_slots WHERE model_id = ? AND profile_id IS ? AND filename = ?").run(key.model, key.profile ?? null, row.filename);
      return false;
    }

    const res = await fetch(`http://127.0.0.1:${port}/slots/0?action=restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: row.filename }),
    });
    if (!res.ok) {
      this.db.prepare("DELETE FROM cache_slots WHERE model_id = ? AND profile_id IS ? AND filename = ?").run(key.model, key.profile ?? null, row.filename);
      throw new Error(`slot restore failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    }
    return true;
  }

  /** Total bytes on disk for a model[:profile]'s saved cache slots (.bin + .meta.json). */
  sizeOf(modelId: string, profileId?: string): number {
    const rows = this.db
      .prepare("SELECT filename FROM cache_slots WHERE model_id = ? AND profile_id IS ?")
      .all(modelId, profileId ?? null) as { filename: string }[];
    const dir = this.dirFor(modelId);
    let bytes = 0;
    for (const r of rows) {
      for (const p of [path.join(dir, r.filename), path.join(dir, r.filename.replace(/\.bin$/, ".meta.json"))]) {
        try {
          bytes += statSync(p).size;
        } catch {
          /* file already gone */
        }
      }
    }
    return bytes;
  }

  /** Deletes every saved cache slot for a model[:profile], not just the LRU excess. */
  deleteAll(modelId: string, profileId?: string): void {
    const rows = this.db
      .prepare("SELECT id, filename FROM cache_slots WHERE model_id = ? AND profile_id IS ?")
      .all(modelId, profileId ?? null) as { id: number; filename: string }[];
    const dir = this.dirFor(modelId);
    for (const r of rows) {
      rmSync(path.join(dir, r.filename), { force: true });
      rmSync(path.join(dir, r.filename.replace(/\.bin$/, ".meta.json")), { force: true });
      this.db.prepare("DELETE FROM cache_slots WHERE id = ?").run(r.id);
    }
  }

  private evictExcess(modelId: string, profileId?: string): void {
    const cap = this.config.maxCacheSlots(modelId);
    const rows = this.db
      .prepare("SELECT id, filename FROM cache_slots WHERE model_id = ? AND profile_id IS ? ORDER BY saved_at DESC")
      .all(modelId, profileId ?? null) as { id: number; filename: string }[];
    if (rows.length <= cap) return;
    const excess = rows.slice(cap);
    const dir = this.dirFor(modelId);
    for (const r of excess) {
      rmSync(path.join(dir, r.filename), { force: true });
      rmSync(path.join(dir, r.filename.replace(/\.bin$/, ".meta.json")), { force: true });
      this.db.prepare("DELETE FROM cache_slots WHERE id = ?").run(r.id);
    }
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
