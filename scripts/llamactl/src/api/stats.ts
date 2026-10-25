import { Router } from "express";
import type { MetricsPoller } from "../metrics-poller";
import type { Stats } from "../stats";

export function statsRouter(stats: Stats, poller: MetricsPoller): Router {
  const router = Router();

  router.get("/stats/live", (req, res) => {
    res.json(stats.liveSnapshot(req.query.model as string | undefined));
  });

  // realtime pp/tg rates of the loaded models (from the 1 s /slots poll)
  router.get("/stats/realtime", (_req, res) => {
    res.json({ data: poller.live() });
  });

  router.get("/stats/history", (req, res) => {
    const bucket = req.query.bucket === "day" ? "day" : "hour";
    res.json({
      data: stats.history({
        model: req.query.model as string | undefined,
        profile: req.query.profile as string | undefined,
        from: req.query.from ? Number(req.query.from) : undefined,
        to: req.query.to ? Number(req.query.to) : undefined,
        bucket,
      }),
    });
  });

  router.get("/stats/breakdown", (_req, res) => {
    res.json({ data: stats.modelBreakdown() });
  });

  router.get("/errors", (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    res.json({ data: stats.recentErrors(limit, req.query.model as string | undefined) });
  });

  return router;
}
