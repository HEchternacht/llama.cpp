import { Router } from "express";
import type { ConfigStore } from "../config";
import { ENV_CATALOG } from "../env-catalog";
import type { ProcessManager } from "../process-manager";

export function configRouter(config: ConfigStore, pm: ProcessManager): Router {
  const router = Router();

  router.get("/config/env-catalog", (_req, res) => {
    res.json({ data: ENV_CATALOG });
  });

  router.get("/config/global", (_req, res) => {
    const g = { ...config.get().global };
    res.json(redactApiKey(g));
  });

  router.patch("/config/global", (req, res) => {
    try {
      config.patch("global", req.body);
      res.json(redactApiKey({ ...config.get().global }));
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.get("/config/paths", (_req, res) => {
    res.json(config.get().paths);
  });

  router.patch("/config/paths", (req, res) => {
    try {
      config.patch("paths", req.body);
      res.json(config.get().paths);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.post("/config/discover-models", (_req, res) => {
    try {
      const added = config.discoverModels();
      res.json({ added });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.get("/config/startup", (_req, res) => {
    res.json({ profile: config.startupProfile() });
  });

  router.patch("/config/startup", (req, res) => {
    const { profile } = req.body as { profile?: string | null };
    try {
      config.setStartupProfile(profile ?? null);
      res.json({ profile: config.startupProfile() });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.get("/config/models/:id", (req, res) => {
    const m = config.get().models[req.params.id];
    if (!m) {
      res.status(404).json({ error: "unknown model" });
      return;
    }
    res.json(m);
  });

  router.patch("/config/models/:id", (req, res) => {
    try {
      config.patch("models", req.params.id, req.body);
      const loaded = pm.list().some((e) => e.model === req.params.id && e.status.value === "loaded");
      res.json({ applied: true, requiresRestart: loaded, model: config.get().models[req.params.id] });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  return router;
}

function redactApiKey<T extends { api_key?: string }>(obj: T): T {
  if (obj.api_key) obj.api_key = "********";
  return obj;
}
