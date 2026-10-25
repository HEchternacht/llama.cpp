import { Router } from "express";
import { createReadStream, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/** Reads the whole file (child logs are small-ish, rotated per run) and
 * returns the last `n` lines — simplest correct tail with no seek math. */
async function tailLines(filePath: string, n: number): Promise<string[]> {
  const out: string[] = [];
  const rl = readline.createInterface({ input: createReadStream(filePath, { encoding: "utf-8" }) });
  for await (const line of rl) {
    out.push(line);
    if (out.length > n) out.shift();
  }
  return out;
}

export function logsRouter(logDir: string): Router {
  const router = Router();

  router.get("/logs/:id/files", (req, res) => {
    const prefix = sanitize(req.params.id) + "-";
    let files: { name: string; mtime: number; size: number }[] = [];
    try {
      files = readdirSync(logDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".log"))
        .map((f) => {
          const st = statSync(path.join(logDir, f));
          return { name: f, mtime: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      /* no logs dir yet */
    }
    res.json({ data: files });
  });

  router.get("/logs/:id", async (req, res) => {
    const prefix = sanitize(req.params.id) + "-";
    const lines = Math.min(Number(req.query.lines) || 300, 5000);
    let files: string[] = [];
    try {
      files = readdirSync(logDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".log"))
        .sort();
    } catch {
      /* no logs dir yet */
    }
    if (files.length === 0) {
      res.json({ file: null, lines: [] });
      return;
    }
    const requested = typeof req.query.file === "string" ? req.query.file : undefined;
    const file = requested && files.includes(requested) ? requested : files[files.length - 1];
    try {
      const tail = await tailLines(path.join(logDir, file), lines);
      res.json({ file, lines: tail });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
