import express from "express";
import * as path from "node:path";
import { mkdirSync } from "node:fs";
import { ConfigStore, resolveHome } from "./config";
import { openDb } from "./db/migrate";
import { CacheManager } from "./cache-manager";
import { PrefixCacheManager } from "./prefix-cache";
import { Stats } from "./stats";
import { ProcessManager } from "./process-manager";
import { MetricsPoller } from "./metrics-poller";
import { handleCompletion } from "./proxy";
import { modelsRouter } from "./api/models";
import { profilesRouter } from "./api/profiles";
import { configRouter } from "./api/config";
import { statsRouter } from "./api/stats";
import { sseRouter } from "./api/sse";
import { legacyRouter } from "./api/legacy";
import { logsRouter } from "./api/logs";

const PORT = 8080;

async function main(): Promise<void> {
  const home = resolveHome();
  mkdirSync(path.join(home, "data", "cache"), { recursive: true });
  mkdirSync(path.join(home, "logs", "children"), { recursive: true });

  const config = new ConfigStore(path.join(home, "config", "llamactl.toml"));
  const discovered = config.discoverModels();
  if (discovered.length) console.log(`auto-discovered models: ${discovered.join(", ")}`);
  const db = openDb(path.join(home, "data", "llamactl.sqlite3"));
  const stats = new Stats(db);
  const cache = new CacheManager(db, config);
  const prefixCache = new PrefixCacheManager(config);
  const pm = new ProcessManager(config, cache, prefixCache, stats, home);
  const metricsPoller = new MetricsPoller(pm, stats);
  metricsPoller.start();

  const app = express();
  app.use(express.json({ limit: "32mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    if (req.path === "/health" || req.path.startsWith("/ui")) return next();
    const key = config.get().global.api_key;
    // EventSource can't set custom headers, so /v1/events also accepts ?token=.
    if (req.path === "/v1/events" && req.query.token === key) return next();
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${key}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  app.use("/v1", modelsRouter(pm, stats, config, cache));
  app.use("/v1", profilesRouter(config));
  app.use("/v1", configRouter(config, pm));
  app.use("/v1", statsRouter(stats, metricsPoller));
  app.use("/v1", sseRouter(stats));
  app.use("/v1", logsRouter(path.join(home, "logs", "children")));
  app.post("/v1/chat/completions", (req, res) => void handleCompletion(req, res, pm, stats, config));
  app.post("/v1/completions", (req, res) => void handleCompletion(req, res, pm, stats, config));

  app.use(legacyRouter(pm, stats, config));

  app.use("/ui", express.static(path.join(home, "web")));
  app.get("/", (_req, res) => res.redirect("/ui/"));

  const server = app.listen(PORT, () => {
    console.log(`llamactl listening on http://127.0.0.1:${PORT}`);
  });

  for (const [profileId, p] of Object.entries(config.get().profiles)) {
    if (p.load_on_startup) {
      pm.load({ model: p.model, profile: profileId }).catch((e) => console.error(`startup load of "${profileId}" failed:`, e));
    }
  }

  const shutdown = async () => {
    console.log("shutting down, saving caches...");
    metricsPoller.stop();
    await pm.shutdownAll();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
