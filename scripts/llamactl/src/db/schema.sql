CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  model_id TEXT NOT NULL,
  profile_id TEXT,
  pid INTEGER,
  port INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id),
  model_id TEXT NOT NULL,
  profile_id TEXT,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER,
  prompt_tokens INTEGER,
  predicted_tokens INTEGER,
  prompt_per_second REAL,
  predicted_per_second REAL,
  timings_source TEXT,
  http_status INTEGER,
  streamed INTEGER,
  cache_tokens INTEGER,
  draft_tokens INTEGER,
  draft_accepted INTEGER,
  prompt_ms REAL,
  predicted_ms REAL
);

CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id INTEGER PRIMARY KEY,
  taken_at INTEGER NOT NULL,
  model_id TEXT,
  profile_id TEXT,
  slots_busy INTEGER,
  slots_total INTEGER,
  kv_cache_used_pct REAL,
  gpu_mem_used_mb REAL,
  gpu_mem_total_mb REAL
);

CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  model_id TEXT,
  profile_id TEXT,
  category TEXT,
  message TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS cache_slots (
  id INTEGER PRIMARY KEY,
  model_id TEXT NOT NULL,
  profile_id TEXT,
  filename TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  n_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_requests_model_time ON requests(model_id, started_at);
CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics_snapshots(taken_at);
CREATE INDEX IF NOT EXISTS idx_errors_time ON errors(occurred_at);
CREATE INDEX IF NOT EXISTS idx_cache_slots_key ON cache_slots(model_id, profile_id, saved_at);
