import type Database from "better-sqlite3";
import { EventEmitter } from "node:events";

export type ErrorCategory =
  | "load_failed"
  | "health_timeout"
  | "proxy_error"
  | "cache_save_failed"
  | "cache_restore_failed"
  | "prefix_cache_restore_failed"
  | "crashed";

export interface RequestStat {
  sessionId: number | null;
  modelId: string;
  profileId?: string;
  startedAt: number;
  durationMs: number;
  promptTokens?: number;
  predictedTokens?: number;
  promptPerSecond?: number;
  predictedPerSecond?: number;
  /** Prompt tokens reused from the slot's KV cache (not reprocessed). */
  cacheTokens?: number;
  draftTokens?: number;
  draftAccepted?: number;
  promptMs?: number;
  predictedMs?: number;
  timingsSource: "server" | "estimated";
  httpStatus: number;
  streamed: boolean;
}

/** Central event bus + SQLite writer for stats/errors, also feeds the SSE stream. */
export class Stats extends EventEmitter {
  constructor(private db: Database.Database) {
    super();
  }

  startSession(modelId: string, profileId: string | undefined, port: number): number {
    const row = this.db
      .prepare("INSERT INTO sessions (model_id, profile_id, port, started_at) VALUES (?, ?, ?, ?)")
      .run(modelId, profileId ?? null, port, Date.now());
    const id = Number(row.lastInsertRowid);
    this.emit("event", { type: "session_started", modelId, profileId, sessionId: id });
    return id;
  }

  endSession(sessionId: number, endReason: string): void {
    this.db.prepare("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?").run(Date.now(), endReason, sessionId);
    this.emit("event", { type: "session_ended", sessionId, endReason });
  }

  recordRequest(r: RequestStat): void {
    this.db
      .prepare(
        `INSERT INTO requests (session_id, model_id, profile_id, started_at, duration_ms, prompt_tokens,
          predicted_tokens, prompt_per_second, predicted_per_second, timings_source, http_status, streamed,
          cache_tokens, draft_tokens, draft_accepted, prompt_ms, predicted_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.sessionId,
        r.modelId,
        r.profileId ?? null,
        r.startedAt,
        r.durationMs,
        r.promptTokens ?? null,
        r.predictedTokens ?? null,
        r.promptPerSecond ?? null,
        r.predictedPerSecond ?? null,
        r.timingsSource,
        r.httpStatus,
        r.streamed ? 1 : 0,
        r.cacheTokens ?? null,
        r.draftTokens ?? null,
        r.draftAccepted ?? null,
        r.promptMs ?? null,
        r.predictedMs ?? null,
      );
    this.emit("event", { type: "request", ...r });
  }

  recordMetricsSnapshot(s: {
    modelId?: string;
    profileId?: string;
    slotsBusy?: number;
    slotsTotal?: number;
    kvCacheUsedPct?: number;
    gpuMemUsedMb?: number;
    gpuMemTotalMb?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO metrics_snapshots (taken_at, model_id, profile_id, slots_busy, slots_total,
          kv_cache_used_pct, gpu_mem_used_mb, gpu_mem_total_mb) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        s.modelId ?? null,
        s.profileId ?? null,
        s.slotsBusy ?? null,
        s.slotsTotal ?? null,
        s.kvCacheUsedPct ?? null,
        s.gpuMemUsedMb ?? null,
        s.gpuMemTotalMb ?? null,
      );
    this.emit("event", { type: "metrics", ...s });
  }

  logError(modelId: string | undefined, profileId: string | undefined, category: ErrorCategory, message: string, detail?: unknown): void {
    this.db
      .prepare("INSERT INTO errors (occurred_at, model_id, profile_id, category, message, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(Date.now(), modelId ?? null, profileId ?? null, category, message, detail ? JSON.stringify(detail) : null);
    this.emit("event", { type: "error", modelId, profileId, category, message });
  }

  recentErrors(limit = 100, modelId?: string): unknown[] {
    if (modelId) {
      return this.db
        .prepare("SELECT * FROM errors WHERE model_id = ? ORDER BY occurred_at DESC LIMIT ?")
        .all(modelId, limit);
    }
    return this.db.prepare("SELECT * FROM errors ORDER BY occurred_at DESC LIMIT ?").all(limit);
  }

  liveSnapshot(modelId?: string): unknown {
    const where = modelId ? "WHERE model_id = ?" : "";
    const args = modelId ? [modelId] : [];
    const recent = this.db
      .prepare(`SELECT * FROM requests ${where} ORDER BY started_at DESC LIMIT 20`)
      .all(...args);
    const lastMetrics = this.db.prepare("SELECT * FROM metrics_snapshots ORDER BY taken_at DESC LIMIT 1").get();
    return { recentRequests: recent, lastMetrics };
  }

  history(opts: { model?: string; profile?: string; from?: number; to?: number; bucket: "hour" | "day" }): unknown[] {
    const bucketExpr = opts.bucket === "hour" ? "strftime('%Y-%m-%dT%H:00:00', started_at/1000, 'unixepoch')" : "strftime('%Y-%m-%d', started_at/1000, 'unixepoch')";
    const conditions: string[] = [];
    const args: unknown[] = [];
    if (opts.model) {
      conditions.push("model_id = ?");
      args.push(opts.model);
    }
    if (opts.profile) {
      conditions.push("profile_id = ?");
      args.push(opts.profile);
    }
    if (opts.from) {
      conditions.push("started_at >= ?");
      args.push(opts.from);
    }
    if (opts.to) {
      conditions.push("started_at <= ?");
      args.push(opts.to);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT ${bucketExpr} AS bucket, model_id, profile_id,
        COUNT(*) AS request_count,
        AVG(prompt_per_second) AS avg_pp_s,
        AVG(predicted_per_second) AS avg_tg_s,
        SUM(CASE WHEN http_status >= 400 THEN 1 ELSE 0 END) AS error_count,
        MAX(started_at) AS last_used_at
      FROM requests
      ${where}
      GROUP BY bucket, model_id, profile_id
      ORDER BY bucket ASC`;
    return this.db.prepare(sql).all(...args);
  }

  modelBreakdown(): unknown[] {
    return this.db
      .prepare(
        `SELECT model_id, profile_id,
          COUNT(*) AS request_count,
          AVG(prompt_per_second) AS avg_pp_s,
          AVG(predicted_per_second) AS avg_tg_s,
          SUM(prompt_tokens) AS prompt_tokens,
          SUM(cache_tokens) AS cache_tokens,
          SUM(predicted_tokens) AS predicted_tokens,
          SUM(draft_tokens) AS draft_tokens,
          SUM(draft_accepted) AS draft_accepted,
          MAX(started_at) AS last_used_at
         FROM requests
         GROUP BY model_id, profile_id`,
      )
      .all();
  }
}
