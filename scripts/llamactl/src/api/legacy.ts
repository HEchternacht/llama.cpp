import { Router } from "express";
import type { ConfigStore } from "../config";
import type { ProcessManager } from "../process-manager";
import type { Stats } from "../stats";
import { handleCompletion } from "../proxy";
import { keyToId } from "../types";

/** Unprefixed aliases of the /v1/* control API, kept only for the migration
 * window so kanban/server.js (which calls /models, /models/load,
 * /models/unload directly) keeps working untouched. Remove once kanban is
 * repointed at /v1/* (see plan's "flagged, out of scope" section). */
export function legacyRouter(pm: ProcessManager, stats: Stats, config: ConfigStore): Router {
  const router = Router();

  router.get("/models", (_req, res) => {
    res.json({ data: pm.list() });
  });

  router.post("/models/load", async (req, res) => {
    const { model, profile } = req.body as { model?: string; profile?: string };
    if (!model) {
      res.status(400).json({ error: "\"model\" is required" });
      return;
    }
    try {
      const key = config.resolveLoadKey(model, profile);
      const handle = await pm.load(key);
      res.json({ id: keyToId(key), status: { value: handle.state } });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/models/unload", async (req, res) => {
    const { model, profile } = req.body as { model?: string; profile?: string };
    if (!model) {
      res.status(400).json({ error: "\"model\" is required" });
      return;
    }
    const key = config.resolveLoadKey(model, profile);
    await pm.unload(key);
    res.json({ ok: true });
  });

  router.post("/chat/completions", (req, res) => void handleCompletion(req, res, pm, stats, config));
  router.post("/completions", (req, res) => void handleCompletion(req, res, pm, stats, config));

  return router;
}
