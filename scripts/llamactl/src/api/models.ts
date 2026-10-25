import { Router } from "express";
import type { CacheManager } from "../cache-manager";
import type { ConfigStore } from "../config";
import type { ProcessManager } from "../process-manager";
import type { Stats } from "../stats";
import { idToKey, keyToId, type ResolvedKey } from "../types";

/** llamactl always loads/unloads a *profile* of a model, never a bare model.
 * Accepts {model, profile?} or {profile} alone (profile implies its model). */
function resolveBody(config: ConfigStore, body: { model?: string; profile?: string }): ResolvedKey {
  if (body.profile && !body.model) {
    const p = config.get().profiles[body.profile];
    if (!p) throw new Error(`Unknown profile "${body.profile}"`);
    return { model: p.model, profile: body.profile };
  }
  if (!body.model) throw new Error("\"model\" or \"profile\" is required");
  return config.resolveLoadKey(body.model, body.profile);
}

export function modelsRouter(pm: ProcessManager, stats: Stats, config: ConfigStore, cache: CacheManager): Router {
  const router = Router();

  router.get("/models", (_req, res) => {
    res.json({ data: pm.list() });
  });

  router.get("/models/:id/live", async (req, res) => {
    const id = req.params.id;
    const resident = pm.getResident(id);
    if (!resident || resident.state !== "loaded") {
      res.status(404).json({ error: "model not loaded" });
      return;
    }
    const key = idToKey(id);
    const m = config.get().models[key.model];
    let args: string[] = [];
    try {
      args = config.resolve(key.model, key.profile).args;
    } catch {
      /* best effort */
    }
    try {
      const [propsRes, slotsRes] = await Promise.all([
        fetch(`http://127.0.0.1:${resident.port}/props`),
        fetch(`http://127.0.0.1:${resident.port}/slots`),
      ]);
      const props = propsRes.ok ? ((await propsRes.json()) as Record<string, any>) : {};
      const slots = slotsRes.ok ? ((await slotsRes.json()) as Array<Record<string, any>>) : [];
      const nCtx: number | null = props.default_generation_settings?.n_ctx ?? null;
      const nPredict: number | null = props.default_generation_settings?.params?.n_predict ?? null;
      let contextUsed = 0;
      if (Array.isArray(slots)) {
        for (const s of slots) {
          contextUsed += (s.n_prompt_tokens ?? 0) + (s.next_token?.[0]?.n_decoded ?? 0);
        }
      }
      res.json({
        id,
        model: key.model,
        profile: key.profile,
        display_name: m?.display_name ?? key.model,
        model_path: m?.model_path,
        n_ctx: nCtx,
        n_predict: nPredict,
        context_used: contextUsed,
        total_slots: Array.isArray(slots) ? slots.length : null,
        args,
      });
    } catch (e) {
      res.status(502).json({ error: String(e) });
    }
  });

  router.get("/models/:id/status", (req, res) => {
    const entry = pm.list().find((e) => e.id === req.params.id);
    if (!entry) {
      res.status(404).json({ error: "unknown model/profile id" });
      return;
    }
    res.json(entry);
  });

  router.post("/models/load", async (req, res) => {
    let key: { model: string; profile: string };
    try {
      key = resolveBody(config, req.body as { model?: string; profile?: string });
    } catch (e) {
      res.status(400).json({ error: String(e) });
      return;
    }
    try {
      const handle = await pm.load(key);
      res.json({ id: keyToId(key), status: { value: handle.state }, pid: handle.pid, port: handle.port });
    } catch (e) {
      stats.logError(key.model, key.profile, "load_failed", String(e));
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/models/unload", async (req, res) => {
    let key: { model: string; profile: string };
    try {
      key = resolveBody(config, req.body as { model?: string; profile?: string });
    } catch (e) {
      res.status(400).json({ error: String(e) });
      return;
    }
    try {
      await pm.unload(key);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.delete("/models/:id", async (req, res) => {
    const id = req.params.id;
    if (!config.get().models[id]) {
      res.status(404).json({ error: "unknown model" });
      return;
    }
    if (pm.list().some((e) => e.model === id && e.status.value !== "unloaded")) {
      res.status(409).json({ error: "model (or one of its profiles) is loaded — unload it first" });
      return;
    }
    config.deleteModel(id);
    res.json({ ok: true });
  });

  router.delete("/models/:id/cache", (req, res) => {
    const key = idToKey(req.params.id);
    if (!config.get().models[key.model]) {
      res.status(404).json({ error: "unknown model/profile id" });
      return;
    }
    cache.deleteAll(key.model, key.profile);
    res.json({ ok: true });
  });

  return router;
}
