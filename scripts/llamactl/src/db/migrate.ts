import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import * as path from "node:path";

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);
  // columns added after the first release: CREATE TABLE IF NOT EXISTS skips existing tables
  const have = new Set((db.pragma("table_info(requests)") as Array<{ name: string }>).map((c) => c.name));
  for (const [col, type] of [
    ["cache_tokens", "INTEGER"],
    ["draft_tokens", "INTEGER"],
    ["draft_accepted", "INTEGER"],
    ["prompt_ms", "REAL"],
    ["predicted_ms", "REAL"],
  ]) {
    if (!have.has(col)) db.exec(`ALTER TABLE requests ADD COLUMN ${col} ${type}`);
  }
  return db;
}
