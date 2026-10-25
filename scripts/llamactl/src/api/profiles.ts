import { Router } from "express";
import type { ConfigStore } from "../config";

export function profilesRouter(config: ConfigStore): Router {
  const router = Router();

  router.get("/profiles", (_req, res) => {
    res.json({ data: config.get().profiles });
  });

  router.get("/profiles/:id", (req, res) => {
    const p = config.get().profiles[req.params.id];
    if (!p) {
      res.status(404).json({ error: "unknown profile" });
      return;
    }
    res.json(p);
  });

  router.post("/profiles", (req, res) => {
    const { id, model, args, env, load_on_startup, prefix_cache_restore, prefix_cache_rebuild } = req.body as {
      id?: string;
      model?: string;
      args?: string[];
      env?: Record<string, string>;
      load_on_startup?: boolean;
      prefix_cache_restore?: boolean;
      prefix_cache_rebuild?: boolean;
    };
    if (!id || !model) {
      res.status(400).json({ error: "\"id\" and \"model\" are required" });
      return;
    }
    try {
      config.patch("profiles", id, { model, args: args ?? [], env, load_on_startup, prefix_cache_restore, prefix_cache_rebuild });
      res.status(201).json(config.get().profiles[id]);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.patch("/profiles/:id", (req, res) => {
    try {
      config.patch("profiles", req.params.id, req.body);
      res.json(config.get().profiles[req.params.id]);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.delete("/profiles/:id", (req, res) => {
    config.deleteProfile(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
