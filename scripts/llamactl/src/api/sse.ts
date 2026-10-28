import { Router } from "express";
import type { Stats } from "../stats";

export function sseRouter(stats: Stats): Router {
  const router = Router();

  router.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const onEvent = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    stats.on("event", onEvent);

    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(ping);
      stats.off("event", onEvent);
    });
  });

  return router;
}
