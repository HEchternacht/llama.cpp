import type { Request, Response } from "express";
import * as http from "node:http";
import type { ConfigStore } from "./config";
import type { ProcessManager } from "./process-manager";
import type { Stats } from "./stats";
import { idToKey } from "./types";

interface Timings {
  prompt_n?: number;
  predicted_n?: number;
  prompt_per_second?: number;
  predicted_per_second?: number;
  cache_n?: number;
  draft_n?: number;
  draft_n_accepted?: number;
  prompt_ms?: number;
  predicted_ms?: number;
}

function extraFields(t: Timings | undefined) {
  return {
    cacheTokens: t?.cache_n,
    draftTokens: t?.draft_n,
    draftAccepted: t?.draft_n_accepted,
    promptMs: t?.prompt_ms,
    predictedMs: t?.predicted_ms,
  };
}

export async function handleCompletion(req: Request, res: Response, pm: ProcessManager, stats: Stats, config: ConfigStore): Promise<void> {
  const body = req.body as { model?: string; profile?: string; stream?: boolean };
  if (!body?.model) {
    res.status(400).json({ error: "request body must include a \"model\" field" });
    return;
  }
  // "model" may be a bare model id or a "model:profile" composite; llamactl
  // always loads a profile, defaulting to the model's only one if unambiguous.
  const parsed = body.profile ? { model: body.model, profile: body.profile } : idToKey(body.model);
  let key;
  try {
    key = config.resolveLoadKey(parsed.model, parsed.profile);
  } catch (e) {
    res.status(400).json({ error: String(e) });
    return;
  }

  let handle;
  try {
    handle = await pm.load(key);
  } catch (e) {
    stats.logError(key.model, key.profile, "load_failed", String(e));
    res.status(503).json({ error: `failed to load model: ${e}` });
    return;
  }
  handle.lastUsedAt = Date.now();

  const startedAt = Date.now();
  const streamed = Boolean(body.stream);
  const forwardBody = JSON.stringify(req.body);

  const childReq = http.request(
    {
      host: "127.0.0.1",
      port: handle.port,
      path: req.path,
      method: req.method,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(forwardBody) },
    },
    (childRes) => {
      res.status(childRes.statusCode ?? 500);
      for (const [k, v] of Object.entries(childRes.headers)) {
        if (v !== undefined) res.setHeader(k, v as string | string[]);
      }

      if (!streamed) {
        const chunks: Buffer[] = [];
        childRes.on("data", (c: Buffer) => chunks.push(c));
        childRes.on("end", () => {
          const buf = Buffer.concat(chunks);
          res.end(buf);
          recordFromJson(buf, key, handle!.sessionRowId, startedAt, childRes.statusCode ?? 0, false, stats);
        });
      } else {
        let lastTimings: Timings | undefined;
        let predictedCount = 0;
        // an SSE line can be split across TCP chunks; only parse complete lines
        let pending = "";
        childRes.on("data", (chunk: Buffer) => {
          res.write(chunk);
          const text = pending + chunk.toString("utf-8");
          const cut = text.lastIndexOf("\n");
          pending = text.slice(cut + 1);
          if (cut < 0) return;
          const lines = text.slice(0, cut);
          const timings = extractTimingsFromSseChunk(lines);
          if (timings) lastTimings = timings;
          predictedCount += countDeltas(lines);
        });
        childRes.on("end", () => {
          res.end();
          const durationMs = Date.now() - startedAt;
          stats.recordRequest({
            sessionId: handle!.sessionRowId,
            modelId: key.model,
            profileId: key.profile,
            startedAt,
            durationMs,
            predictedTokens: lastTimings?.predicted_n ?? predictedCount,
            promptTokens: lastTimings?.prompt_n,
            promptPerSecond: lastTimings?.prompt_per_second,
            predictedPerSecond: lastTimings?.predicted_per_second ?? (predictedCount > 0 ? (predictedCount / durationMs) * 1000 : undefined),
            ...extraFields(lastTimings),
            timingsSource: lastTimings ? "server" : "estimated",
            httpStatus: childRes.statusCode ?? 0,
            streamed: true,
          });
        });
      }
    },
  );

  childReq.on("error", (e) => {
    stats.logError(key.model, key.profile, "proxy_error", String(e));
    if (!res.headersSent) res.status(502).json({ error: `proxy error: ${e}` });
    else res.end();
  });

  childReq.end(forwardBody);
}

function recordFromJson(buf: Buffer, key: { model: string; profile?: string }, sessionId: number, startedAt: number, httpStatus: number, streamed: boolean, stats: Stats): void {
  let timings: Timings | undefined;
  try {
    const parsed = JSON.parse(buf.toString("utf-8")) as { timings?: Timings };
    timings = parsed.timings;
  } catch {
    /* non-JSON or error body */
  }
  stats.recordRequest({
    sessionId,
    modelId: key.model,
    profileId: key.profile,
    startedAt,
    durationMs: Date.now() - startedAt,
    promptTokens: timings?.prompt_n,
    predictedTokens: timings?.predicted_n,
    promptPerSecond: timings?.prompt_per_second,
    predictedPerSecond: timings?.predicted_per_second,
    ...extraFields(timings),
    timingsSource: timings ? "server" : "estimated",
    httpStatus,
    streamed,
  });
}

function extractTimingsFromSseChunk(text: string): Timings | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as { timings?: Timings };
      if (obj.timings) return obj.timings;
    } catch {
      /* partial/incomplete JSON line, ignore */
    }
  }
  return undefined;
}

function countDeltas(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]" || !payload) continue;
    try {
      const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
      if (obj.choices?.[0]?.delta?.content !== undefined) count++;
    } catch {
      /* ignore */
    }
  }
  return count;
}
